import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LocalisConfig, MediaItem } from './types';
import { isHdrDynamicRange } from './media-compatibility';
import {
  buildAiFrameExtractionFilters,
  buildVideoPipeline,
  isHdrToneMappedToSdr,
  isAiSuperResolutionLevel,
  serverSuperResolutionPlan,
  SERVER_SUPER_RESOLUTION_PROFILES,
  ServerSuperResolutionUnavailableError,
  type ServerSuperResolutionLevel,
  type ServerSuperResolutionPlan,
} from './super-resolution';

export type TranscodeMode = 'remux' | 'audio-transcode' | 'transcode';
export type JobState = 'preparing' | 'running' | 'ready' | 'failed';

export class SourceChangedError extends Error {}
export class TranscodeCapacityError extends Error {}

export const TRANSCODE_CACHE_SCHEMA = 'v10-display-signal-dither';

export interface TranscodeJob {
  key: string;
  itemId: string;
  directory: string;
  playlistPath: string;
  mode: TranscodeMode;
  superResolution: ServerSuperResolutionLevel;
  superResolutionPlan: ServerSuperResolutionPlan;
  encoder: string;
  state: JobState;
  progressSeconds: number;
  error?: string;
  failedAt?: number;
  cancelled?: boolean;
  process?: ChildProcessWithoutNullStreams;
  startedAt: string;
  lastAccessAt: number;
  leaseExpiresAt?: number;
  strategy?: 'eager' | 'on-demand' | 'precompute';
  durationSeconds?: number;
  segmentDurationSeconds?: number;
  totalSegments?: number;
  completedSegmentIndexes?: Set<number>;
  segmentInflight?: Map<number, Promise<string>>;
  segmentProcesses?: Map<number, ChildProcessWithoutNullStreams>;
  segmentProgressSeconds?: Map<number, number>;
  segmentStages?: Map<number, 'extracting' | 'enhancing' | 'encoding'>;
  processedMediaSeconds?: number;
  processingWallSeconds?: number;
}

// Running EVENT playlists are refreshed continually by active HLS clients.
// A full minute covers normal buffering gaps while still allowing an
// abandoned full-file transcode to be reclaimed when capacity is needed.
export const TRANSCODE_ACTIVITY_LEASE_MS = 60_000;
export const TRANSCODE_IDLE_SWEEP_INTERVAL_MS = 15_000;
export const ON_DEMAND_SEGMENT_SECONDS = 4;
export const AI_PRECOMPUTE_SEGMENT_SECONDS = 4;
const AI_MODEL_NAME = 'localis-general-x4';
const AI_BACKEND_NAME = 'Real-ESRGAN NCNN Vulkan';

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
  if (![...names].every((name) => /^(init\.mp4|seg_\d{6}\.(?:m4s|ts))$/.test(name))) return false;
  return (await Promise.all([...names].map((name) => exists(path.join(directory, name))))).every(Boolean);
}

function segmentDuration(job: TranscodeJob, index: number) {
  const segmentSeconds = job.segmentDurationSeconds ?? ON_DEMAND_SEGMENT_SECONDS;
  const duration = job.durationSeconds ?? 0;
  return Math.max(0, Math.min(segmentSeconds, duration - index * segmentSeconds));
}

