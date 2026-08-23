import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../server/app';
import { PairingAuth } from '../server/auth';
import { CloudSourceError, CloudSourceManager } from '../server/cloud-source-manager';
import { MediaLibrary } from '../server/media-library';
import { ProgressStore } from '../server/progress-store';
import { TranscodeManager } from '../server/transcode-manager';
import type { LocalisConfig, MediaItem } from '../server/types';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const quarkVideo = await readFile(path.join(process.cwd(), 'sample-media', 'flat-demo.mp4'));
const baiduVideo = Buffer.from('LOCALIS-BAIDU-OFFICIAL-VIDEO-CONTENT');

function configFor(root: string): LocalisConfig {
  return {
    projectRoot: process.cwd(),
    dataDir: root,
    cacheDir: path.join(root, 'cache'),
    mediaDirs: [],
    port: 0,
    host: '127.0.0.1',
    authDisabled: true,
    pairingCode: '123456',
    allowedHosts: ['localhost', '127.0.0.1'],
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxTranscodes: 2,
    cloudCacheBytes: 16 * 1024 * 1024,
    maxCloudDownloads: 1,
  };
}

function cloudMedia(remoteFileId: string, size: number, sourceType: 'webdav' | 'baidu'): MediaItem {
  return {
    id: `cloud-media-${remoteFileId}`,
    kind: 'video',
    title: 'cloud-video',
    fileName: 'cloud-video.mp4',
    relativePath: 'cloud-video.mp4',
    extension: '.mp4',
    size,
    modifiedAt: new Date(0).toISOString(),
    duration: 0,
    projection: 'flat',
    stereo: 'mono',
    eyeOrder: 'lr',
    yawOffset: 0,
    audioTracks: [],
    subtitleTracks: [],
    directPlay: true,
    sourceType,
    remoteFileId,
    path: `${sourceType}:${remoteFileId}`,
    libraryRoot: sourceType,
  };
}

function sendRange(request: IncomingMessage, response: ServerResponse, data: Buffer) {
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', 'video/mp4');
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) {
    response.statusCode = 200;
    response.setHeader('Content-Length', String(data.length));
    response.end(data);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
  if (start >= data.length || end < start) {
    response.statusCode = 416;
    response.setHeader('Content-Range', `bytes */${data.length}`);
    response.end();
    return;
  }
  const body = data.subarray(start, end + 1);
  response.statusCode = 206;
  response.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
  response.setHeader('Content-Length', String(body.length));
  response.end(body);
}

function xmlResponse(entries: Array<{ href: string; name: string; directory?: boolean; size?: number; type?: string; status?: number }>) {
  return `<?xml version="1.0" encoding="utf-8"?>
    <D:multistatus xmlns:D="DAV:">${entries.map((entry) => `
      <D:response><D:href>${entry.href}</D:href><D:propstat><D:prop>
        <D:displayname>${entry.name}</D:displayname>
        <D:resourcetype>${entry.directory ? '<D:collection/>' : ''}</D:resourcetype>
        <D:getcontentlength>${entry.size ?? 0}</D:getcontentlength>
        <D:getcontenttype>${entry.type ?? ''}</D:getcontenttype>
        <D:getlastmodified>Sun, 23 Aug 2026 08:00:00 GMT</D:getlastmodified>
      </D:prop><D:status>HTTP/1.1 ${entry.status ?? 200} ${entry.status === 404 ? 'Not Found' : 'OK'}</D:status></D:propstat></D:response>`).join('')}
    </D:multistatus>`;
}

async function responseBuffer(response: Response) {
  return Buffer.from(await response.arrayBuffer());
}

