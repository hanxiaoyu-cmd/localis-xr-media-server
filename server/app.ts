import { createReadStream } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getLanAddresses, saveMediaDirs } from './config';
import { PairingAuth } from './auth';
import { FolderPickerBusyError, FolderPickerUnsupportedError, isLoopbackAddress, pickLocalDirectory } from './folder-picker';
import { MediaDirectoryValidationError, MediaLibrary } from './media-library';
import { ProgressStore } from './progress-store';
import { parseByteRange, RangeNotSatisfiableError } from './range';
import { getSubtitleVtt } from './subtitles';
import { SourceChangedError, TranscodeCapacityError, TranscodeManager, type TranscodeJob } from './transcode-manager';
import { parseServerSuperResolutionLevel, SERVER_SUPER_RESOLUTION_LEVELS, ServerSuperResolutionUnavailableError } from './super-resolution';
import { CloudSourceError, CloudSourceManager } from './cloud-source-manager';
import { QuarkConnectorError, QuarkDesktopConnector } from './quark-desktop-connector';
import type { LocalisConfig } from './types';

export interface AppDependencies {
  config: LocalisConfig;
  library: MediaLibrary;
  auth: PairingAuth;
  progress: ProgressStore;
  transcodes: TranscodeManager;
  clouds?: CloudSourceManager;
  quark?: QuarkDesktopConnector;
  pickDirectory?: () => Promise<string | undefined>;
}

const mediaTypes: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.vob': 'video/mpeg', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2',
  '.mxf': 'application/mxf', '.ogv': 'video/ogg', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m3u8': 'application/vnd.apple.mpegurl',
  '.mka': 'audio/x-matroska', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.ac3': 'audio/ac3',
  '.eac3': 'audio/eac3', '.dts': 'audio/vnd.dts', '.mp2': 'audio/mpeg', '.amr': 'audio/amr',
  '.m4s': 'video/iso.segment', '.jpg': 'image/jpeg', '.vtt': 'text/vtt; charset=utf-8',
};

function mimeFor(filePath: string) {
  return mediaTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function pipeFile(res: Response, filePath: string, next: NextFunction) {
  const stream = createReadStream(filePath);
  stream.once('error', (error) => {
    if (res.headersSent) res.destroy(error);
    else next(error);
  });
  stream.pipe(res);
}

function safeHost(req: Request) {
  return req.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

async function sendFileWithRange(req: Request, res: Response, filePath: string, contentType: string) {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    const lastModified = fileStat.mtime.toUTCString();
    const etag = `"${fileStat.ino}-${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}"`;
    const ifRange = req.headers['if-range'];
    const requestedRange = ifRange && ifRange !== etag && ifRange !== lastModified ? undefined : req.headers.range;
    let range;
    try {
      range = parseByteRange(requestedRange, fileStat.size);
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) {
        res.status(416).set('Content-Range', `bytes */${fileStat.size}`).end();
        return;
      }
      throw error;
    }

    res.set({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Content-Type': contentType,
      'ETag': etag,
      'Last-Modified': lastModified,
      'X-Content-Type-Options': 'nosniff',
    });
    if (range) {
      res.status(206).set({
        'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
        'Content-Length': String(range.length),
      });
      if (req.method === 'HEAD') res.end();
      else {
        await pipeline(handle.createReadStream({ start: range.start, end: range.end, autoClose: false }), res);
      }
    } else {
      res.status(200).set('Content-Length', String(fileStat.size));
      if (req.method === 'HEAD') res.end();
      else {
        await pipeline(handle.createReadStream({ autoClose: false }), res);
      }
    }
  } finally {
    await handle.close();
  }
}