function onDemandPlaylist(durationSeconds: number, segmentSeconds = ON_DEMAND_SEGMENT_SECONDS) {
  const totalSegments = Math.max(1, Math.ceil(durationSeconds / segmentSeconds));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (let index = 0; index < totalSegments; index += 1) {
    const duration = Math.min(segmentSeconds, Math.max(0.001, durationSeconds - index * segmentSeconds));
    lines.push(`#EXTINF:${duration.toFixed(6)},`, `seg_${String(index).padStart(6, '0')}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return { playlist: lines.join('\n'), totalSegments };
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
  private sweepPromise?: Promise<void>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly cancellationPromises = new Map<string, Promise<void>>();
  private activeOnDemandTasks = 0;
  private activeAiTasks = 0;
  encoder = 'libx264';
  aiSuperResolutionAvailable = false;
  aiSuperResolutionReason = '此版本未包含 AI 超分运行时。';

  constructor(private readonly config: LocalisConfig) {}

  private touchJob(job: TranscodeJob) {
    const now = Date.now();
    job.lastAccessAt = now;
    job.leaseExpiresAt = now + TRANSCODE_ACTIVITY_LEASE_MS;
  }

  private hasActiveLease(job: TranscodeJob, now = Date.now()) {
    return (job.leaseExpiresAt ?? job.lastAccessAt + TRANSCODE_ACTIVITY_LEASE_MS) > now;
  }

  private activeWorkCount() {
    const eagerJobs = [...this.jobs.values()].filter(
      (job) => job.strategy !== 'on-demand' && (job.state === 'running' || job.state === 'preparing'),
    ).length;
    return eagerJobs + this.activeOnDemandTasks;
  }

  async initialize() {
    const hlsRoot = path.join(this.config.cacheDir, 'hls');
    await mkdir(hlsRoot, { recursive: true });
    await this.pruneCache();
    this.availableEncoders = await this.probeEncoders();
    this.encoder = this.availableEncoders[0];
    await this.probeAiSuperResolution();
    this.startLeaseSweeper();
  }

  private async probeAiSuperResolution() {
    const executable = this.config.aiSuperResolutionPath;
    const models = this.config.aiSuperResolutionModelsPath;
    if (!executable || !models) return;
    const required = [
      executable,
      path.join(models, `${AI_MODEL_NAME}.param`),
      path.join(models, `${AI_MODEL_NAME}.bin`),
    ];
    if (!(await Promise.all(required.map(exists))).every(Boolean)) {
      this.aiSuperResolutionReason = 'AI 超分运行时或模型文件不完整，请重新安装 Localis。';
      return;
    }
    this.aiSuperResolutionAvailable = true;
    this.aiSuperResolutionReason = '';
  }

  private startLeaseSweeper() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredJobs().catch(() => undefined);
    }, TRANSCODE_IDLE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
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

  decideMode(
    item: MediaItem,
    superResolution: ServerSuperResolutionLevel = 'off',
    forceCompatibility = false,
  ): TranscodeMode {
    // A client-side rejection (for example an unverified WebXR envelope or a
    // non-smooth MediaCapabilities result) must not be answered with a remux
    // of the same risky video. The dedicated compatibility route sets this
    // flag and therefore guarantees the existing H.264 8-bit SDR/AAC pipeline.
    if (item.kind === 'video' && forceCompatibility) return 'transcode';
    if (item.kind === 'video' && superResolution !== 'off') return 'transcode';
    if (item.kind === 'video' && isHdrDynamicRange(item.dynamicRange)) return 'transcode';
    const h264 = item.videoCodec === 'h264'
      && item.pixelFormat === 'yuv420p'
      && (!item.videoProfile || ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(item.videoProfile))
      && (!item.videoLevel || item.videoLevel <= 52);
    const aac = !item.audioCodec || item.audioCodec === 'aac';
    if (h264 && aac) return 'remux';
    if (h264) return 'audio-transcode';
    return 'transcode';
  }

  private jobKey(
    item: MediaItem,
    mode: TranscodeMode,
    superResolution: ServerSuperResolutionLevel,
    forceCompatibility = false,
  ) {
    return createHash('sha256')
      .update([
        TRANSCODE_CACHE_SCHEMA,
        item.id,
        item.size,
        item.modifiedAt,
        mode,
        superResolution,
        forceCompatibility ? 'forced-compatibility' : 'adaptive',
        item.projection,
        item.stereo,
        item.sampleAspectRatio || '1:1',
        item.dynamicRange ?? 'missing-dynamic-range',
        item.bitDepth ?? 'missing-bit-depth',
        item.colorPrimaries ?? 'missing-color-primaries',
        item.colorTransfer ?? 'missing-color-transfer',
        item.colorSpace ?? 'missing-color-space',
        item.colorRange ?? 'missing-color-range',
        mode === 'transcode' ? this.encoder : 'copy',
      ].join('|'))
      .digest('hex')
      .slice(0, 32);
  }

  async ensure(
    item: MediaItem,
    requestedSuperResolution: ServerSuperResolutionLevel = 'off',
    forceCompatibility = false,
  ): Promise<TranscodeJob> {
    const superResolution = item.kind === 'video' ? requestedSuperResolution : 'off';
    const requestedPlan = serverSuperResolutionPlan(item, superResolution);
    if (superResolution !== 'off' && !requestedPlan.available) {
      throw new ServerSuperResolutionUnavailableError(requestedPlan.reason || '无法安全生成电脑端超分流。');
    }
    if (isAiSuperResolutionLevel(superResolution) && !this.aiSuperResolutionAvailable) {
      throw new ServerSuperResolutionUnavailableError(this.aiSuperResolutionReason);
    }
    const current = await stat(item.path);
    if (item.sourceType === 'local' && (current.size !== item.size || current.mtime.toISOString() !== item.modifiedAt)) {
      throw new SourceChangedError('源文件在媒体扫描后发生了变化');
    }
    if (item.sourceType !== 'local' && item.size > 0 && current.size !== item.size) {
      throw new SourceChangedError('云盘缓存文件不完整，请重新缓存');
    }
    const mode = this.decideMode(item, superResolution, forceCompatibility);
    const key = this.jobKey(item, mode, superResolution, forceCompatibility);
    // A viewer may return while the idle sweeper is still terminating the
    // previous process and deleting this cache directory. Wait for that
    // cancellation so the replacement cannot race the old cleanup.
    const cancellation = this.cancellationPromises.get(key);
    if (cancellation) await cancellation;
    const known = this.jobs.get(key);
    if (known && known.state !== 'failed') {
      this.touchJob(known);
      return known;
    }
    if (known?.state === 'failed' && Date.now() - (known.failedAt ?? Date.now()) < 5_000) return known;
    if (known) this.jobs.delete(key);
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const operation = this.prepare(item, mode, superResolution, key);
    this.inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inflight.get(key) === operation) this.inflight.delete(key);
    }
  }

  private async prepare(item: MediaItem, mode: TranscodeMode, superResolution: ServerSuperResolutionLevel, key: string): Promise<TranscodeJob> {
    const directory = path.join(this.config.cacheDir, 'hls', key);
    const playlistPath = path.join(directory, 'index.m3u8');
    if (item.kind === 'video' && isAiSuperResolutionLevel(superResolution) && item.duration > 0) {
      return this.prepareAiPrecomputed(item, mode, superResolution, key, directory, playlistPath);
    }
    if (item.kind === 'video' && superResolution !== 'off' && item.duration > 0) {
      return this.prepareOnDemand(item, mode, superResolution, key, directory, playlistPath);
    }
    await mkdir(directory, { recursive: true });
    if (await exists(playlistPath)) {
      const playlist = await readFile(playlistPath, 'utf8');
      if (await completePlaylist(directory, playlist)) {
        const now = Date.now();
        const cached: TranscodeJob = {
          key, itemId: item.id, directory, playlistPath, mode, superResolution,
          superResolutionPlan: serverSuperResolutionPlan(item, superResolution),
          encoder: mode === 'transcode' ? this.encoder : 'copy',
          state: 'ready', progressSeconds: item.duration, startedAt: new Date().toISOString(),
          lastAccessAt: now, leaseExpiresAt: now + TRANSCODE_ACTIVITY_LEASE_MS,
          strategy: 'eager', durationSeconds: item.duration,
        };
        this.jobs.set(key, cached);
        return cached;
      }
    }
    // A non-final playlist or orphaned segments belong to a failed/interrupted job.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });

    // Reclaim abandoned work globally, but only under actual capacity
    // pressure and only after its activity lease has expired. This handles a
    // user leaving the page or switching back to direct play without killing
    // another headset whose playlist or segments are still being requested.
    await this.reclaimExpiredJobsForCapacity();

    if (this.activeWorkCount() >= this.config.maxTranscodes) throw new TranscodeCapacityError('当前已有转码任务，请稍后重试');

    const now = Date.now();
    const job: TranscodeJob = {
      key, itemId: item.id, directory, playlistPath, mode, superResolution,
      superResolutionPlan: serverSuperResolutionPlan(item, superResolution),
      encoder: mode === 'transcode' ? this.encoder : 'copy',
      state: 'preparing', progressSeconds: 0, startedAt: new Date().toISOString(),
      lastAccessAt: now, leaseExpiresAt: now + TRANSCODE_ACTIVITY_LEASE_MS,
      strategy: 'eager', durationSeconds: item.duration,
    };
    this.jobs.set(key, job);
    this.launch(job, item);
    return job;
  }

  private async prepareOnDemand(
    item: MediaItem,
    mode: TranscodeMode,
    superResolution: ServerSuperResolutionLevel,
    key: string,
    directory: string,
    playlistPath: string,
  ) {
    const segmentSeconds = ON_DEMAND_SEGMENT_SECONDS;
    const manifest = onDemandPlaylist(item.duration, segmentSeconds);
    await mkdir(directory, { recursive: true });
    let cachedPlaylist = '';
    try { cachedPlaylist = await readFile(playlistPath, 'utf8'); } catch { /* first request */ }
    if (cachedPlaylist !== manifest.playlist) {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      await writeFile(playlistPath, manifest.playlist, 'utf8');
    }

    const completedSegmentIndexes = new Set<number>();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = entry.isFile() && entry.name.match(/^seg_(\d{6})\.ts$/);
      if (!match) continue;
      const index = Number(match[1]);
      if (index < manifest.totalSegments && (await stat(path.join(directory, entry.name))).size > 0) {
        completedSegmentIndexes.add(index);
      }
    }
    const progressSeconds = [...completedSegmentIndexes].reduce(
      (total, index) => total + Math.min(segmentSeconds, item.duration - index * segmentSeconds),
      0,
    );
    const now = Date.now();
    const job: TranscodeJob = {
      key,
      itemId: item.id,
      directory,
      playlistPath,
      mode,
      superResolution,
      superResolutionPlan: serverSuperResolutionPlan(item, superResolution),
      encoder: this.encoder,
      // The complete VOD timeline is immediately available. Individual .ts
      // segments are generated and cached only when Safari/HLS asks for them.
      state: 'ready',
      progressSeconds,
      startedAt: new Date().toISOString(),
      lastAccessAt: now,
      leaseExpiresAt: now + TRANSCODE_ACTIVITY_LEASE_MS,
      strategy: 'on-demand',
      durationSeconds: item.duration,
      segmentDurationSeconds: segmentSeconds,
      totalSegments: manifest.totalSegments,
      completedSegmentIndexes,
      segmentInflight: new Map(),
      segmentProcesses: new Map(),
      segmentProgressSeconds: new Map(),
      segmentStages: new Map(),
      // Speed is measured only from work performed in this process. Cached
      // segments from an earlier run must not inflate the reported rate.
      processedMediaSeconds: 0,
      processingWallSeconds: 0,
    };
    this.jobs.set(key, job);
    return job;
  }

  private async prepareAiPrecomputed(
    item: MediaItem,
    mode: TranscodeMode,
    superResolution: ServerSuperResolutionLevel,
    key: string,
    directory: string,
    playlistPath: string,
  ) {
    const segmentSeconds = AI_PRECOMPUTE_SEGMENT_SECONDS;
    const manifest = onDemandPlaylist(item.duration, segmentSeconds);
    await mkdir(directory, { recursive: true });
    let cachedPlaylist = '';
    try { cachedPlaylist = await readFile(playlistPath, 'utf8'); } catch { /* first request */ }

    if (cachedPlaylist === manifest.playlist && await completePlaylist(directory, cachedPlaylist)) {
      const completedSegmentIndexes = new Set(Array.from({ length: manifest.totalSegments }, (_, index) => index));
      const now = Date.now();
      const cached: TranscodeJob = {
        key,
        itemId: item.id,
        directory,
        playlistPath,
        mode,
        superResolution,
        superResolutionPlan: serverSuperResolutionPlan(item, superResolution),
        encoder: this.encoder,
        state: 'ready',
        progressSeconds: item.duration,
        startedAt: new Date().toISOString(),
        lastAccessAt: now,
        leaseExpiresAt: now + TRANSCODE_ACTIVITY_LEASE_MS,
        strategy: 'precompute',
        durationSeconds: item.duration,
        segmentDurationSeconds: segmentSeconds,
        totalSegments: manifest.totalSegments,
        completedSegmentIndexes,
        segmentInflight: new Map(),
        segmentProcesses: new Map(),
        segmentProgressSeconds: new Map(),
        segmentStages: new Map(),
        processedMediaSeconds: 0,
        processingWallSeconds: 0,
      };
      this.jobs.set(key, cached);
      return cached;
    }

    // A playable manifest is published only after every neural segment exists.
    // Existing completed segments can resume after a restart, but a partial
    // timeline must never reach Safari or hls.js.
    await rm(playlistPath, { force: true });
    const completedSegmentIndexes = new Set<number>();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = entry.isFile() && entry.name.match(/^seg_(\d{6})\.ts$/);
      if (!match) continue;
      const index = Number(match[1]);
      if (index < manifest.totalSegments && (await stat(path.join(directory, entry.name))).size > 0) {
        completedSegmentIndexes.add(index);
      }
    }
    const progressSeconds = [...completedSegmentIndexes]
      .reduce((total, index) => total + Math.min(segmentSeconds, item.duration - index * segmentSeconds), 0);

    await this.reclaimExpiredJobsForCapacity();
    if (this.activeWorkCount() >= this.config.maxTranscodes) {
      throw new TranscodeCapacityError('当前已有转码任务，请稍后重试');
    }
    const now = Date.now();
    const job: TranscodeJob = {
      key,
      itemId: item.id,
      directory,
      playlistPath,
      mode,
      superResolution,
      superResolutionPlan: serverSuperResolutionPlan(item, superResolution),
      encoder: this.encoder,
      state: 'running',
      progressSeconds,
      startedAt: new Date().toISOString(),
      lastAccessAt: now,
      leaseExpiresAt: now + TRANSCODE_ACTIVITY_LEASE_MS,
      strategy: 'precompute',
      durationSeconds: item.duration,
      segmentDurationSeconds: segmentSeconds,
      totalSegments: manifest.totalSegments,
      completedSegmentIndexes,
      segmentInflight: new Map(),
      segmentProcesses: new Map(),
      segmentProgressSeconds: new Map(),
      segmentStages: new Map(),
      processedMediaSeconds: 0,
      processingWallSeconds: 0,
    };
    this.jobs.set(key, job);
    this.launchAiPrecompute(job, item, manifest.playlist);
    return job;
  }

  private encoderArgs(encoder: string, superResolution: ServerSuperResolutionLevel = 'off'): string[] {
    const profile = SERVER_SUPER_RESOLUTION_PROFILES[superResolution];
    if (encoder === 'h264_nvenc') {
      const preset = superResolution === 'ultra' ? 'p6' : superResolution === 'high' ? 'p5' : 'p4';
      return ['-c:v', encoder, '-preset', preset, '-tune', 'hq', '-rc', 'vbr', '-cq', String(profile.nvencCq), '-b:v', '0', '-maxrate:v', profile.maxRate, '-bufsize:v', profile.maxRate, '-spatial_aq', '1', '-forced-idr', '1', '-profile:v', 'high', '-level:v', '5.2'];
    }
    if (encoder === 'h264_mf') return ['-c:v', encoder, '-rate_control', 'quality', '-quality', '75', '-level:v', '5.2'];
    const preset = superResolution === 'ultra' ? 'medium' : superResolution === 'high' ? 'fast' : 'veryfast';
    return ['-c:v', encoder, '-preset', preset, '-crf', String(profile.nvencCq), '-maxrate:v', profile.maxRate, '-bufsize:v', profile.maxRate, '-profile:v', 'high', '-level:v', '5.2'];
  }

  private buildArgs(job: TranscodeJob, item: MediaItem) {
    const output = path.join(job.directory, 'index.m3u8');
    const segment = path.join(job.directory, 'seg_%06d.m4s');
    const args = [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '0.5',
      '-i', item.path,
    ];

    const pixelFormat = job.encoder === 'h264_mf' ? 'nv12' : 'yuv420p';
    const pipeline = item.kind === 'video' && job.mode === 'transcode'
      ? buildVideoPipeline(item, job.superResolution, pixelFormat)
      : undefined;
    if (item.kind === 'video' && pipeline?.filterComplex && pipeline.outputLabel) {
      args.push('-filter_complex', pipeline.filterComplex, '-map', pipeline.outputLabel, '-map', '0:a:0?');
    } else if (item.kind === 'video') args.push('-map', '0:v:0', '-map', '0:a:0?');
    else args.push('-map', '0:a:0');
    args.push('-sn', '-dn');

    if (item.kind === 'video') {
      if (job.mode === 'remux' || job.mode === 'audio-transcode') args.push('-c:v', 'copy');
      else {
        const activePipeline = pipeline!;
        const gop = Math.round(activePipeline.fps * 2);
        args.push(
          '-g', String(gop), '-keyint_min', String(gop),
          '-force_key_frames', 'expr:gte(t,n_forced*2)',
        );
        if (activePipeline.filters) args.push('-vf', activePipeline.filters.join(','));
        if (job.encoder !== 'h264_mf') args.push('-sc_threshold', '0');
        args.push(...this.encoderArgs(job.encoder, job.superResolution));
        if (isHdrToneMappedToSdr(item)) {
          args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv');
        }
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

  private buildOnDemandSegmentArgs(job: TranscodeJob, item: MediaItem, index: number, encoder: string, outputPath: string) {
    const start = index * (job.segmentDurationSeconds ?? ON_DEMAND_SEGMENT_SECONDS);
    const duration = segmentDuration(job, index);
    const args = [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '0.25',
      // Input-side seeking jumps to the closest keyframe first and then decodes
      // accurately to the requested position. A long movie no longer needs to
      // be processed from 00:00 before a far-away seek can start.
      '-ss', start.toFixed(6), '-i', item.path, '-t', duration.toFixed(6),
      '-output_ts_offset', start.toFixed(6),
    ];
    const pixelFormat = encoder === 'h264_mf' ? 'nv12' : 'yuv420p';
    const pipeline = buildVideoPipeline(item, job.superResolution, pixelFormat);
    if (pipeline.filterComplex && pipeline.outputLabel) {
      args.push('-filter_complex', pipeline.filterComplex, '-map', pipeline.outputLabel, '-map', '0:a:0?');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      if (pipeline.filters) args.push('-vf', pipeline.filters.join(','));
    }
    const gop = Math.max(1, Math.round(pipeline.fps * 2));
    args.push('-sn', '-dn', '-g', String(gop), '-keyint_min', String(gop), '-force_key_frames', 'expr:gte(t,n_forced*2)');
    if (encoder !== 'h264_mf') args.push('-sc_threshold', '0');
    args.push(
      ...this.encoderArgs(encoder, job.superResolution),
      ...(isHdrToneMappedToSdr(item)
        ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']
        : []),
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0',
      '-max_muxing_queue_size', '2048', '-muxdelay', '0', '-muxpreload', '0',
      '-mpegts_flags', '+resend_headers', '-f', 'mpegts', outputPath,
    );
    return { args, start, duration };
  }

  private async acquireOnDemandSlot(job: TranscodeJob) {
    await this.reclaimExpiredJobsForCapacity();
    while (!job.cancelled && (
      this.activeWorkCount() >= this.config.maxTranscodes
      || (isAiSuperResolutionLevel(job.superResolution) && this.activeAiTasks >= 1)
    )) await wait(50);
    if (job.cancelled) throw new Error('超分任务已停止');
    this.activeOnDemandTasks += 1;
    if (isAiSuperResolutionLevel(job.superResolution)) this.activeAiTasks += 1;
  }

  private releaseOnDemandSlot(job: TranscodeJob) {
    this.activeOnDemandTasks = Math.max(0, this.activeOnDemandTasks - 1);
    if (isAiSuperResolutionLevel(job.superResolution)) this.activeAiTasks = Math.max(0, this.activeAiTasks - 1);
  }

  private runOnDemandSegment(job: TranscodeJob, item: MediaItem, index: number, encoder: string, outputPath: string) {
    const { args, start, duration } = this.buildOnDemandSegmentArgs(job, item, index, encoder, outputPath);
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.ffmpegPath, args, { windowsHide: true, shell: false, cwd: job.directory });
      job.segmentProcesses?.set(index, child);
      job.segmentProgressSeconds?.set(index, 0);
      const wallStartedAt = Date.now();
      let progressBuffer = '';
      let stderr = '';
      let settled = false;
      child.stdout.on('data', (chunk: Buffer) => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = line.split('=', 2);
          if (key !== 'out_time_us') continue;
          const mediaTime = Math.max(0, Number(value) / 1_000_000 - start);
          job.segmentProgressSeconds?.set(index, Math.min(duration, mediaTime));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        job.segmentProcesses?.delete(index);
        job.segmentProgressSeconds?.delete(index);
        job.processingWallSeconds = (job.processingWallSeconds ?? 0) + (Date.now() - wallStartedAt) / 1_000;
        if (error) reject(error);
        else resolve();
      };
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
      });
    });
  }

  private runAiChild(
    job: TranscodeJob,
    index: number,
    executable: string,
    args: string[],
    stage: 'extracting' | 'enhancing' | 'encoding',
    onOutput?: (chunk: string) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, cwd: job.directory });
      job.segmentProcesses?.set(index, child);
      job.segmentStages?.set(index, stage);
      let stderr = '';
      let settled = false;
      child.stdout.on('data', (chunk: Buffer) => onOutput?.(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (job.segmentProcesses?.get(index) === child) job.segmentProcesses.delete(index);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `${path.basename(executable)} exited with code ${code}`));
      });
    });
  }

  private async encodeAiOnDemandSegment(job: TranscodeJob, item: MediaItem, index: number, targetPath: string) {
    const executable = this.config.aiSuperResolutionPath;
    const models = this.config.aiSuperResolutionModelsPath;
    const plan = job.superResolutionPlan;
    if (!this.aiSuperResolutionAvailable || !executable || !models || !plan.outputWidth || !plan.outputHeight) {
      throw new ServerSuperResolutionUnavailableError(this.aiSuperResolutionReason || 'AI 超分不可用。');
    }

    const start = index * (job.segmentDurationSeconds ?? AI_PRECOMPUTE_SEGMENT_SECONDS);
    const duration = segmentDuration(job, index);
    const fps = Math.min(60, Math.max(1, item.frameRate || 30));
    const expectedFrames = Math.max(1, Math.round(duration * fps));
    // The compact general model is natively 4×. Feeding a 1/2-size image gives
    // the requested 2× output directly and avoids an enormous 4× temporary
    // frame. This is the key latency/memory bound for interactive LAN use.
    const aiInputWidth = Math.max(1, Math.round(plan.outputWidth / 4));
    const aiInputHeight = Math.max(1, Math.round(plan.outputHeight / 4));
    const workDirectory = path.join(job.directory, `.ai_${String(index).padStart(6, '0')}`);
    const inputDirectory = path.join(workDirectory, 'input');
    const outputDirectory = path.join(workDirectory, 'output');
    const temporaryPath = `${targetPath}.part`;
    const wallStartedAt = Date.now();
    await rm(workDirectory, { recursive: true, force: true });
    await rm(temporaryPath, { force: true });
    await mkdir(inputDirectory, { recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    job.segmentProgressSeconds?.set(index, 0);

    try {
      await this.runAiChild(job, index, this.config.ffmpegPath, [
        '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning',
        '-ss', start.toFixed(6), '-i', item.path, '-t', duration.toFixed(6),
        '-an', '-sn', '-dn',
        '-vf', buildAiFrameExtractionFilters(item, fps, aiInputWidth, aiInputHeight, duration).join(','),
        '-frames:v', String(expectedFrames), '-start_number', '1',
        path.join(inputDirectory, 'frame_%06d.png'),
      ], 'extracting');
      job.segmentProgressSeconds?.set(index, duration * 0.15);

      let enhancedFrames = 0;
      const progressTimer = setInterval(() => {
        void readdir(outputDirectory).then((entries) => {
          enhancedFrames = entries.filter((name) => /^frame_\d{6}\.jpg$/i.test(name)).length;
          const fraction = Math.min(1, enhancedFrames / expectedFrames);
          job.segmentProgressSeconds?.set(index, duration * (0.15 + fraction * 0.7));
        }).catch(() => undefined);
      }, 200);
      progressTimer.unref();
      try {
        await this.runAiChild(job, index, executable, [
          '-i', inputDirectory,
          '-o', outputDirectory,
          '-m', models,
          '-n', AI_MODEL_NAME,
          '-s', '4',
          '-t', '256',
          '-j', '2:2:2',
          '-f', 'jpg',
        ], 'enhancing');
      } finally {
        clearInterval(progressTimer);
      }
      const generatedFrames = (await readdir(outputDirectory))
        .filter((name) => /^frame_\d{6}\.jpg$/i.test(name)).length;
      if (generatedFrames !== expectedFrames) {
        throw new Error(`AI 超分只生成了 ${generatedFrames}/${expectedFrames} 帧`);
      }
      job.segmentProgressSeconds?.set(index, duration * 0.85);

      const initialEncoder = this.availableEncoders.indexOf(job.encoder);
      const candidates = this.availableEncoders.slice(Math.max(0, initialEncoder));
      let lastError: Error | undefined;
      for (const encoder of candidates) {
        try {
          const pixelFormat = encoder === 'h264_mf' ? 'nv12' : 'yuv420p';
          const gop = Math.max(1, Math.round(fps * 2));
          let progressBuffer = '';
          await this.runAiChild(job, index, this.config.ffmpegPath, [
            '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '0.25',
            '-framerate', String(fps), '-start_number', '1', '-i', path.join(outputDirectory, 'frame_%06d.jpg'),
            '-ss', start.toFixed(6), '-i', item.path,
            '-t', duration.toFixed(6), '-output_ts_offset', start.toFixed(6),
            '-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn',
            '-vf', `scale=in_range=full:out_range=tv,setsar=1,format=${pixelFormat},setparams=range=limited`,
            '-g', String(gop), '-keyint_min', String(gop), '-force_key_frames', 'expr:gte(t,n_forced*2)',
            ...(encoder !== 'h264_mf' ? ['-sc_threshold', '0'] : []),
            ...this.encoderArgs(encoder, 'ai'),
            ...(isHdrToneMappedToSdr(item)
              ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']
              : []),
            '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000', '-ac', '2',
            '-af', 'aresample=async=1:first_pts=0',
            '-max_muxing_queue_size', '2048', '-muxdelay', '0', '-muxpreload', '0',
            '-mpegts_flags', '+resend_headers', '-f', 'mpegts', temporaryPath,
          ], 'encoding', (chunk) => {
            progressBuffer += chunk;
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop() || '';
            for (const line of lines) {
              const [key, value] = line.split('=', 2);
              if (key !== 'out_time_us') continue;
              const encoded = Math.min(duration, Math.max(0, Number(value) / 1_000_000));
              job.segmentProgressSeconds?.set(index, duration * (0.85 + 0.15 * encoded / duration));
            }
          });
          const info = await stat(temporaryPath);
          if (!info.isFile() || info.size <= 0) throw new Error('FFmpeg 没有生成有效的 AI 超分分片');
          await rename(temporaryPath, targetPath);
          job.encoder = encoder;
          job.error = undefined;
          return;
        } catch (cause) {
          lastError = cause instanceof Error ? cause : new Error(String(cause));
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          if ((job.completedSegmentIndexes?.size ?? 0) > 0) break;
        }
      }
      throw lastError ?? new Error('AI 超分分片编码失败');
    } finally {
      job.segmentProcesses?.delete(index);
      job.segmentStages?.delete(index);
      job.segmentProgressSeconds?.delete(index);
      job.processingWallSeconds = (job.processingWallSeconds ?? 0) + (Date.now() - wallStartedAt) / 1_000;
      await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async encodeOnDemandSegment(job: TranscodeJob, item: MediaItem, index: number, targetPath: string) {
    if (isAiSuperResolutionLevel(job.superResolution)) {
      await this.encodeAiOnDemandSegment(job, item, index, targetPath);
      return;
    }
    const temporaryPath = `${targetPath}.part`;
    await rm(temporaryPath, { force: true });
    const initialEncoder = this.availableEncoders.indexOf(job.encoder);
    const candidates = this.availableEncoders.slice(Math.max(0, initialEncoder));
    let lastError: Error | undefined;
    for (const encoder of candidates) {
      try {
        await this.runOnDemandSegment(job, item, index, encoder, temporaryPath);
        const info = await stat(temporaryPath);
        if (!info.isFile() || info.size <= 0) throw new Error('FFmpeg 没有生成有效的超分分片');
        await rename(temporaryPath, targetPath);
        job.encoder = encoder;
        job.error = undefined;
        return;
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        // Switching encoders after earlier segments were cached could change
        // the elementary stream parameters mid-playlist. Only fall back while
        // this cache is still empty.
        if ((job.completedSegmentIndexes?.size ?? 0) > 0) break;
      }
    }
    throw lastError ?? new Error('超分分片生成失败');
  }

  private launchAiPrecompute(job: TranscodeJob, item: MediaItem, playlist: string) {
    void (async () => {
      try {
        for (let index = 0; index < (job.totalSegments ?? 0); index += 1) {
          if (job.cancelled) throw new Error('AI 完整预处理已停止');
          if (job.completedSegmentIndexes?.has(index)) continue;
          const targetPath = path.join(job.directory, `seg_${String(index).padStart(6, '0')}.ts`);
          await this.encodeAiOnDemandSegment(job, item, index, targetPath);
          job.completedSegmentIndexes?.add(index);
          const processed = segmentDuration(job, index);
          job.processedMediaSeconds = (job.processedMediaSeconds ?? 0) + processed;
          const completedSeconds = [...(job.completedSegmentIndexes ?? [])]
            .reduce((total, segmentIndex) => total + segmentDuration(job, segmentIndex), 0);
          job.progressSeconds = Math.min(item.duration, completedSeconds);
        }
        if (job.cancelled) return;
        const temporaryPlaylist = `${job.playlistPath}.part`;
        await writeFile(temporaryPlaylist, playlist, 'utf8');
        await rename(temporaryPlaylist, job.playlistPath);
        job.state = 'ready';
        job.progressSeconds = item.duration;
        job.error = undefined;
        void this.pruneCache(job.directory);
      } catch (cause) {
        if (job.cancelled) return;
        job.state = 'failed';
        job.failedAt = Date.now();
        job.error = cause instanceof Error ? cause.message : String(cause);
      }
    })();
  }

  async ensureOnDemandSegment(job: TranscodeJob, item: MediaItem, fileName: string) {
    const match = fileName.match(/^seg_(\d{6})\.ts$/);
    const index = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= (job.totalSegments ?? 0)) {
      return undefined;
    }
    this.touchJob(job);
    const targetPath = path.join(job.directory, fileName);
    if (job.strategy === 'precompute') {
      return job.state === 'ready' && job.completedSegmentIndexes?.has(index) && await exists(targetPath)
        ? targetPath
        : undefined;
    }
    if (job.strategy !== 'on-demand') return undefined;
    if (await exists(targetPath)) {
      job.completedSegmentIndexes?.add(index);
      return targetPath;
    }
    const existing = job.segmentInflight?.get(index);
    if (existing) return existing;
    const operation = (async () => {
      await this.acquireOnDemandSlot(job);
      try {
        await this.encodeOnDemandSegment(job, item, index, targetPath);
        job.completedSegmentIndexes?.add(index);
        job.processedMediaSeconds = (job.processedMediaSeconds ?? 0) + segmentDuration(job, index);
        const completedSeconds = [...(job.completedSegmentIndexes ?? [])]
          .reduce((total, segmentIndex) => total + segmentDuration(job, segmentIndex), 0);
        job.progressSeconds = Math.min(job.durationSeconds ?? completedSeconds, completedSeconds);
        void this.pruneCache(job.directory);
        return targetPath;
      } catch (cause) {
        job.error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      } finally {
        this.releaseOnDemandSlot(job);
      }
    })();
    job.segmentInflight?.set(index, operation);
    try {
      return await operation;
    } finally {
      if (job.segmentInflight?.get(index) === operation) job.segmentInflight.delete(index);
    }
  }

  private launch(job: TranscodeJob, item: MediaItem) {
    if (job.cancelled) return;
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
      if (settled || job.cancelled) return;
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
            if (job.cancelled) return;
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
      if (job.cancelled) return;
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

  private cancelJob(job: TranscodeJob) {
    const existing = this.cancellationPromises.get(job.key);
    if (existing) return existing;
    const operation = this.performCancelJob(job);
    const tracked = operation.finally(() => {
      if (this.cancellationPromises.get(job.key) === tracked) this.cancellationPromises.delete(job.key);
    });
    this.cancellationPromises.set(job.key, tracked);
    return tracked;
  }

  private async performCancelJob(job: TranscodeJob) {
    job.cancelled = true;
    for (const segmentProcess of job.segmentProcesses?.values() ?? []) segmentProcess.kill();
    const child = job.process;
    if (child) {
      await new Promise<void>((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 2_000);
        child.once('close', done);
        child.kill();
      });
    }
    this.jobs.delete(job.key);
    await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  async sweepExpiredJobs() {
    if (this.sweepPromise) return this.sweepPromise;
    const operation = (async () => {
      const now = Date.now();
      const expired = [...this.jobs.values()]
        .filter((job) => (job.state === 'running' || job.state === 'preparing') && !this.hasActiveLease(job, now))
        .sort((left, right) => (left.leaseExpiresAt ?? left.lastAccessAt) - (right.leaseExpiresAt ?? right.lastAccessAt));
      for (const job of expired) {
        // A playlist/segment request can renew a shared stream after the
        // snapshot above. Recheck immediately before cancellation.
        if (this.jobs.get(job.key) !== job || this.hasActiveLease(job)) continue;
        await this.cancelJob(job);
      }
    })();
    this.sweepPromise = operation;
    try {
      await operation;
    } finally {
      if (this.sweepPromise === operation) this.sweepPromise = undefined;
    }
  }

  private async reclaimExpiredJobsForCapacity() {
    let activeCount = this.activeWorkCount();
    if (activeCount < this.config.maxTranscodes) return;
    const now = Date.now();
    const expired = [...this.jobs.values()]
      .filter((job) => (job.state === 'running' || job.state === 'preparing') && !this.hasActiveLease(job, now))
      .sort((left, right) => (left.leaseExpiresAt ?? left.lastAccessAt) - (right.leaseExpiresAt ?? right.lastAccessAt));
    for (const job of expired) {
      if (this.jobs.get(job.key) !== job || this.hasActiveLease(job)) continue;
      await this.cancelJob(job);
      activeCount = this.activeWorkCount();
      if (activeCount < this.config.maxTranscodes) return;
    }
  }

  async waitForPlaylist(job: TranscodeJob, timeoutMs = 20_000) {
    if (await exists(job.playlistPath)) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (job.state === 'failed') throw new Error(job.error || '转码失败');
      if (await exists(job.playlistPath)) return true;
      await wait(100);
    }
    return false;
  }

  renew(job: TranscodeJob) {
    this.touchJob(job);
  }

  resolveAsset(job: TranscodeJob, fileName: string) {
    if (!/^(index\.m3u8|init\.mp4|seg_\d{6}\.(?:m4s|ts))$/.test(fileName)) return undefined;
    this.touchJob(job);
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

  statusForItem(
    item: MediaItem,
    requestedSuperResolution: ServerSuperResolutionLevel = 'off',
    forceCompatibility = false,
  ) {
    const superResolution = item.kind === 'video' ? requestedSuperResolution : 'off';
    const mode = this.decideMode(item, superResolution, forceCompatibility);
    const key = this.jobKey(item, mode, superResolution, forceCompatibility);
    const job = this.jobs.get(key);
    const plan = job?.superResolutionPlan ?? serverSuperResolutionPlan(item, superResolution);
    const aiUnavailable = isAiSuperResolutionLevel(superResolution) && !this.aiSuperResolutionAvailable;
    if (job?.strategy === 'on-demand' || job?.strategy === 'precompute') {
      const completedSeconds = [...(job.completedSegmentIndexes ?? [])]
        .reduce((total, index) => total + segmentDuration(job, index), 0);
      const activeSeconds = [...(job.segmentProgressSeconds?.entries() ?? [])]
        .filter(([index]) => !job.completedSegmentIndexes?.has(index))
        .reduce((total, [, seconds]) => total + seconds, 0);
      const activeEntries = [...(job.segmentProgressSeconds?.entries() ?? [])]
        .filter(([index]) => !job.completedSegmentIndexes?.has(index));
      const activeDurationSeconds = activeEntries.reduce((total, [index]) => total + segmentDuration(job, index), 0);
      const generatedSeconds = Math.min(item.duration, completedSeconds + activeSeconds);
      const processingWallSeconds = job.processingWallSeconds ?? 0;
      const speed = processingWallSeconds > 0 ? (job.processedMediaSeconds ?? completedSeconds) / processingWallSeconds : 0;
      const remainingSeconds = Math.max(0, item.duration - completedSeconds);
      return {
        state: job.state,
        mode: job.mode,
        forcedCompatibility: forceCompatibility,
        encoder: job.encoder,
        progressSeconds: generatedSeconds,
        durationSeconds: item.duration,
        progressPercent: item.duration > 0 ? Math.min(100, generatedSeconds / item.duration * 100) : 0,
        speed,
        etaSeconds: speed > 0 ? remainingSeconds / speed : undefined,
        activeSegmentPercent: activeDurationSeconds > 0 ? Math.min(100, activeSeconds / activeDurationSeconds * 100) : undefined,
        activeSegmentStartSeconds: activeEntries.length > 0
          ? Math.min(...activeEntries.map(([index]) => index * (job.segmentDurationSeconds ?? ON_DEMAND_SEGMENT_SECONDS)))
          : undefined,
        activeEtaSeconds: speed > 0 && activeDurationSeconds > 0
          ? Math.max(0, activeDurationSeconds - activeSeconds) / speed
          : undefined,
        generatedSegments: job.completedSegmentIndexes?.size ?? 0,
        totalSegments: job.totalSegments ?? 0,
        generationState: remainingSeconds <= 0 && job.state === 'ready'
          ? 'complete'
          : job.state === 'failed'
            ? 'failed'
            : job.state === 'running' || job.state === 'preparing'
              ? 'processing'
              : 'waiting',
        generationStage: job.segmentStages?.values().next().value,
        enhancementBackend: isAiSuperResolutionLevel(superResolution) ? AI_BACKEND_NAME : 'FFmpeg zscale + CAS',
        strategy: job.strategy,
        seekable: job.strategy === 'on-demand' || job.state === 'ready',
        error: job.error,
        superResolution,
        plan,
      };
    }
    return job
      ? {
          state: job.state,
          mode: job.mode,
          forcedCompatibility: forceCompatibility,
          encoder: job.encoder,
          progressSeconds: job.progressSeconds,
          durationSeconds: item.duration,
          progressPercent: item.duration > 0 ? Math.min(100, job.progressSeconds / item.duration * 100) : 0,
          speed: Math.max(0, job.progressSeconds / Math.max(0.001, (Date.now() - Date.parse(job.startedAt)) / 1_000)),
          etaSeconds: job.progressSeconds > 0
            ? Math.max(0, item.duration - job.progressSeconds) / (job.progressSeconds / Math.max(0.001, (Date.now() - Date.parse(job.startedAt)) / 1_000))
            : undefined,
          generationState: job.state === 'ready' ? 'complete' : job.state === 'failed' ? 'failed' : 'processing',
          enhancementBackend: isAiSuperResolutionLevel(superResolution) ? AI_BACKEND_NAME : 'FFmpeg zscale + CAS',
          strategy: 'eager',
          seekable: job.state === 'ready',
          error: job.error,
          superResolution,
          plan,
        }
      : {
          state: superResolution !== 'off' && (!plan.available || aiUnavailable) ? 'unavailable' : 'idle',
          mode,
          forcedCompatibility: forceCompatibility,
          encoder: mode === 'transcode' ? this.encoder : 'copy',
          progressSeconds: 0,
          durationSeconds: item.duration,
          progressPercent: 0,
          speed: 0,
          generationState: 'waiting',
          strategy: isAiSuperResolutionLevel(superResolution)
            ? 'precompute'
            : superResolution !== 'off' && item.duration > 0 ? 'on-demand' : 'eager',
          seekable: !isAiSuperResolutionLevel(superResolution) && superResolution !== 'off' && item.duration > 0,
          error: aiUnavailable ? this.aiSuperResolutionReason : plan.reason,
          superResolution,
          plan,
          enhancementBackend: isAiSuperResolutionLevel(superResolution) ? AI_BACKEND_NAME : 'FFmpeg zscale + CAS',
        };
  }

  jobForItem(
    item: MediaItem,
    requestedSuperResolution: ServerSuperResolutionLevel = 'off',
    forceCompatibility = false,
  ) {
    const superResolution = item.kind === 'video' ? requestedSuperResolution : 'off';
    const mode = this.decideMode(item, superResolution, forceCompatibility);
    return this.jobs.get(this.jobKey(item, mode, superResolution, forceCompatibility));
  }

  shutdown() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      job.process?.kill();
      for (const process of job.segmentProcesses?.values() ?? []) process.kill();
    }
  }
}
