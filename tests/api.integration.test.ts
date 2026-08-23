import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApp, type AppDependencies } from '../server/app';
import { PairingAuth } from '../server/auth';
import { MediaLibrary } from '../server/media-library';
import { FolderPickerBusyError } from '../server/folder-picker';
import { ProgressStore } from '../server/progress-store';
import {
  TRANSCODE_ACTIVITY_LEASE_MS,
  TRANSCODE_CACHE_SCHEMA,
  TranscodeManager,
} from '../server/transcode-manager';
import { ServerSuperResolutionUnavailableError, serverSuperResolutionPlan } from '../server/super-resolution';
import type { LocalisConfig } from '../server/types';

const execFileAsync = promisify(execFile);
let tempDir = '';
let deps: AppDependencies;
let api: ReturnType<typeof createApiApp>;
let mutableSourcePath = '';

const host = (test: request.Test) => test.set('Host', 'localhost');
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'localis-api-'));
  const mutableMediaDir = path.join(tempDir, 'mutable-media');
  await mkdir(mutableMediaDir, { recursive: true });
  mutableSourcePath = path.join(mutableMediaDir, 'mutable.mp4');
  await copyFile(path.join(process.cwd(), 'sample-media', 'flat-demo.mp4'), mutableSourcePath);
  const config: LocalisConfig = {
    projectRoot: process.cwd(), dataDir: tempDir, cacheDir: path.join(tempDir, 'cache'),
    mediaDirs: [path.join(process.cwd(), 'sample-media'), mutableMediaDir], port: 0, host: '127.0.0.1',
    authDisabled: true, pairingCode: '123456', allowedHosts: ['localhost', '127.0.0.1'],
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', maxTranscodes: 2,
  };
  const library = new MediaLibrary(config);
  const auth = new PairingAuth(config);
  const progress = new ProgressStore(config);
  const transcodes = new TranscodeManager(config);
  await Promise.all([auth.initialize(), progress.initialize(), transcodes.initialize()]);
  await library.initialize();
  deps = { config, library, auth, progress, transcodes };
  api = createApiApp(deps);
});

afterAll(async () => {
  deps.transcodes.shutdown();
  await rm(tempDir, { recursive: true, force: true });
});

