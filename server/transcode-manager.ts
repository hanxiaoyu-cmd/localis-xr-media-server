import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LocalisConfig, MediaItem } from './types';

export type TranscodeMode = 'remux' | 'audio-transcode' | 'transcode';
export type JobState = 'preparing' | 'running' | 'ready' | 'failed';

export class SourceChangedError extends Error {}
export class TranscodeCapacityError extends Error {}

export const TRANSCODE_CACHE_SCHEMA = 'v3';

export interface TranscodeJob {
  key: string;
  itemId: string;
  directory: string;
  playlistPath: string;
  mode: TranscodeMode;
  encoder: string;
  state: JobState;
  progressSeconds: number;
  error?: string;
  failedAt?: number;
  process?: ChildProcessWithoutNullStreams;
  startedAt: string;
  lastAccessAt: number;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function completePlaylist(directory: string, playlist: string) {
  if (!playlist.includes('#EXT-X-ENDLIST')) return false;
  const names = new Set<string>();
  for (const line of playlist.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) names.add(trimmed);
    const map = trimmed.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
    if (map) names.add(map[1]);
  }
  if (![...names].every((name) => /^(init\.mp4|seg_\d{6}\.m4s)$/.test(name))) return false;
  return (await Promise.all([...names].map((name) => exists(path.join(directory, name))))).every(Boolean);
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

export class TranscodeManager {
  readonly jobs = new Map<string, TranscodeJob>();
  private readonly inflight = new Map<string, Promise<TranscodeJob>>();
  private availableEncoders = ['libx264'];
  private prunePromise?: Promise<void>;
  encoder = 'libx264';

  constructor(private readonly config: LocalisConfig) {}

  async initialize() {
    const hlsRoot = path.join(this.config.cacheDir, 'hls');
    await mkdir(hlsRoot, { recursive: true });
    await this.pruneCache();
    this.availableEncoders = await this.probeEncoders();
    this.encoder = this.availableEncoders[0];
  }