async function waitForCache(manager: CloudSourceManager, item: MediaItem) {
  let job = manager.ensureCached(item);
  for (let attempt = 0; attempt < 400 && (job.state === 'queued' || job.state === 'downloading'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = manager.ensureCached(item);
  }
  return job;
}

afterEach(async () => {
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('CloudSourceManager', () => {
  it('scans a loopback OpenList WebDAV tree, proxies Range and caches encrypted credentials', async () => {
    const expectedAuthorization = `Basic ${Buffer.from('localis-reader:read-only-secret').toString('base64')}`;
    let upstreamGets = 0;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      if (request.headers.authorization !== expectedAuthorization) {
        response.statusCode = 401;
        response.end();
        return;
      }
      if (request.method === 'PROPFIND' && pathname === '/dav/Quark/') {
        expect(request.headers.depth).toBe('1');
        response.statusCode = 207;
        response.setHeader('Content-Type', 'application/xml');
        response.end(xmlResponse([
          { href: '/dav/Quark/', name: 'Quark', directory: true },
          { href: '/dav/Quark/demo.mp4', name: 'demo.mp4', size: quarkVideo.length, type: 'video/mp4' },
          { href: '/dav/Quark/folder/', name: 'folder', directory: true },
          { href: '/dav/Other/escape.mp4', name: 'escape.mp4', size: 5, type: 'video/mp4' },
          { href: '/dav/Quark/failed.mp4', name: 'failed.mp4', size: 99, type: 'video/mp4', status: 404 },
        ]));
        return;
      }
      if (request.method === 'PROPFIND' && pathname === '/dav/Quark/folder/') {
        response.statusCode = 207;
        response.setHeader('Content-Type', 'application/xml');
        response.end(xmlResponse([
          { href: '/dav/Quark/folder/', name: 'folder', directory: true },
          { href: '/dav/Quark/folder/track.flac', name: 'track.flac', size: 6, type: 'audio/flac' },
        ]));
        return;
      }
      if (request.method === 'GET' && pathname === '/dav/Quark/demo.mp4') {
        upstreamGets += 1;
        expect(String(request.headers['accept-encoding'])).toContain('identity');
        if (request.headers.range === 'bytes=8-14') {
          const body = quarkVideo.subarray(8, 15);
          response.statusCode = 206;
          response.setHeader('Accept-Ranges', 'bytes');
          response.setHeader('Content-Type', 'video/mp4');
          response.setHeader('Content-Range', `bytes 8-14/${quarkVideo.length}`);
          response.setHeader('Content-Length', String(body.length));
          response.flushHeaders();
          response.write(body.subarray(0, 2));
          setTimeout(() => response.end(body.subarray(2)), 250);
          return;
        }
        sendRange(request, response, quarkVideo);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock WebDAV server did not bind');

    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-cloud-webdav-'));
    temporaryDirectories.push(root);
    const manager = new CloudSourceManager(configFor(root), undefined, { streamHeaderTimeoutMs: 100 });
    await manager.initialize();
    try {
      const summary = await manager.connectWebDav({
        provider: 'quark',
        name: '夸克测试盘',
        baseUrl: `http://127.0.0.1:${address.port}/dav/`,
        rootPath: '/Quark',
        username: 'localis-reader',
        password: 'read-only-secret',
      });
      expect(summary).toMatchObject({ provider: 'quark', connection: 'OpenList WebDAV', fileCount: 2 });
      expect(manager.files().map((file) => file.relativePath).sort()).toEqual(['demo.mp4', 'folder/track.flac']);

      const video = manager.files().find((file) => file.fileName === 'demo.mp4')!;
      const partial = await manager.openFile(video.id, { range: 'bytes=8-14' });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(`bytes 8-14/${quarkVideo.length}`);
      expect(await responseBuffer(partial)).toEqual(quarkVideo.subarray(8, 15));

      const item = cloudMedia(video.id, video.size, 'webdav');
      const cache = await waitForCache(manager, item);
      expect(cache).toMatchObject({ state: 'ready', progressBytes: quarkVideo.length, totalBytes: quarkVideo.length });
      const localized = await manager.localizedItem(item, cache);
      expect(await readFile(localized.path)).toEqual(quarkVideo);
      expect(localized).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264', audioCodec: 'aac' });

      const transcodes = new TranscodeManager(configFor(root));
      await transcodes.initialize();
      try {
        const transcode = await transcodes.ensure(localized, 'standard');
        for (let attempt = 0; attempt < 200 && transcode.state !== 'ready' && transcode.state !== 'failed'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(transcode).toMatchObject({ state: 'ready', superResolution: 'standard' });
        expect(transcodes.jobForItem(item, 'standard')).toBe(transcode);
        const probe = await execFileAsync('ffprobe', [
          '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', transcode.playlistPath,
        ], { windowsHide: true });
        expect((JSON.parse(probe.stdout) as { streams: Array<{ width: number; height: number; codec_name: string }> }).streams[0])
          .toMatchObject({ width: 1600, height: 900, codec_name: 'h264' });
      } finally {
        transcodes.shutdown();
      }
      await rm(cache.path, { force: true });
      const restoredCache = await waitForCache(manager, item);
      expect(restoredCache.state).toBe('ready');
      expect(await readFile(restoredCache.path)).toEqual(quarkVideo);

      const stored = await readFile(path.join(root, 'cloud-sources.json'), 'utf8');
      expect(stored).not.toContain('read-only-secret');
      expect(stored).toContain('"password"');
      expect(Buffer.from((await readFile(path.join(root, 'cloud-secrets.key'), 'utf8')).trim(), 'base64')).toHaveLength(32);

      const library = new MediaLibrary(configFor(root), manager);
      await library.initialize();
      const publicVideo = library.list().find((item) => item.fileName === 'demo.mp4')!;
      expect(publicVideo).toMatchObject({ sourceType: 'webdav', hlsUrl: expect.stringContaining('/hls/off/index.m3u8') });
      expect(JSON.stringify(publicVideo)).not.toContain('remoteFileId');
      expect(JSON.stringify(publicVideo)).not.toContain(`127.0.0.1:${address.port}`);

      const auth = new PairingAuth(configFor(root));
      const progress = new ProgressStore(configFor(root));
      await Promise.all([auth.initialize(), progress.initialize()]);
      const api = createApiApp({
        config: configFor(root), library, auth, progress,
        transcodes: new TranscodeManager(configFor(root)), clouds: manager,
      });
      const getsBeforeHead = upstreamGets;
      const head = await request(api).head(`/api/media/${publicVideo.id}/stream`).set('Host', 'localhost').expect(200);
      expect(head.headers['content-length']).toBe(String(quarkVideo.length));
      expect(upstreamGets).toBe(getsBeforeHead);
      const ranged = await request(api).get(`/api/media/${publicVideo.id}/stream`).set('Host', 'localhost').set('Range', 'bytes=8-14').expect(206);
      expect(Buffer.from(ranged.body)).toEqual(quarkVideo.subarray(8, 15));
      await request(api).get(`/api/media/${publicVideo.id}/stream`).set('Host', 'localhost').set('Range', `bytes=${quarkVideo.length}-`).expect(416);

      const reloaded = new CloudSourceManager(configFor(root));
      await reloaded.initialize();
      await reloaded.refreshAll();
      expect(reloaded.files()).toHaveLength(2);
      await reloaded.removeSource(summary.id);
      await expect(readFile(restoredCache.path)).rejects.toMatchObject({ code: 'ENOENT' });
      reloaded.shutdown();
    } finally {
      manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects remote or credential-bearing WebDAV endpoints before making a request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-cloud-safety-'));
    temporaryDirectories.push(root);
    const manager = new CloudSourceManager(configFor(root));
    await manager.initialize();
    await expect(manager.connectWebDav({
      provider: 'quark', name: 'unsafe', baseUrl: 'https://example.com/dav/', rootPath: '/Quark', username: 'reader', password: 'secret',
    })).rejects.toMatchObject({ code: 'unsafe_webdav_url' } satisfies Partial<CloudSourceError>);
    await expect(manager.connectWebDav({
      provider: 'quark', name: 'unsafe', baseUrl: 'http://reader:secret@127.0.0.1:5244/dav/', rootPath: '/Quark', username: 'reader', password: 'secret',
    })).rejects.toMatchObject({ code: 'unsafe_webdav_url' } satisfies Partial<CloudSourceError>);
    await expect(manager.connectWebDav({
      provider: 'quark', name: 'unsafe', baseUrl: 'http://127.0.0.1:9/dav/', rootPath: '/Quark/../Secrets', username: 'reader', password: 'secret',
    })).rejects.toMatchObject({ code: 'invalid_webdav_root' } satisfies Partial<CloudSourceError>);
    manager.shutdown();
  });

  it('refuses OpenList download redirects instead of forwarding WebDAV credentials', async () => {
    const server = createServer((request, response) => {
      if (request.method === 'PROPFIND') {
        response.statusCode = 207;
        response.setHeader('Content-Type', 'application/xml');
        response.end(xmlResponse([
          { href: '/dav/Quark/', name: 'Quark', directory: true },
          { href: '/dav/Quark/redirect.mp4', name: 'redirect.mp4', size: 100, type: 'video/mp4' },
        ]));
        return;
      }
      response.statusCode = 302;
      response.setHeader('Location', 'http://127.0.0.1:9/credential-sink');
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('redirect mock did not bind');
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-cloud-redirect-'));
    temporaryDirectories.push(root);
    const manager = new CloudSourceManager(configFor(root));
    await manager.initialize();
    try {
      await manager.connectWebDav({
        provider: 'quark', baseUrl: `http://127.0.0.1:${address.port}/dav/`, rootPath: '/Quark',
        username: 'reader', password: 'secret',
      });
      await expect(manager.openFile(manager.files()[0].id)).rejects.toMatchObject({ code: 'webdav_proxy_required' });
    } finally {
      manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('serializes cloud downloads, enforces a hard quota, clears crash parts and removes manifested cache after restart', async () => {
    const bodies = new Map([
      ['/dav/Quark/a.mp4', Buffer.alloc(128 * 1024, 0x41)],
      ['/dav/Quark/b.mp4', Buffer.alloc(128 * 1024, 0x42)],
    ]);
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      if (request.method === 'PROPFIND') {
        response.statusCode = 207;
        response.setHeader('Content-Type', 'application/xml');
        response.end(xmlResponse([
          { href: '/dav/Quark/', name: 'Quark', directory: true },
          { href: '/dav/Quark/a.mp4', name: 'a.mp4', size: bodies.get('/dav/Quark/a.mp4')!.length, type: 'video/mp4' },
          { href: '/dav/Quark/b.mp4', name: 'b.mp4', size: bodies.get('/dav/Quark/b.mp4')!.length, type: 'video/mp4' },
          { href: '/dav/Quark/too-large.mp4', name: 'too-large.mp4', size: 600 * 1024, type: 'video/mp4' },
        ]));
        return;
      }
      const body = bodies.get(pathname);
      if (request.method === 'GET' && body) {
        expect(String(request.headers['accept-encoding'])).toContain('identity');
        activeDownloads += 1;
        maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
        response.once('finish', () => { activeDownloads -= 1; });
        response.statusCode = 200;
        response.setHeader('Content-Type', 'video/mp4');
        response.setHeader('Content-Length', String(body.length));
        response.flushHeaders();
        setTimeout(() => response.end(body), 40);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock cache server did not bind');

    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-cloud-capacity-'));
    temporaryDirectories.push(root);
    const config = { ...configFor(root), cloudCacheBytes: 512 * 1024, maxCloudDownloads: 1 };
    const cloudRoot = path.join(config.cacheDir, 'cloud');
    await mkdir(cloudRoot, { recursive: true });
    await writeFile(path.join(cloudRoot, 'crashed.123.part'), Buffer.alloc(64 * 1024));
    const manager = new CloudSourceManager(config);
    await manager.initialize();
    try {
      expect(await readdir(cloudRoot)).not.toContain('crashed.123.part');
      const source = await manager.connectWebDav({
        provider: 'quark', name: 'quota-test', baseUrl: `http://127.0.0.1:${address.port}/dav/`,
        rootPath: '/Quark', username: 'reader', password: 'secret',
      });
      const [a, b] = ['a.mp4', 'b.mp4'].map((name) => manager.files().find((file) => file.fileName === name)!);
      const tooLarge = manager.files().find((file) => file.fileName === 'too-large.mp4')!;
      expect(() => manager.ensureCached(cloudMedia(tooLarge.id, tooLarge.size, 'webdav')))
        .toThrow(expect.objectContaining({ code: 'cloud_file_exceeds_cache_limit', status: 507 }));

      const itemA = cloudMedia(a.id, a.size, 'webdav');
      const itemB = cloudMedia(b.id, b.size, 'webdav');
      manager.ensureCached(itemA);
      manager.ensureCached(itemB);
      const [cachedA, cachedB] = await Promise.all([waitForCache(manager, itemA), waitForCache(manager, itemB)]);
      expect(cachedA.state).toBe('ready');
      expect(cachedB.state).toBe('ready');
      expect(maximumActiveDownloads).toBe(1);
      expect((await readdir(cloudRoot)).filter((name) => name.endsWith('.part'))).toEqual([]);

      manager.shutdown();
      const reloaded = new CloudSourceManager(config);
      await reloaded.initialize();
      await reloaded.removeSource(source.id);
      await expect(readFile(cachedA.path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(cachedB.path)).rejects.toMatchObject({ code: 'ENOENT' });
      reloaded.shutdown();
    } finally {
      manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('completes Baidu device authorization, lists the app directory and proxies redirected Range downloads', async () => {
    const largeFsId = '1844674407370955161';
    const observed = { listUserAgent: '', listStarts: [] as string[], fileMetasFsIds: '', downloadUserAgent: '', downloadRange: '', downloadToken: '' };
    let origin = '';
    const server = createServer((request, response) => {
      const url = new URL(request.url!, origin);
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/oauth/2.0/device/code') {
        expect(url.searchParams.get('client_id')).toBe('test-app-key');
        expect(url.searchParams.get('scope')).toBe('basic,netdisk');
        response.end(JSON.stringify({
          device_code: 'device-code', user_code: 'ABCD-EFGH', verification_url: `${origin}/authorize`,
          qrcode_url: `${origin}/authorize?code=ABCD-EFGH`, expires_in: 300, interval: 5,
        }));
        return;
      }
      if (url.pathname === '/oauth/2.0/token' && url.searchParams.get('grant_type') === 'device_token') {
        expect(url.searchParams.get('client_secret')).toBe('test-secret-key');
        response.end(JSON.stringify({ access_token: 'access-token-private', refresh_token: 'refresh-token-private', expires_in: 3600 }));
        return;
      }
      if (url.pathname === '/rest/2.0/xpan/multimedia' && url.searchParams.get('method') === 'listall') {
        observed.listUserAgent = String(request.headers['user-agent']);
        observed.listStarts.push(url.searchParams.get('start') || '');
        expect(url.searchParams.get('access_token')).toBe('access-token-private');
        expect(url.searchParams.get('path')).toBe('/apps/Localis');
        if (url.searchParams.get('start') === '0') {
          response.end(`{"errno":0,"has_more":1,"cursor":1000,"list":[{"fs_id":${largeFsId},"path":"/apps/Localis/百度测试.mp4","server_filename":"百度测试.mp4","size":${baiduVideo.length},"server_mtime":1787472000,"isdir":0,"category":1}]}`);
        } else {
          expect(url.searchParams.get('start')).toBe('1000');
          response.end(JSON.stringify({ errno: 0, has_more: 0, cursor: 2000, list: [{
            fs_id: 998877, path: '/apps/Localis/第二页.mp3', server_filename: '第二页.mp3',
            size: 12, server_mtime: 1_787_472_001, isdir: 0, category: 2,
          }] }));
        }
        return;
      }
      if (url.pathname === '/rest/2.0/xpan/multimedia' && url.searchParams.get('method') === 'filemetas') {
        expect(url.searchParams.get('access_token')).toBe('access-token-private');
        observed.fileMetasFsIds = url.searchParams.get('fsids') || '';
        response.end(JSON.stringify({ errno: 0, list: [{ dlink: `${origin}/baidu-download?signature=signed` }] }));
        return;
      }
      if (url.pathname === '/baidu-download') {
        observed.downloadToken = url.searchParams.get('access_token') ?? '';
        response.statusCode = 302;
        response.setHeader('Location', `${origin}/cdn/baidu.mp4`);
        response.end();
        return;
      }
      if (url.pathname === '/cdn/baidu.mp4') {
        observed.downloadUserAgent = String(request.headers['user-agent']);
        observed.downloadRange = String(request.headers.range ?? '');
        sendRange(request, response, baiduVideo);
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock Baidu server did not bind');
    origin = `http://127.0.0.1:${address.port}`;

    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-cloud-baidu-'));
    temporaryDirectories.push(root);
    const manager = new CloudSourceManager(configFor(root), { baiduOAuth: origin, baiduPan: origin }, { baiduPageDelayMs: 0 });
    await manager.initialize();
    try {
      const started = await manager.startBaiduAuthorization({
        name: '百度官方测试盘', appFolder: 'Localis', appKey: 'test-app-key', secretKey: 'test-secret-key',
      });
      expect(started).toMatchObject({ userCode: 'ABCD-EFGH', intervalSeconds: 5 });
      expect(started.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

      const authorized = await manager.pollBaiduAuthorization(started.sessionId);
      expect(authorized).toMatchObject({ state: 'authorized', source: { connection: '百度官方 API', rootPath: '/apps/Localis', fileCount: 2 } });
      expect(observed.listUserAgent).toBe('pan.baidu.com');
      expect(observed.listStarts).toEqual(['0', '1000']);
      const video = manager.files().find((file) => file.fileName === '百度测试.mp4')!;
      expect(video).toMatchObject({ provider: 'baidu', providerFileId: largeFsId, fileName: '百度测试.mp4' });

      const partial = await manager.openFile(video.id, { range: 'bytes=8-19' });
      expect(partial.status).toBe(206);
      expect(await responseBuffer(partial)).toEqual(baiduVideo.subarray(8, 20));
      expect(observed).toMatchObject({
        fileMetasFsIds: `[${largeFsId}]`, downloadUserAgent: 'pan.baidu.com', downloadRange: 'bytes=8-19', downloadToken: 'access-token-private',
      });

      const stored = await readFile(path.join(root, 'cloud-sources.json'), 'utf8');
      expect(stored).not.toContain('test-secret-key');
      expect(stored).not.toContain('access-token-private');
      expect(stored).not.toContain('refresh-token-private');
    } finally {
      manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