describe('Localis API', () => {
  it('exposes the ephemeral pairing code only to the computer loopback status endpoint', async () => {
    const response = await host(request(api).get('/api/pair/status')).expect(200);
    expect(response.body).toMatchObject({ paired: true, pairingRequired: false });
    expect(response.body).not.toHaveProperty('pairingCode');

    const protectedConfig = { ...deps.config, authDisabled: false, pairingCode: '654321' };
    const protectedAuth = new PairingAuth(protectedConfig);
    await protectedAuth.initialize();
    const protectedApi = createApiApp({ ...deps, config: protectedConfig, auth: protectedAuth });
    const desktopStatus = await host(request(protectedApi).get('/api/pair/status')).expect(200);
    expect(desktopStatus.body).toMatchObject({ paired: false, pairingRequired: true, pairingCode: '654321' });
  });

  it('opens the injected desktop picker, scans its selection and handles cancellation or busy state', async () => {
    const selectedDirectory = await mkdtemp(path.join(tempDir, 'picked-media-'));
    const originalDirectories = [...deps.config.mediaDirs];
    const origin = (test: request.Test) => host(test).set('Origin', 'http://localhost');
    try {
      const pickDirectory = vi.fn(async () => selectedDirectory);
      const pickerApi = createApiApp({ ...deps, pickDirectory });
      const selected = await origin(request(pickerApi).post('/api/library/folders/pick').send({})).expect(201);
      expect(pickDirectory).toHaveBeenCalledOnce();
      expect(selected.body).toMatchObject({ cancelled: false, selected: selectedDirectory });
      expect(deps.config.mediaDirs).toContain(selectedDirectory);

      const cancelledApi = createApiApp({ ...deps, pickDirectory: async () => undefined });
      await origin(request(cancelledApi).post('/api/library/folders/pick').send({})).expect(200, { cancelled: true });

      const busyApi = createApiApp({ ...deps, pickDirectory: async () => { throw new FolderPickerBusyError('文件夹选择窗口已经打开。'); } });
      const busy = await origin(request(busyApi).post('/api/library/folders/pick').send({})).expect(409);
      expect(busy.body).toMatchObject({ error: 'folder_picker_busy' });

      const invalid = await origin(request(pickerApi).post('/api/library/folders').send({ path: ' ' })).expect(400);
      expect(invalid.body).toMatchObject({ error: 'invalid_media_directory' });
    } finally {
      deps.config.mediaDirs = originalDirectories;
      await deps.library.scan();
    }
  });

  it('rejects unknown hosts, mismatched origins and traversal-shaped HLS names', async () => {
    await request(api).get('/api/health').set('Host', 'attacker.example').expect(421);
    await request(api).post('/api/library/refresh').set('Host', 'localhost').expect(403);
    await request(api).post('/api/library/refresh').set('Host', 'localhost').set('Origin', 'https://attacker.example').expect(403);
    await request(api).post('/api/library/refresh').set('Host', 'localhost').set('Origin', 'http://localhost:4444').expect(403);
    const item = deps.library.list()[0];
    await host(request(api).get(`/api/media/${item.id}/hls/%2e%2e%5csecret`)).expect(404);
    const invalidLevel = await host(request(api).get(`/api/media/${item.id}/hls/not-a-level/index.m3u8`)).expect(400);
    expect(invalidLevel.body).toMatchObject({ error: 'invalid_super_resolution_level' });
    const legacy = deps.library.list().find((candidate) => candidate.title === 'legacy-transcode')!;
    await host(request(api).get(`/api/media/${legacy.id}/hls/seg_999999.m4s`)).expect(404);
    expect(deps.transcodes.statusForItem(deps.library.get(legacy.id)!)).toMatchObject({ state: 'idle' });
  });

  it('returns a sanitized media library and real poster/subtitle data', async () => {
    const libraryResponse = await host(request(api).get('/api/library')).expect(200);
    const json = JSON.stringify(libraryResponse.body);
    expect(json).not.toContain(process.cwd());
    expect(json).not.toContain('externalPath');
    const item = libraryResponse.body.items.find((candidate: { title: string }) => candidate.title === 'flat-demo');
    expect(item).toBeTruthy();
    await host(request(api).get(`/api/media/${item.id}/poster`)).expect('Content-Type', /image\/jpeg/).expect(200);
    const subtitle = await host(request(api).get(`/api/media/${item.id}/subtitles/${item.subtitleTracks[0].index}.vtt`)).expect(200);
    expect(subtitle.text).toContain('WEBVTT');
    expect(subtitle.text).toContain('Localis 局域网播放测试');
  });

  it('streams byte-identical fixed, suffix and open-ended ranges', async () => {
    const item = deps.library.list().find((candidate) => candidate.title === 'flat-demo')!;
    const source = await readFile(path.join(process.cwd(), 'sample-media', 'flat-demo.mp4'));
    const fixed = await host(request(api).get(`/api/media/${item.id}/stream`).set('Range', 'bytes=10-29')).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(206);
    expect(Buffer.compare(fixed.body, source.subarray(10, 30))).toBe(0);
    expect(fixed.headers['content-range']).toBe(`bytes 10-29/${source.length}`);

    const suffix = await host(request(api).get(`/api/media/${item.id}/stream`).set('Range', 'bytes=-64')).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(206);
    expect(Buffer.compare(suffix.body, source.subarray(source.length - 64))).toBe(0);
    await host(request(api).head(`/api/media/${item.id}/stream`).set('Range', 'bytes=0-0')).expect('Content-Length', '1').expect(206);
    await host(request(api).get(`/api/media/${item.id}/stream`).set('Range', `bytes=${source.length}-`)).expect(416);
  });

  it('revalidates ranges against the same opened representation after a source replacement', async () => {
    const item = deps.library.list().find((candidate) => candidate.title === 'mutable')!;
    const initial = await host(request(api).get(`/api/media/${item.id}/stream`).set('Range', 'bytes=0-3')).expect(206);
    const staleEtag = initial.headers.etag as string;
    const replacement = Buffer.from('replacement-representation');
    await writeFile(mutableSourcePath, replacement);
    const changed = await host(request(api).get(`/api/media/${item.id}/stream`).set('Range', 'bytes=0-3').set('If-Range', staleEtag)).expect(200);
    expect(changed.headers.etag).not.toBe(staleEtag);
    expect(changed.headers['content-length']).toBe(String(replacement.length));
    expect(Buffer.from(changed.body as unknown as Uint8Array).equals(replacement)).toBe(true);
  });

  it('performs an actual NVENC/MF/x264 fallback transcode to H.264/AAC HLS', async () => {
    const item = deps.library.list().find((candidate) => candidate.title === 'legacy-transcode')!;
    const [firstJob, secondJob] = await Promise.all([
      deps.transcodes.ensure(deps.library.get(item.id)!),
      deps.transcodes.ensure(deps.library.get(item.id)!),
    ]);
    expect(firstJob).toBe(secondJob);
    expect([...deps.transcodes.jobs.values()].filter((candidate) => candidate.itemId === item.id)).toHaveLength(1);
    await host(request(api).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (deps.transcodes.statusForItem(deps.library.get(item.id)!).state === 'ready') break;
      await wait(100);
    }
    const status = deps.transcodes.statusForItem(deps.library.get(item.id)!);
    expect(status).toMatchObject({ state: 'ready', mode: 'transcode' });
    const playlistResponse = await host(request(api).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(200);
    expect(playlistResponse.text).toContain('#EXT-X-MAP');
    expect(playlistResponse.text).toContain('#EXT-X-ENDLIST');

    const job = [...deps.transcodes.jobs.values()].find((candidate) => candidate.itemId === item.id)!;
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,pix_fmt', '-of', 'json', job.playlistPath], { windowsHide: true });
    const probe = JSON.parse(stdout) as { streams: Array<{ codec_name: string; codec_type: string; pix_fmt?: string }> };
    expect(probe.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec_name: 'h264', codec_type: 'video', pix_fmt: 'yuv420p' }),
      expect.objectContaining({ codec_name: 'aac', codec_type: 'audio' }),
    ]));
  });

  it('forces a direct-playable video through the computer-side Standard profile at the planned dimensions', async () => {
    const listed = deps.library.list().find((candidate) => candidate.title === 'flat-demo')!;
    const item = deps.library.get(listed.id)!;
    const plan = serverSuperResolutionPlan(item, 'standard');
    expect(deps.transcodes.decideMode(item, 'off')).not.toBe('transcode');
    expect(deps.transcodes.decideMode(item, 'standard')).toBe('transcode');

    await host(request(api).get(`/api/media/${item.id}/hls/standard/index.m3u8`)).expect(200);
    const standardSegment = await host(request(api).get(`/api/media/${item.id}/hls/standard/seg_000000.ts`)).expect(200);
    expect(standardSegment.headers['content-type']).toContain('video/mp2t');
    expect(deps.transcodes.statusForItem(item, 'standard')).toMatchObject({
      state: 'ready', mode: 'transcode', superResolution: 'standard',
      strategy: 'on-demand', seekable: true, generationState: 'complete',
      plan: { outputWidth: plan.outputWidth, outputHeight: plan.outputHeight },
    });
    const job = deps.transcodes.jobForItem(item, 'standard')!;
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt,level', '-of', 'json', path.join(job.directory, 'seg_000000.ts'),
    ], { windowsHide: true });
    const encoded = (JSON.parse(stdout) as { streams: Array<{ width: number; height: number; codec_name: string; pix_fmt: string; level: number }> }).streams[0];
    expect(encoded)
      .toMatchObject({ width: plan.outputWidth, height: plan.outputHeight, codec_name: 'h264', pix_fmt: 'yuv420p' });
    expect(encoded.level).toBeLessThanOrEqual(52);
    expect(deps.transcodes.jobForItem(item, 'off')?.key).not.toBe(job.key);

    const spherical = deps.library.get(deps.library.list().find((candidate) => candidate.title === 'demo-360-mono')!.id)!;
    const sphericalPlan = serverSuperResolutionPlan(spherical, 'high');
    await host(request(api).get(`/api/media/${spherical.id}/hls/high/index.m3u8`)).expect(200);
    await host(request(api).get(`/api/media/${spherical.id}/hls/high/seg_000000.ts`)).expect(200);
    const sphericalJob = deps.transcodes.jobForItem(spherical, 'high')!;
    expect(sphericalJob.state).toBe('ready');
    const sphericalProbe = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path.join(sphericalJob.directory, 'seg_000000.ts'),
    ], { windowsHide: true });
    expect((JSON.parse(sphericalProbe.stdout) as { streams: Array<{ width: number; height: number }> }).streams[0])
      .toMatchObject({ width: sphericalPlan.outputWidth, height: sphericalPlan.outputHeight });
  });

  it('publishes a full-duration VOD timeline immediately and generates a far seek segment first', async () => {
    const item = deps.library.get(deps.library.list().find((candidate) => candidate.title === 'seekable-long')!.id)!;
    const startedAt = Date.now();
    const playlist = await host(request(api).get(`/api/media/${item.id}/hls/standard/index.m3u8`)).expect(200);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(playlist.text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist.text).toContain('seg_000000.ts');
    expect(playlist.text).toContain('seg_000002.ts');
    expect(playlist.text.match(/#EXTINF:/g)).toHaveLength(3);

    const farSegment = await host(request(api).get(`/api/media/${item.id}/hls/standard/seg_000002.ts`)).expect(200);
    expect(farSegment.headers['content-type']).toContain('video/mp2t');
    const status = deps.transcodes.statusForItem(item, 'standard');
    expect(status).toMatchObject({
      state: 'ready', strategy: 'on-demand', seekable: true,
      generatedSegments: 1, totalSegments: 3,
    });
    expect(status.progressPercent).toBeGreaterThan(30);
    expect(status.progressPercent).toBeLessThan(40);

    const job = deps.transcodes.jobForItem(item, 'standard')!;
    expect(await access(path.join(job.directory, 'seg_000002.ts')).then(() => true)).toBe(true);
    await expect(access(path.join(job.directory, 'seg_000000.ts'))).rejects.toBeTruthy();
    const probe = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=start_time,duration', '-of', 'json', path.join(job.directory, 'seg_000002.ts'),
    ], { windowsHide: true });
    const format = (JSON.parse(probe.stdout) as { format: { start_time: string; duration: string } }).format;
    expect(Number(format.start_time)).toBeGreaterThanOrEqual(7.5);
    expect(Number(format.duration)).toBeGreaterThan(3.5);
  });

  it('reports an explicit unavailable state instead of downsampling an unsafe enhanced source', async () => {
    const listed = deps.library.list().find((candidate) => candidate.title === 'flat-demo')!;
    const source = deps.library.get(listed.id)!;
    const unsafe = { ...source, width: 5760, height: 2880, frameRate: 60, stereo: 'sbs' as const };
    expect(deps.transcodes.statusForItem(unsafe, 'standard')).toMatchObject({
      state: 'unavailable',
      plan: { available: false, outputWidth: 5760, outputHeight: 2880 },
    });
    await expect(deps.transcodes.ensure(unsafe, 'standard')).rejects.toBeInstanceOf(ServerSuperResolutionUnavailableError);
  });

  it('falls back to another proven encoder when the preferred encoder rejects a tiny frame', async () => {
    const item = deps.library.list().find((candidate) => candidate.title === 'tiny-legacy')!;
    await host(request(api).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (deps.transcodes.statusForItem(deps.library.get(item.id)!).state === 'ready') break;
      await wait(100);
    }
    const status = deps.transcodes.statusForItem(deps.library.get(item.id)!);
    expect(status).toMatchObject({ state: 'ready', mode: 'transcode' });
    if (deps.transcodes.encoder === 'h264_nvenc') expect(status.encoder).not.toBe('h264_nvenc');
  });

  it('normalizes odd source dimensions to an even H.264-compatible frame', async () => {
    const item = deps.library.list().find((candidate) => candidate.title === 'odd-legacy')!;
    await host(request(api).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (deps.transcodes.statusForItem(deps.library.get(item.id)!).state === 'ready') break;
      await wait(100);
    }
    const job = deps.transcodes.jobForItem(deps.library.get(item.id)!)!;
    expect(job.state).toBe('ready');
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', job.playlistPath,
    ], { windowsHide: true });
    const stream = (JSON.parse(stdout) as { streams: Array<{ width: number; height: number }> }).streams[0];
    expect(stream.width % 2).toBe(0);
    expect(stream.height % 2).toBe(0);
  });

  it('transcodes H.264 High10 instead of remuxing the same incompatible pixel format', async () => {
    const item = deps.library.list().find((candidate) => candidate.title === 'high10-incompatible')!;
    expect(deps.transcodes.decideMode(deps.library.get(item.id)!)).toBe('transcode');
    await host(request(api).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (deps.transcodes.statusForItem(deps.library.get(item.id)!).state === 'ready') break;
      await wait(100);
    }
    const job = deps.transcodes.jobForItem(deps.library.get(item.id)!)!;
    expect(job.state).toBe('ready');
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', job.playlistPath,
    ], { windowsHide: true });
    expect((JSON.parse(stdout) as { streams: Array<{ codec_name: string; pix_fmt: string }> }).streams[0])
      .toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p' });
  });

  it('preserves anamorphic display aspect and caps high-frame-rate output at 60 fps', async () => {
    const anamorphic = deps.library.list().find((candidate) => candidate.title === 'anamorphic-legacy')!;
    await host(request(api).get(`/api/media/${anamorphic.id}/hls/index.m3u8`)).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (deps.transcodes.statusForItem(deps.library.get(anamorphic.id)!).state === 'ready') break;
      await wait(100);
    }
    const anamorphicJob = deps.transcodes.jobForItem(deps.library.get(anamorphic.id)!)!;
    const anamorphicProbe = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'json', anamorphicJob.playlistPath,
    ], { windowsHide: true });
    const display = (JSON.parse(anamorphicProbe.stdout) as { streams: Array<{ width: number; height: number; sample_aspect_ratio: string }> }).streams[0];
    // Media Foundation omits explicit SAR metadata after producing square-pixel
    // dimensions; other encoders report the equivalent 1:1 value.
    expect([undefined, '1:1']).toContain(display.sample_aspect_ratio);
    expect(Math.abs(display.width / display.height - 4 / 3)).toBeLessThan(0.01);

    const highFps = deps.library.list().find((candidate) => candidate.title === 'highfps-legacy')!;
    await host(request(api).get(`/api/media/${highFps.id}/hls/index.m3u8`)).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (deps.transcodes.statusForItem(deps.library.get(highFps.id)!).state === 'ready') break;
      await wait(100);
    }
    const highFpsJob = deps.transcodes.jobForItem(deps.library.get(highFps.id)!)!;
    const fpsProbe = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'json', highFpsJob.playlistPath,
    ], { windowsHide: true });
    const [numerator, denominator] = (JSON.parse(fpsProbe.stdout) as { streams: Array<{ avg_frame_rate: string }> }).streams[0].avg_frame_rate.split('/').map(Number);
    expect(numerator / denominator).toBeLessThanOrEqual(60);
  });

  it('does not reuse a complete v3 HLS cache entry after the server-SR pipeline change', async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'localis-cache-schema-'));
    const isolatedConfig: LocalisConfig = {
      ...deps.config,
      dataDir: isolatedRoot,
      cacheDir: path.join(isolatedRoot, 'cache'),
      maxTranscodes: 1,
    };
    const transcodes = new TranscodeManager(isolatedConfig);
    try {
      const listed = deps.library.list().find((candidate) => candidate.title === 'flat-remux')!;
      const item = deps.library.get(listed.id)!;
      const mode = transcodes.decideMode(item);
      expect(mode).toBe('remux');

      const keyFor = (schema: string) => createHash('sha256')
        .update([
          schema, item.id, item.size, item.modifiedAt, mode, 'off', item.projection,
          item.stereo, item.sampleAspectRatio || '1:1', 'copy',
        ].join('|'))
        .digest('hex')
        .slice(0, 32);
      const legacyKey = keyFor('v3');
      const legacyDirectory = path.join(isolatedConfig.cacheDir, 'hls', legacyKey);
      await mkdir(legacyDirectory, { recursive: true });
      await Promise.all([
        writeFile(path.join(legacyDirectory, 'init.mp4'), 'legacy-init'),
        writeFile(path.join(legacyDirectory, 'seg_000000.m4s'), 'legacy-segment'),
        writeFile(path.join(legacyDirectory, 'index.m3u8'), [
          '#EXTM3U',
          '#EXT-X-VERSION:7',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:1.0,',
          'seg_000000.m4s',
          '#EXT-X-ENDLIST',
          '# legacy-v3-cache',
          '',
        ].join('\n')),
      ]);

      const job = await transcodes.ensure(item);
      expect(job.key).toBe(keyFor(TRANSCODE_CACHE_SCHEMA));
      expect(job.key).not.toBe(legacyKey);
      expect(job.directory).not.toBe(legacyDirectory);
      expect(await readFile(path.join(legacyDirectory, 'index.m3u8'), 'utf8')).toContain('legacy-v3-cache');
    } finally {
      transcodes.shutdown();
      await wait(100);
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('returns retryable capacity status and succeeds after the only transcode slot is released', async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'localis-capacity-'));
    const isolatedConfig: LocalisConfig = {
      ...deps.config,
      dataDir: isolatedRoot,
      cacheDir: path.join(isolatedRoot, 'cache'),
      maxTranscodes: 1,
    };
    const transcodes = new TranscodeManager(isolatedConfig);
    const occupiedKey = 'occupied-slot';
    const occupiedJob = {
      key: occupiedKey,
      itemId: 'another-media-item',
      directory: path.join(isolatedConfig.cacheDir, 'hls', occupiedKey),
      playlistPath: path.join(isolatedConfig.cacheDir, 'hls', occupiedKey, 'index.m3u8'),
      mode: 'transcode',
      superResolution: 'off',
      superResolutionPlan: serverSuperResolutionPlan({ stereo: 'mono' }, 'off'),
      encoder: 'libx264',
      state: 'running',
      progressSeconds: 0,
      startedAt: new Date().toISOString(),
      lastAccessAt: Date.now() - TRANSCODE_ACTIVITY_LEASE_MS - 1_000,
      leaseExpiresAt: Date.now() - 1_000,
    } satisfies Parameters<typeof transcodes.resolveAsset>[0];
    transcodes.jobs.set(occupiedKey, occupiedJob);
    // Playlist and segment requests from any number of clients share and renew
    // the same job lease, so another profile cannot reclaim an actively viewed stream.
    expect(transcodes.resolveAsset(occupiedJob, 'index.m3u8')).toBe(occupiedJob.playlistPath);
    const firstRenewal = occupiedJob.leaseExpiresAt;
    expect(transcodes.resolveAsset(occupiedJob, 'seg_000001.m4s')).toContain('seg_000001.m4s');
    expect(occupiedJob.leaseExpiresAt).toBeGreaterThanOrEqual(firstRenewal);
    const isolatedApi = createApiApp({
      config: isolatedConfig,
      library: deps.library,
      auth: deps.auth,
      progress: deps.progress,
      transcodes,
    });
    try {
      const item = deps.library.list().find((candidate) => candidate.title === 'flat-remux')!;
      const busy = await host(request(isolatedApi).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(503);
      expect(busy.headers['retry-after']).toBe('1');
      expect(busy.body).toMatchObject({ error: 'transcode_capacity' });

      transcodes.jobs.delete(occupiedKey);
      const retried = await host(request(isolatedApi).get(`/api/media/${item.id}/hls/index.m3u8`)).expect(200);
      expect(retried.headers['content-type']).toMatch(/mpegurl/);
      expect(retried.text).toContain('#EXTM3U');
    } finally {
      transcodes.shutdown();
      await wait(100);
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('reclaims an expired global transcode lease while preserving active leases', async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'localis-profile-switch-'));
    const isolatedConfig: LocalisConfig = {
      ...deps.config,
      dataDir: isolatedRoot,
      cacheDir: path.join(isolatedRoot, 'cache'),
      maxTranscodes: 1,
    };
    const transcodes = new TranscodeManager(isolatedConfig);
    const item = deps.library.list().find((candidate) => candidate.title === 'flat-demo')!;
    const source = deps.library.get(item.id)!;
    const staleKey = 'abandoned-standard-profile';
    transcodes.jobs.set(staleKey, {
      key: staleKey,
      itemId: 'a-different-abandoned-media-item',
      directory: path.join(isolatedConfig.cacheDir, 'hls', staleKey),
      playlistPath: path.join(isolatedConfig.cacheDir, 'hls', staleKey, 'index.m3u8'),
      mode: 'transcode',
      superResolution: 'standard',
      superResolutionPlan: serverSuperResolutionPlan(source, 'standard'),
      encoder: 'libx264',
      state: 'running',
      progressSeconds: 0,
      startedAt: new Date().toISOString(),
      lastAccessAt: Date.now() - TRANSCODE_ACTIVITY_LEASE_MS - 1_000,
      leaseExpiresAt: Date.now() - 1_000,
    });
    const isolatedApi = createApiApp({
      config: isolatedConfig,
      library: deps.library,
      auth: deps.auth,
      progress: deps.progress,
      transcodes,
    });
    try {
      await host(request(isolatedApi).get(`/api/media/${source.id}/hls/high/index.m3u8`)).expect(200);
      await host(request(isolatedApi).get(`/api/media/${source.id}/hls/high/seg_000000.ts`)).expect(200);
      expect(transcodes.jobs.has(staleKey)).toBe(false);
      expect(transcodes.jobForItem(source, 'high')).toBeTruthy();
    } finally {
      transcodes.shutdown();
      await wait(100);
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('proactively sweeps abandoned work without touching a shared active stream', async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'localis-idle-sweep-'));
    const isolatedConfig: LocalisConfig = {
      ...deps.config,
      dataDir: isolatedRoot,
      cacheDir: path.join(isolatedRoot, 'cache'),
      maxTranscodes: 2,
    };
    const transcodes = new TranscodeManager(isolatedConfig);
    const source = deps.library.get(deps.library.list().find((candidate) => candidate.title === 'flat-demo')!.id)!;
    const makeJob = (key: string, leaseExpiresAt: number) => ({
      key,
      itemId: key,
      directory: path.join(isolatedConfig.cacheDir, 'hls', key),
      playlistPath: path.join(isolatedConfig.cacheDir, 'hls', key, 'index.m3u8'),
      mode: 'transcode' as const,
      superResolution: 'standard' as const,
      superResolutionPlan: serverSuperResolutionPlan(source, 'standard'),
      encoder: 'libx264',
      state: 'running' as const,
      progressSeconds: 0,
      startedAt: new Date().toISOString(),
      lastAccessAt: leaseExpiresAt - TRANSCODE_ACTIVITY_LEASE_MS,
      leaseExpiresAt,
    });
    const abandoned = makeJob('abandoned-job', Date.now() - 1_000);
    const sharedActive = makeJob('shared-active-job', Date.now() - 1_000);
    transcodes.jobs.set(abandoned.key, abandoned);
    transcodes.jobs.set(sharedActive.key, sharedActive);
    // Any headset requesting the shared playlist or a segment renews the job's
    // single activity lease on behalf of every viewer of that same HLS stream.
    transcodes.resolveAsset(sharedActive, 'index.m3u8');
    transcodes.resolveAsset(sharedActive, 'seg_000001.m4s');

    try {
      await transcodes.sweepExpiredJobs();
      expect(transcodes.jobs.has(abandoned.key)).toBe(false);
      expect(transcodes.jobs.get(sharedActive.key)).toBe(sharedActive);
      expect(sharedActive.leaseExpiresAt).toBeGreaterThan(Date.now());
    } finally {
      transcodes.shutdown();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('starts an unreferenced idle sweeper during initialization and clears it on shutdown', async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'localis-sweep-lifecycle-'));
    const transcodes = new TranscodeManager({
      ...deps.config,
      dataDir: isolatedRoot,
      cacheDir: path.join(isolatedRoot, 'cache'),
    });
    const lifecycle = transcodes as unknown as { sweepTimer?: ReturnType<typeof setInterval> };
    try {
      await transcodes.initialize();
      expect(lifecycle.sweepTimer).toBeDefined();
      expect(lifecycle.sweepTimer?.hasRef()).toBe(false);
      transcodes.shutdown();
      expect(lifecycle.sweepTimer).toBeUndefined();
    } finally {
      transcodes.shutdown();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
