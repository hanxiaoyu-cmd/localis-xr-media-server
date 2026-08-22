import { createReadStream } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getLanAddresses, saveMediaDirs } from './config';
import { PairingAuth } from './auth';
import { FolderPickerBusyError, FolderPickerUnsupportedError, isLoopbackAddress, pickLocalDirectory } from './folder-picker';
import { MediaDirectoryValidationError, MediaLibrary } from './media-library';
import { ProgressStore } from './progress-store';
import { parseByteRange, RangeNotSatisfiableError } from './range';
import { getSubtitleVtt } from './subtitles';
import { SourceChangedError, TranscodeCapacityError, TranscodeManager } from './transcode-manager';
import type { LocalisConfig } from './types';

export interface AppDependencies {
  config: LocalisConfig;
  library: MediaLibrary;
  auth: PairingAuth;
  progress: ProgressStore;
  transcodes: TranscodeManager;
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
  const { config, library, auth, progress, transcodes } = deps;
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
    res.json({ paired: auth.isAuthenticated(req), pairingRequired: !config.authDisabled });
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
      canPickLocalFolder: isLoopbackAddress(req.socket.remoteAddress),
      nativeFolderPicker: ['win32', 'darwin', 'linux'].includes(process.platform),
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
      await sendFileWithRange(req, res, item.path, mimeFor(item.path));
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

  app.get('/api/media/:id/hls/status', (req, res) => {
    const item = library.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'media_not_found' });
    res.json(transcodes.statusForItem(item));
  });
  app.get('/api/media/:id/hls/:file', async (req, res, next) => {
    try {
      let item = library.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'media_not_found' });
      // Reject malformed asset names before creating an expensive FFmpeg job.
      // Express decodes route params, so this also covers encoded traversal forms.
      if (!/^(index\.m3u8|init\.mp4|seg_\d{6}\.m4s)$/.test(req.params.file)) {
        return res.status(404).json({ error: 'hls_asset_not_found' });
      }
      let job;
      if (req.params.file === 'index.m3u8') {
        try {
          job = await transcodes.ensure(item);
        } catch (error) {
          if (!(error instanceof SourceChangedError)) throw error;
          await library.scan();
          item = library.get(req.params.id);
          if (!item) return res.status(404).json({ error: 'media_not_found' });
          job = await transcodes.ensure(item);
        }
      } else job = transcodes.jobForItem(item);
      if (!job) return res.status(404).json({ error: 'hls_asset_not_ready' });
      if (req.params.file === 'index.m3u8' && !await transcodes.waitForPlaylist(job, 5_000)) {
        return res.status(202).set('Retry-After', '1').json({ state: job.state });
      }
      const asset = transcodes.resolveAsset(job, req.params.file);
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
  });

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
    if (error instanceof TranscodeCapacityError) {
      return res.status(503).set('Retry-After', '1').json({ error: 'transcode_capacity', message: error.message });
    }
    const message = error instanceof Error ? error.message : 'unknown_error';
    console.error('[Localis API]', error);
    res.status(500).json({ error: 'internal_error', message: process.env.NODE_ENV === 'development' ? message : '请求处理失败' });
  });
  return app;
}