  private async probeEncoders() {
    const candidates = process.env.LOCALIS_ENCODER
      ? [process.env.LOCALIS_ENCODER]
      : ['h264_nvenc', 'h264_mf', 'libx264'];
    const available: string[] = [];
    for (const candidate of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const sink = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const child = spawn(this.config.ffmpegPath, [
          '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=0.5',
          '-frames:v', '1', '-an',
          '-vf', candidate === 'h264_mf' ? 'format=nv12' : 'format=yuv420p',
          ...this.encoderArgs(candidate),
          '-f', 'null', sink,
        ], { windowsHide: true, shell: false });
        const timer = setTimeout(() => { child.kill(); resolve(false); }, 15_000);
        child.once('error', () => { clearTimeout(timer); resolve(false); });
        child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
      });
      if (ok) available.push(candidate);
    }
    if (available.length === 0) throw new Error('找不到可用的 H.264 编码器（已探测 NVENC、Media Foundation 与 libx264）');
    return available;
  }

  decideMode(item: MediaItem): TranscodeMode {
    const h264 = item.videoCodec === 'h264'
      && item.pixelFormat === 'yuv420p'
      && (!item.videoProfile || ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(item.videoProfile))
      && (!item.videoLevel || item.videoLevel <= 52);
    const aac = !item.audioCodec || item.audioCodec === 'aac';
    if (h264 && aac) return 'remux';
    if (h264) return 'audio-transcode';
    return 'transcode';
  }

  private jobKey(item: MediaItem, mode: TranscodeMode) {
    return createHash('sha256')
      .update([TRANSCODE_CACHE_SCHEMA, item.id, item.size, item.modifiedAt, mode, mode === 'transcode' ? this.encoder : 'copy'].join('|'))
      .digest('hex')
      .slice(0, 32);
  }

  async ensure(item: MediaItem): Promise<TranscodeJob> {
    const current = await stat(item.path);
    if (current.size !== item.size || current.mtime.toISOString() !== item.modifiedAt) {
      throw new SourceChangedError('源文件在媒体扫描后发生了变化');
    }
    const mode = this.decideMode(item);
    const key = this.jobKey(item, mode);
    const known = this.jobs.get(key);
    if (known && known.state !== 'failed') {
      known.lastAccessAt = Date.now();
      return known;
    }
    if (known?.state === 'failed' && Date.now() - (known.failedAt ?? Date.now()) < 5_000) return known;
    if (known) this.jobs.delete(key);
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const operation = this.prepare(item, mode, key);
    this.inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inflight.get(key) === operation) this.inflight.delete(key);
    }
  }

  private async prepare(item: MediaItem, mode: TranscodeMode, key: string): Promise<TranscodeJob> {
    const directory = path.join(this.config.cacheDir, 'hls', key);
    const playlistPath = path.join(directory, 'index.m3u8');
    await mkdir(directory, { recursive: true });
    if (await exists(playlistPath)) {
      const playlist = await readFile(playlistPath, 'utf8');
      if (await completePlaylist(directory, playlist)) {
        const cached: TranscodeJob = {
          key, itemId: item.id, directory, playlistPath, mode,
          encoder: mode === 'transcode' ? this.encoder : 'copy',
          state: 'ready', progressSeconds: item.duration, startedAt: new Date().toISOString(), lastAccessAt: Date.now(),
        };
        this.jobs.set(key, cached);
        return cached;
      }
    }
    // A non-final playlist or orphaned segments belong to a failed/interrupted job.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });

    const activeCount = [...this.jobs.values()].filter((job) => job.state === 'running' || job.state === 'preparing').length;
    if (activeCount >= this.config.maxTranscodes) throw new TranscodeCapacityError('当前已有转码任务，请稍后重试');

    const job: TranscodeJob = {
      key, itemId: item.id, directory, playlistPath, mode,
      encoder: mode === 'transcode' ? this.encoder : 'copy',
      state: 'preparing', progressSeconds: 0, startedAt: new Date().toISOString(), lastAccessAt: Date.now(),
    };
    this.jobs.set(key, job);
    this.launch(job, item);
    return job;
  }

  private encoderArgs(encoder: string): string[] {
    if (encoder === 'h264_nvenc') {
      return ['-c:v', encoder, '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate:v', '24M', '-bufsize:v', '48M', '-spatial_aq', '1', '-forced-idr', '1', '-profile:v', 'high'];
    }
    if (encoder === 'h264_mf') return ['-c:v', encoder, '-rate_control', 'quality', '-quality', '75'];
    return ['-c:v', encoder, '-preset', 'veryfast', '-crf', '21', '-maxrate:v', '24M', '-bufsize:v', '48M', '-profile:v', 'high'];
  }

  private buildArgs(job: TranscodeJob, item: MediaItem) {
    const output = path.join(job.directory, 'index.m3u8');
    const segment = path.join(job.directory, 'seg_%06d.m4s');
    const args = [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '0.5',
      '-i', item.path,
    ];

    if (item.kind === 'video') args.push('-map', '0:v:0', '-map', '0:a:0?');
    else args.push('-map', '0:a:0');
    args.push('-sn', '-dn');

    if (item.kind === 'video') {
      if (job.mode === 'remux' || job.mode === 'audio-transcode') args.push('-c:v', 'copy');
      else {
        const sourceFps = Math.max(1, item.frameRate || 30);
        const fps = Math.min(60, sourceFps);
        const gop = Math.round(fps * 2);
        const pixelFormat = job.encoder === 'h264_mf' ? 'nv12' : 'yuv420p';
        const filters = [
          "scale=w='max(2,trunc(if(gte(iw*sar,ih),min(3840,iw*sar),min(3840,ih)*iw*sar/ih)/2)*2)':h='max(2,trunc(if(gte(iw*sar,ih),min(3840,iw*sar)*ih/(iw*sar),min(3840,ih))/2)*2)':flags=bicubic",
          'setsar=1',
          ...(sourceFps > 60 ? [`fps=${fps}`] : []),
          `format=${pixelFormat}`,
        ];
        args.push(
          '-vf', filters.join(','),
          '-g', String(gop), '-keyint_min', String(gop),
          '-force_key_frames', 'expr:gte(t,n_forced*2)',
        );
        if (job.encoder !== 'h264_mf') args.push('-sc_threshold', '0');
        args.push(...this.encoderArgs(job.encoder));
      }
    }

    if (job.mode === 'remux' && item.audioCodec === 'aac') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0');

    args.push(
      '-max_muxing_queue_size', '2048', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', segment, '-hls_flags', 'independent_segments+temp_file', output,
    );
    return args;
  }

  private launch(job: TranscodeJob, item: MediaItem) {
    job.state = 'running';
    const child = spawn(this.config.ffmpegPath, this.buildArgs(job, item), {
      windowsHide: true,
      shell: false,
      cwd: job.directory,
    });
    job.process = child;
    let progressBuffer = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const [key, value] = line.split('=', 2);
        if (key === 'out_time_us') job.progressSeconds = Number(value) / 1_000_000;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      job.process = undefined;
      const currentIndex = this.availableEncoders.indexOf(job.encoder);
      const nextEncoder = job.mode === 'transcode' ? this.availableEncoders[currentIndex + 1] : undefined;
      if (nextEncoder) {
        job.state = 'preparing';
        job.progressSeconds = 0;
        job.error = `编码器 ${job.encoder} 失败，正在回退到 ${nextEncoder}：${message}`;
        void rm(job.directory, { recursive: true, force: true })
          .then(() => mkdir(job.directory, { recursive: true }))
          .then(() => {
            job.encoder = nextEncoder;
            job.error = undefined;
            this.launch(job, item);
          })
          .catch((error) => {
            job.state = 'failed';
            job.failedAt = Date.now();
            job.error = error instanceof Error ? error.message : String(error);
          });
        return;
      }
      job.state = 'failed';
      job.failedAt = Date.now();
      job.error = message;
    };
    child.once('error', (error) => fail(error.message));
    // `close` fires after FFmpeg and all stdio handles are closed. Marking the
    // job ready on `exit` can race the final atomic playlist rename on Windows.
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      job.process = undefined;
      if (code === 0) {
        job.state = 'ready';
        job.progressSeconds = item.duration;
        void this.pruneCache(job.directory);
      } else {
        settled = false;
        fail(stderr.trim() || `FFmpeg exited with code ${code}`);
      }
    });
  }

  async waitForPlaylist(job: TranscodeJob, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (job.state === 'failed') throw new Error(job.error || '转码失败');
      if (await exists(job.playlistPath)) return true;
      await wait(100);
    }
    return false;
  }

  resolveAsset(job: TranscodeJob, fileName: string) {
    if (!/^(index\.m3u8|init\.mp4|seg_\d{6}\.m4s)$/.test(fileName)) return undefined;
    job.lastAccessAt = Date.now();
    return path.join(job.directory, fileName);
  }

  private pruneCache(exclude?: string) {
    if (this.prunePromise) return this.prunePromise;
    this.prunePromise = (async () => {
      const root = path.join(this.config.cacheDir, 'hls');
      const limit = this.config.maxCacheBytes ?? 20 * 1024 ** 3;
      const entries = await readdir(root, { withFileTypes: true });
      const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const directory = path.join(root, entry.name);
        const [size, info] = await Promise.all([directorySize(directory), stat(directory)]);
        return { directory, size, modifiedAt: info.mtimeMs };
      }));
      let total = directories.reduce((sum, entry) => sum + entry.size, 0);
      if (total <= limit) return;
      for (const entry of directories.sort((a, b) => a.modifiedAt - b.modifiedAt)) {
        if (total <= limit || entry.directory === exclude) continue;
        const job = [...this.jobs.values()].find((candidate) => candidate.directory === entry.directory);
        if (job && (job.state === 'running' || job.state === 'preparing' || Date.now() - job.lastAccessAt < 5 * 60_000)) continue;
        await rm(entry.directory, { recursive: true, force: true });
        if (job) this.jobs.delete(job.key);
        total -= entry.size;
      }
    })().finally(() => { this.prunePromise = undefined; });
    return this.prunePromise;
  }

  statusForItem(item: MediaItem) {
    const mode = this.decideMode(item);
    const key = this.jobKey(item, mode);
    const job = this.jobs.get(key);
    return job ? { state: job.state, mode: job.mode, encoder: job.encoder, progressSeconds: job.progressSeconds, error: job.error } : { state: 'idle', mode, encoder: mode === 'transcode' ? this.encoder : 'copy', progressSeconds: 0 };
  }

  jobForItem(item: MediaItem) {
    const mode = this.decideMode(item);
    return this.jobs.get(this.jobKey(item, mode));
  }

  shutdown() {
    for (const job of this.jobs.values()) job.process?.kill();
  }
}