export function createApiApp(deps: AppDependencies) {
  const { config, library, auth, progress, transcodes, clouds, quark } = deps;
  const selectDirectory = deps.pickDirectory ?? (() => pickLocalDirectory(config.mediaDirs[0]));
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.set({
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    const host = safeHost(req);
    if (!config.allowedHosts.map((value) => value.toLowerCase()).includes(host)) {
      res.status(421).json({ error: 'unrecognized_host' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.headers.origin) {
        res.status(403).json({ error: 'origin_required' });
        return;
      }
      try {
        const expected = new URL(`${req.protocol}://${req.get('host')}`).origin;
        if (new URL(req.headers.origin).origin !== expected) {
          res.status(403).json({ error: 'origin_mismatch' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'invalid_origin' });
        return;
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'localis', mediaCount: library.items.size, encoder: transcodes.encoder });
  });
  app.get('/api/pair/status', (req, res) => {
    const isDesktop = isLoopbackAddress(req.socket.remoteAddress);
    res.json({
      paired: auth.isAuthenticated(req),
      pairingRequired: !config.authDisabled,
      pairingCode: isDesktop && !config.authDisabled ? config.pairingCode : undefined,
    });
  });
  app.post('/api/pair/verify', (req, res) => auth.verify(req, res));

  app.use('/api', auth.middleware);

  app.get('/api/server', (req, res) => {
    const protocol = req.secure ? 'https' : 'http';
    const lanAddresses = getLanAddresses();
    res.json({
      name: 'Localis',
      secure: req.secure,
      secureContextRequiredForWebXR: true,
      host: safeHost(req),
      port: config.port,
      encoder: transcodes.encoder,
      mediaCount: library.items.size,
      libraryCount: config.mediaDirs.length,
      pairingCode: isLoopbackAddress(req.socket.remoteAddress) && !config.authDisabled ? config.pairingCode : undefined,
      canPickLocalFolder: isLoopbackAddress(req.socket.remoteAddress),
      nativeFolderPicker: ['win32', 'darwin', 'linux'].includes(process.platform),
      canManageCloud: isLoopbackAddress(req.socket.remoteAddress),
      cloudSourceCount: clouds?.summaries().length ?? 0,
      lanUrls: req.secure
        ? config.publicHostname ? [`https://${config.publicHostname}:${config.port}`] : []
        : lanAddresses.map((address) => `${protocol}://${address}:${config.port}`),
      publicUrl: config.publicHostname ? `https://${config.publicHostname}:${config.port}` : undefined,
    });
  });

  app.get('/api/library', (_req, res) => {
    res.json({ items: library.list(), progress: progress.list() });
  });
  app.post('/api/library/refresh', async (_req, res, next) => {
    try {
      await library.scan();
      res.json({ items: library.list() });
    } catch (error) { next(error); }
  });
  app.post('/api/library/folders', async (req, res, next) => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return res.status(403).json({ error: 'local_management_required', message: '请在运行 Localis 的电脑上管理媒体文件夹。' });
      }
      const directory = await library.validateDirectory(String(req.body?.path || ''));
      await saveMediaDirs(config, [...config.mediaDirs, directory]);
      await library.scan();
      res.status(201).json({ mediaDirs: config.mediaDirs.map((entry) => path.basename(entry)), items: library.list() });
    } catch (error) { next(error); }
  });
  app.post('/api/library/folders/pick', async (req, res, next) => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return res.status(403).json({ error: 'local_picker_requires_desktop', message: '请在运行 Localis 的电脑上使用文件夹选择器。' });
      }
      const selected = await selectDirectory();
      if (!selected) return res.json({ cancelled: true });
      const directory = await library.validateDirectory(selected);
      await saveMediaDirs(config, [...config.mediaDirs, directory]);
      await library.scan();
      res.status(201).json({ cancelled: false, selected: directory, mediaDirs: config.mediaDirs.map((entry) => path.basename(entry)), items: library.list() });
    } catch (error) { next(error); }
  });

  const requireLocalCloudManagement = (req: Request, res: Response) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'local_management_required', message: '请在运行 Localis 的电脑上连接或管理云盘。' });
      return false;
    }
    if (!clouds) {
      res.status(503).json({ error: 'cloud_manager_unavailable', message: '云盘管理器尚未启动。' });
      return false;
    }
    return true;
  };

  app.use('/api/cloud', (req, res, next) => {
    if (!requireLocalCloudManagement(req, res)) return;
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/cloud/sources', (req, res) => {
    if (!requireLocalCloudManagement(req, res)) return;
    res.json({ sources: clouds!.summaries() });
  });
  app.get('/api/cloud/connectors', (req, res) => {
    if (!requireLocalCloudManagement(req, res)) return;
    const capabilities = clouds!.connectorCapabilities();
    res.json({ ...capabilities, quark: quark?.status() ?? capabilities.quark });
  });
  app.post('/api/cloud/webdav', async (req, res, next) => {
    try {
      if (!requireLocalCloudManagement(req, res)) return;
      const source = await clouds!.connectWebDav({
        provider: req.body?.provider,
        name: String(req.body?.name || ''),
        baseUrl: String(req.body?.baseUrl || ''),
        rootPath: String(req.body?.rootPath || ''),
        username: String(req.body?.username || ''),
        password: String(req.body?.password || ''),
      });
      await library.scan();
      res.status(201).json({ source, items: library.list() });
    } catch (error) { next(error); }
  });
  app.post('/api/cloud/baidu/device', async (req, res, next) => {
    try {
      if (!requireLocalCloudManagement(req, res)) return;
      res.status(201).json(await clouds!.startBaiduAuthorization({
        name: String(req.body?.name || ''),
      }));
    } catch (error) { next(error); }
  });
  app.put('/api/cloud/baidu/settings', async (req, res, next) => {
    try {
      await clouds!.configureBaiduConnector({
        appKey: req.body?.appKey,
        secretKey: req.body?.secretKey,
        appFolder: req.body?.appFolder,
      });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.delete('/api/cloud/baidu/settings', async (_req, res, next) => {
    try {
      await clouds!.removeBaiduConnector();
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.get('/api/cloud/baidu/device/:session', async (req, res, next) => {
    try {
      if (!requireLocalCloudManagement(req, res)) return;
      const result = await clouds!.pollBaiduAuthorization(String(req.params.session));
      if (result.state === 'authorized') await library.scan();
      res.json(result);
    } catch (error) { next(error); }
  });
  app.delete('/api/cloud/baidu/device/:session', (req, res, next) => {
    try {
      if (!requireLocalCloudManagement(req, res)) return;
      clouds!.cancelBaiduAuthorization(String(req.params.session));
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.post('/api/cloud/refresh', async (req, res, next) => {
    try {
      if (!requireLocalCloudManagement(req, res)) return;
      await library.refreshClouds();
      res.json({ sources: clouds!.summaries(), items: library.list() });
    } catch (error) { next(error); }
  });
  app.delete('/api/cloud/sources/:id', async (req, res, next) => {
    try {
      if (!requireLocalCloudManagement(req, res)) return;
      await clouds!.removeSource(String(req.params.id));
      await library.scan();
      res.status(204).end();
    } catch (error) { next(error); }
  });

  const requireQuark = () => {
    if (!quark) throw new QuarkConnectorError('quark_connector_unavailable', '夸克电脑端连接器尚未启动。', 503);
    return quark;
  };

  app.get('/api/cloud/quark/status', (_req, res, next) => {
    try { res.json(requireQuark().status()); } catch (error) { next(error); }
  });
  app.post('/api/cloud/quark/install', (_req, res, next) => {
    try { res.status(202).json(requireQuark().startInstall()); } catch (error) { next(error); }
  });
  app.post('/api/cloud/quark/login', (_req, res, next) => {
    try { res.status(202).json(requireQuark().startLogin()); } catch (error) { next(error); }
  });
  app.post('/api/cloud/quark/login/token', (req, res, next) => {
    try {
      if (typeof req.body?.token !== 'string') throw new QuarkConnectorError('invalid_quark_authorization_code', '请输入有效的夸克授权码。');
      res.status(202).json(requireQuark().startLogin(req.body.token));
    } catch (error) { next(error); }
  });
  app.post('/api/cloud/quark/search', async (req, res, next) => {
    try { res.json(await requireQuark().search(String(req.body?.keyword || ''))); } catch (error) { next(error); }
  });
  app.post('/api/cloud/quark/downloads', (req, res, next) => {
    try { res.status(202).json(requireQuark().startDownload(String(req.body?.resultId || ''))); } catch (error) { next(error); }
  });
  app.get('/api/cloud/quark/downloads/:id', (req, res, next) => {
    try { res.json(requireQuark().download(String(req.params.id))); } catch (error) { next(error); }
  });
  app.delete('/api/cloud/quark/downloads/:id', (req, res, next) => {
    try { res.json(requireQuark().cancelDownload(String(req.params.id))); } catch (error) { next(error); }
  });

  app.get('/api/media/:id', (req, res) => {
    const item = library.list().find((candidate) => candidate.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'media_not_found' });
    res.json({ item, progress: progress.get(item.id), transcode: transcodes.statusForItem(library.get(item.id)!) });
  });
  app.patch('/api/media/:id', async (req, res, next) => {
    try {
      const allowedProjection = new Set(['flat', 'equirect180', 'equirect360']);
      const allowedStereo = new Set(['mono', 'sbs', 'tb']);
      const allowedEyeOrder = new Set(['lr', 'rl']);
      const patch: Record<string, unknown> = {};
      if (allowedProjection.has(req.body?.projection)) patch.projection = req.body.projection;
      if (allowedStereo.has(req.body?.stereo)) patch.stereo = req.body.stereo;
      if (allowedEyeOrder.has(req.body?.eyeOrder)) patch.eyeOrder = req.body.eyeOrder;
      if (Number.isFinite(req.body?.yawOffset)) patch.yawOffset = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, Number(req.body.yawOffset)));
      if (typeof req.body?.title === 'string' && req.body.title.trim().length <= 200) patch.title = req.body.title.trim();
      const item = await library.update(req.params.id, patch);
      if (!item) return res.status(404).json({ error: 'media_not_found' });
      res.json({ item });
    } catch (error) { next(error); }
  });

  const streamHandler = async (req: Request, res: Response, next: (error?: unknown) => void) => {
    try {
      const item = library.get(String(req.params.id));
      if (!item) return res.status(404).json({ error: 'media_not_found' });
      res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`);
      if (item.sourceType === 'local') {
        await sendFileWithRange(req, res, item.path, mimeFor(item.path));
      } else {
        if (!clouds || !item.remoteFileId) throw new CloudSourceError('cloud_file_not_found', '云盘文件暂时不可用。', 404);
        if (req.method === 'HEAD') {
          res.status(200).set({
            'Accept-Ranges': 'bytes',
            'Content-Type': mimeFor(item.fileName),
            'Content-Length': String(item.size),
            'Last-Modified': item.modifiedAt,
            'Cache-Control': 'private, max-age=0, must-revalidate',
          }).end();
          return;
        }
        const upstream = await clouds.openFile(item.remoteFileId, {
          range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
          ifRange: typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
        });
        if (![200, 206, 416].includes(upstream.status)) {
          await upstream.body?.cancel();
          throw new CloudSourceError('cloud_stream_failed', `云盘读取返回 HTTP ${upstream.status}`, 502);
        }
        res.status(upstream.status);
        for (const header of ['accept-ranges', 'cache-control', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
          const value = upstream.headers.get(header);
          if (value) res.set(header, value);
        }
        if (!upstream.headers.get('content-type')) res.set('Content-Type', mimeFor(item.fileName));
        res.set('Cache-Control', 'private, max-age=0, must-revalidate');
        if (req.method === 'HEAD' || !upstream.body) {
          await upstream.body?.cancel();
          res.end();
        } else await pipeline(Readable.fromWeb(upstream.body as never), res);
      }
    } catch (error) {
      // Browsers routinely cancel speculative/range media requests while they
      // seek or switch sources. pipeline() still closes the source handle; no
      // second response can or should be written once headers were sent.
      if (res.headersSent || res.destroyed) return;
      next(error);
    }
  };
  app.get('/api/media/:id/stream', streamHandler);
  app.head('/api/media/:id/stream', streamHandler);

  app.get('/api/media/:id/poster', async (req, res, next) => {
    try {
      const item = library.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'media_not_found' });
      const poster = await library.ensurePoster(item);
      if (!poster) return res.status(404).json({ error: 'poster_not_available' });
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=0, must-revalidate' });
      pipeFile(res, poster, next);
    } catch (error) { next(error); }
  });

  app.get('/api/media/:id/subtitles/:track.vtt', async (req, res, next) => {
    try {
      const item = library.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'media_not_found' });
      const track = item.subtitleTracks.find((candidate) => candidate.index === Number(req.params.track));
      if (!track) return res.status(404).json({ error: 'subtitle_not_found' });
      res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=0, must-revalidate' });
      res.send(await getSubtitleVtt(config, item, track));
    } catch (error) { next(error); }
  });

  const requestedSuperResolution = (req: Request, res: Response) => {
    const raw = req.params.level;
    if (raw !== undefined && !SERVER_SUPER_RESOLUTION_LEVELS.has(raw as never)) {
      res.status(400).json({ error: 'invalid_super_resolution_level', message: '超分档位必须是 off、standard、high 或 ultra。' });
      return undefined;
    }
    return parseServerSuperResolutionLevel(raw);
  };
  const hlsStatus = (req: Request, res: Response) => {
    const item = library.get(String(req.params.id));
    if (!item) return res.status(404).json({ error: 'media_not_found' });
    const level = requestedSuperResolution(req, res);
    if (!level) return;
    res.json(transcodes.statusForItem(item, level));
  };
  const hlsAsset = async (req: Request, res: Response, next: NextFunction) => {
    try {
      let item = library.get(String(req.params.id));
      if (!item) return res.status(404).json({ error: 'media_not_found' });
      const level = requestedSuperResolution(req, res);
      if (!level) return;
      // Reject malformed asset names before creating an expensive FFmpeg job.
      // Express decodes route params, so this also covers encoded traversal forms.
      if (!/^(index\.m3u8|init\.mp4|seg_\d{6}\.(?:m4s|ts))$/.test(String(req.params.file))) {
        return res.status(404).json({ error: 'hls_asset_not_found' });
      }
      let job: TranscodeJob | undefined;
      let releaseCloudLease: (() => void) | undefined;
      let releaseSegmentCloudLease: (() => void) | undefined;
      if (String(req.params.file).endsWith('.ts') && item.sourceType !== 'local') {
        if (!clouds) throw new CloudSourceError('cloud_manager_unavailable', '云盘管理器尚未启动。', 503);
        const cacheJob = clouds.ensureCached(item);
        if (cacheJob.state !== 'ready') {
          return res.status(503).set('Retry-After', '1').json({
            error: 'cloud_cache_not_ready',
            message: '云盘本地副本正在恢复，请稍后重试分片。',
          });
        }
        releaseSegmentCloudLease = clouds.acquireCacheLease(cacheJob.path);
        try { item = await clouds.localizedItem(item, cacheJob); } catch (error) {
          releaseSegmentCloudLease();
          throw error;
        }
      }
      if (req.params.file === 'index.m3u8') {
        if (item.sourceType !== 'local') {
          if (!clouds) throw new CloudSourceError('cloud_manager_unavailable', '云盘管理器尚未启动。', 503);
          const cacheJob = clouds.ensureCached(item);
          if (cacheJob.state === 'failed') throw new CloudSourceError(cacheJob.errorCode || 'cloud_cache_failed', cacheJob.error || '云盘缓存失败。', cacheJob.errorStatus || 502);
          if (cacheJob.state !== 'ready') {
            return res.status(202).set('Retry-After', '1').json({
              state: cacheJob.state,
              stage: 'cloud-cache',
              progressBytes: cacheJob.progressBytes,
              totalBytes: cacheJob.totalBytes,
            });
          }
          releaseCloudLease = clouds.acquireCacheLease(cacheJob.path);
          try { item = await clouds.localizedItem(item, cacheJob); } catch (error) {
            releaseCloudLease();
            throw error;
          }
        }
        try {
          job = await transcodes.ensure(item, level);
        } catch (error) {
          if (!(error instanceof SourceChangedError) || item.sourceType !== 'local') throw error;
          await library.scan();
          item = library.get(String(req.params.id));
          if (!item) return res.status(404).json({ error: 'media_not_found' });
          job = await transcodes.ensure(item, level);
        } finally {
          if (releaseCloudLease) {
            if (job && (job.state === 'running' || job.state === 'preparing')) {
              const leaseTimer = setInterval(() => {
                if (job && job.state !== 'running' && job.state !== 'preparing') {
                  clearInterval(leaseTimer);
                  releaseCloudLease?.();
                  releaseCloudLease = undefined;
                }
              }, 1_000);
              leaseTimer.unref();
            } else {
              releaseCloudLease();
              releaseCloudLease = undefined;
            }
          }
        }
      } else job = transcodes.jobForItem(item, level);
      if (!job) {
        releaseSegmentCloudLease?.();
        return res.status(404).json({ error: 'hls_asset_not_ready' });
      }
      if (req.params.file === 'index.m3u8' && !await transcodes.waitForPlaylist(job, 5_000)) {
        return res.status(202).set('Retry-After', '1').json({ state: job.state, stage: 'transcode', progressSeconds: job.progressSeconds });
      }
      const requestedFile = String(req.params.file);
      let asset: string | undefined;
      try {
        asset = requestedFile.endsWith('.ts')
          ? await transcodes.ensureOnDemandSegment(job, item, requestedFile)
          : transcodes.resolveAsset(job, requestedFile);
      } finally {
        releaseSegmentCloudLease?.();
      }
      if (!asset) return res.status(404).json({ error: 'hls_asset_not_found' });
      try { await access(asset); } catch { return res.status(404).json({ error: 'hls_asset_not_ready' }); }
      res.set({
        'Content-Type': mimeFor(asset),
        // Public asset URLs are stable across source edits, so browser caching must
        // revalidate. The transcoded bytes are still reused from the server cache.
        'Cache-Control': req.params.file === 'index.m3u8' && job.state !== 'ready'
          ? 'no-store'
          : 'private, max-age=0, must-revalidate',
      });
      pipeFile(res, asset, next);
    } catch (error) { next(error); }
  };
  app.get('/api/media/:id/hls/:level/status', hlsStatus);
  app.get('/api/media/:id/hls/:level/:file', hlsAsset);
  // Legacy URLs remain available as the non-enhanced compatibility stream.
  app.get('/api/media/:id/hls/status', hlsStatus);
  app.get('/api/media/:id/hls/:file', hlsAsset);

  app.put('/api/progress/:id', async (req, res, next) => {
    try {
      if (!library.get(req.params.id)) return res.status(404).json({ error: 'media_not_found' });
      const value = await progress.set(req.params.id, Number(req.body?.position), Number(req.body?.duration));
      res.json({ progress: value });
    } catch (error) { next(error); }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'api_not_found' }));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof FolderPickerBusyError) {
      return res.status(409).json({ error: 'folder_picker_busy', message: error.message });
    }
    if (error instanceof FolderPickerUnsupportedError) {
      return res.status(501).json({ error: 'folder_picker_unsupported', message: error.message });
    }
    if (error instanceof MediaDirectoryValidationError) {
      return res.status(400).json({ error: 'invalid_media_directory', message: error.message });
    }
    if (error instanceof CloudSourceError) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
    if (error instanceof QuarkConnectorError) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
    if (error instanceof TranscodeCapacityError) {
      return res.status(503).set('Retry-After', '1').json({ error: 'transcode_capacity', message: error.message });
    }
    if (error instanceof ServerSuperResolutionUnavailableError) {
      return res.status(422).json({ error: 'super_resolution_unavailable', message: error.message });
    }
    const message = error instanceof Error ? error.message : 'unknown_error';
    console.error('[Localis API]', error);
    res.status(500).json({ error: 'internal_error', message: process.env.NODE_ENV === 'development' ? message : '请求处理失败' });
  });
  return app;
}
