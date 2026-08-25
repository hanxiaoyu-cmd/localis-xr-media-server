import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CloudRemoteFile, CloudSourceManager } from './cloud-source-manager';
import { analyzeMediaCompatibility } from './media-compatibility';
import type {
  EyeOrder,
  LocalisConfig,
  MediaItem,
  MediaKind,
  Projection,
  PublicMediaItem,
  StereoLayout,
  SubtitleTrack,
} from './types';

const execFileAsync = promisify(execFile);
const mediaExtensions = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.vob', '.3gp', '.3g2', '.mxf', '.ogv', '.divx', '.f4v', '.asf', '.rm', '.rmvb',
  '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.alac', '.wav', '.ogg', '.opus', '.ape', '.wma',
  '.mka', '.aiff', '.aif', '.ac3', '.eac3', '.dts', '.mp2', '.amr',
]);
const subtitleExtensions = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const directVideoExtensions = new Set(['.mp4', '.m4v', '.mov']);
const directAudioExtensions = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac']);

interface ProbeStream {
  index: number;
  codec_name?: string;
  codec_type?: 'video' | 'audio' | 'subtitle';
  profile?: string;
  level?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  side_data_list?: Array<{ side_data_type?: string }>;
  sample_aspect_ratio?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  channels?: number;
  tags?: { language?: string; title?: string };
  disposition?: { attached_pic?: number };
}

interface ProbeResult {
  format?: { duration?: string; format_name?: string };
  streams?: ProbeStream[];
}

interface MediaOverride {
  projection?: Projection;
  stereo?: StereoLayout;
  eyeOrder?: EyeOrder;
  yawOffset?: number;
  title?: string;
}

export class MediaDirectoryValidationError extends Error {}

function stableId(filePath: string) {
  return createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 24);
}

function parseFrameRate(value?: string) {
  if (!value) return undefined;
  const [numerator, denominator = 1] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function inferProjection(fileName: string): Pick<MediaItem, 'projection' | 'stereo' | 'eyeOrder' | 'yawOffset'> {
  const normalized = fileName.toLowerCase().replace(/[._-]+/g, ' ');
  const projection: Projection = /(^|\s)(vr\s*)?180(\s|$)/.test(normalized)
    ? 'equirect180'
    : /(^|\s)(vr\s*)?360(\s|$)/.test(normalized)
      ? 'equirect360'
      : 'flat';
  const stereo: StereoLayout = /(^|\s)(sbs|side\s*by\s*side)(\s|$)/.test(normalized)
    ? 'sbs'
    : /(^|\s)(tb|ou|top\s*bottom|over\s*under)(\s|$)/.test(normalized)
      ? 'tb'
      : 'mono';
  const eyeOrder: EyeOrder = /(^|\s)(rl|right\s*left)(\s|$)/.test(normalized) ? 'rl' : 'lr';
  return { projection, stereo, eyeOrder, yawOffset: 0 };
}

function publicItem(item: MediaItem): PublicMediaItem {
  const { path: _path, libraryRoot: _root, sourceId: _sourceId, remoteFileId: _remoteFileId, ...safe } = item;
  return {
    ...safe,
    subtitleTracks: item.subtitleTracks.map(({ externalPath: _externalPath, ...track }) => track),
    streamUrl: `/api/media/${item.id}/stream`,
    posterUrl: item.kind === 'video' && item.sourceType === 'local' ? `/api/media/${item.id}/poster` : undefined,
    hlsUrl: `/api/media/${item.id}/hls/off/index.m3u8`,
  };
}

export class MediaLibrary {
  readonly items = new Map<string, MediaItem>();
  private overrides = new Map<string, MediaOverride>();
  private scanPromise?: Promise<void>;

  constructor(private readonly config: LocalisConfig, private readonly clouds?: CloudSourceManager) {}

  async initialize() {
    try {
      const stored = JSON.parse(await readFile(path.join(this.config.dataDir, 'overrides.json'), 'utf8')) as Record<string, MediaOverride>;
      this.overrides = new Map(Object.entries(stored));
    } catch {
      // Overrides are optional.
    }
    if (this.clouds) await this.clouds.refreshAll();
    await this.scan();
  }

  list(): PublicMediaItem[] {
    return [...this.items.values()]
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .map(publicItem);
  }

  get(id: string) {
    return this.items.get(id);
  }

  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan().finally(() => { this.scanPromise = undefined; });
    return this.scanPromise;
  }

  async refreshClouds() {
    if (this.clouds) await this.clouds.refreshAll();
    await this.scan();
  }

  private async performScan() {
    const files: Array<{ path: string; root: string }> = [];
    for (const root of this.config.mediaDirs) await this.walk(root, root, files);

    const next = new Map<string, MediaItem>();
    const workers = Array.from({ length: Math.min(3, Math.max(1, files.length)) }, async (_, worker) => {
      for (let index = worker; index < files.length; index += Math.min(3, Math.max(1, files.length))) {
        const entry = files[index];
        try {
          const item = await this.probe(entry.path, entry.root);
          next.set(item.id, item);
        } catch (error) {
          console.warn(`[Localis] 无法读取媒体：${entry.path}`, error instanceof Error ? error.message : error);
        }
      }
    });
    await Promise.all(workers);
    if (this.clouds) {
      for (const file of this.clouds.files()) {
        const item = this.cloudItem(file);
        next.set(item.id, item);
      }
    }
    this.items.clear();
    for (const [id, item] of next) this.items.set(id, item);
  }

  private cloudItem(file: CloudRemoteFile): MediaItem {
    const extension = path.extname(file.fileName).toLowerCase();
    const kind: MediaKind = directAudioExtensions.has(extension) || ['.m4b', '.alac', '.ape', '.wma', '.mka', '.aiff', '.aif', '.ac3', '.eac3', '.dts', '.mp2', '.amr'].includes(extension)
      ? 'audio'
      : 'video';
    const id = stableId(`cloud:${file.sourceId}:${file.id}`);
    const inferred = inferProjection(path.basename(file.fileName, extension));
    const override = this.overrides.get(id) ?? {};
    return {
      id,
      kind,
      title: override.title || path.basename(file.fileName, extension).replace(/[._]+/g, ' '),
      fileName: file.fileName,
      relativePath: `${file.sourceName}/${file.relativePath}`,
      extension,
      size: file.size,
      modifiedAt: file.modifiedAt,
      duration: 0,
      projection: override.projection ?? inferred.projection,
      stereo: override.stereo ?? inferred.stereo,
      eyeOrder: override.eyeOrder ?? inferred.eyeOrder,
      yawOffset: override.yawOffset ?? inferred.yawOffset,
      audioTracks: [],
      subtitleTracks: [],
      directPlay: kind === 'video' ? directVideoExtensions.has(extension) : directAudioExtensions.has(extension),
      compatibilityMode: kind === 'video' && directVideoExtensions.has(extension) ? 'direct' : kind === 'audio' && directAudioExtensions.has(extension) ? 'direct' : kind === 'audio' ? 'audio-transcode' : 'video-transcode',
      compatibilityReason: '云盘文件将在首次播放并缓存到电脑后完成编码与 HDR 检测。',
      sourceType: file.provider === 'baidu' ? 'baidu' : 'webdav',
      sourceId: file.sourceId,
      remoteFileId: file.id,
      path: `cloud:${file.id}`,
      libraryRoot: file.sourceName,
    };
  }

  private async walk(root: string, current: string, files: Array<{ path: string; root: string }>) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.walk(root, fullPath, files);
      else if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) files.push({ path: fullPath, root });
    }
  }

  private async probe(filePath: string, libraryRoot: string): Promise<MediaItem> {
    const fileStat = await stat(filePath);
    const { stdout } = await execFileAsync(this.config.ffprobePath, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath,
    ], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const probe = JSON.parse(stdout) as ProbeResult;
    const streams = probe.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!video && !audio) throw new Error('文件中没有可播放的媒体轨道');

    const id = stableId(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const inferred = inferProjection(path.basename(filePath, extension));
    const override = this.overrides.get(id) ?? {};
    const externalTracks = await this.findExternalSubtitles(filePath);
    const embeddedTracks: SubtitleTrack[] = streams
      .filter((stream) => stream.codec_type === 'subtitle')
      .map((stream) => ({
        index: stream.index,
        codec: stream.codec_name || 'unknown',
        language: stream.tags?.language,
        title: stream.tags?.title,
        source: 'embedded',
      }));
    const kind: MediaKind = video ? 'video' : 'audio';
    const compatibility = analyzeMediaCompatibility({ kind, fileName: filePath, video, audio });
    const title = override.title || path.basename(filePath, extension).replace(/[._]+/g, ' ');

    return {
      id,
      kind,
      title,
      fileName: path.basename(filePath),
      relativePath: path.relative(libraryRoot, filePath),
      extension,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      duration: Number(probe.format?.duration || 0),
      width: video?.width,
      height: video?.height,
      frameRate: parseFrameRate(video?.avg_frame_rate),
      videoCodec: video?.codec_name,
      videoProfile: video?.profile,
      videoLevel: video?.level,
      pixelFormat: video?.pix_fmt,
      bitDepth: compatibility.bitDepth,
      dynamicRange: compatibility.dynamicRange,
      colorPrimaries: compatibility.colorPrimaries,
      colorTransfer: compatibility.colorTransfer,
      colorSpace: compatibility.colorSpace,
      colorRange: compatibility.colorRange,
      sampleAspectRatio: video?.sample_aspect_ratio,
      audioCodec: audio?.codec_name,
      container: probe.format?.format_name,
      projection: override.projection ?? inferred.projection,
      stereo: override.stereo ?? inferred.stereo,
      eyeOrder: override.eyeOrder ?? inferred.eyeOrder,
      yawOffset: override.yawOffset ?? inferred.yawOffset,
      audioTracks: streams.filter((stream) => stream.codec_type === 'audio').map((stream) => ({
        index: stream.index,
        codec: stream.codec_name || 'unknown',
        language: stream.tags?.language,
        title: stream.tags?.title,
        channels: stream.channels,
      })),
      subtitleTracks: [...embeddedTracks, ...externalTracks],
      directPlay: compatibility.directPlay,
      compatibilityMode: compatibility.compatibilityMode,
      compatibilityReason: compatibility.compatibilityReason,
      sourceType: 'local',
      path: filePath,
      libraryRoot,
    };
  }

  private async findExternalSubtitles(mediaPath: string): Promise<SubtitleTrack[]> {
    const directory = path.dirname(mediaPath);
    const baseName = path.basename(mediaPath, path.extname(mediaPath)).toLowerCase();
    const result: SubtitleTrack[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const subtitleBase = path.basename(entry.name, extension).toLowerCase();
      if (!subtitleExtensions.has(extension) || (subtitleBase !== baseName && !subtitleBase.startsWith(`${baseName}.`))) continue;
      const language = subtitleBase === baseName ? undefined : subtitleBase.slice(baseName.length + 1);
      result.push({
        index: 1000 + result.length,
        codec: extension.slice(1),
        language,
        source: 'external',
        externalPath: path.join(directory, entry.name),
      });
    }
    return result;
  }

  async update(id: string, patch: MediaOverride) {
    const item = this.items.get(id);
    if (!item) return undefined;
    const next: MediaOverride = { ...this.overrides.get(id), ...patch };
    this.overrides.set(id, next);
    Object.assign(item, next);
    await writeFile(path.join(this.config.dataDir, 'overrides.json'), JSON.stringify(Object.fromEntries(this.overrides), null, 2));
    return publicItem(item);
  }

  async ensurePoster(item: MediaItem) {
    if (item.kind !== 'video') return undefined;
    const posterDir = path.join(this.config.cacheDir, 'posters');
    const posterVersion = createHash('sha256')
      .update([item.id, item.size, item.modifiedAt].join('|'))
      .digest('hex')
      .slice(0, 16);
    const posterPath = path.join(posterDir, `${item.id}-${posterVersion}.jpg`);
    await mkdir(posterDir, { recursive: true });
    try {
      await access(posterPath);
      return posterPath;
    } catch {
      const seek = Math.max(0, Math.min(item.duration * 0.12, 30));
      await execFileAsync(this.config.ffmpegPath, [
        '-y', '-ss', String(seek), '-i', item.path, '-frames:v', '1',
        '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease', '-q:v', '3', posterPath,
      ], { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      return posterPath;
    }
  }

  async validateDirectory(directory: string) {
    const normalized = directory.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? '');
    if (!normalized.trim()) throw new MediaDirectoryValidationError('请选择一个媒体文件夹。');
    const resolved = path.resolve(normalized);
    let info;
    try {
      info = await lstat(resolved);
    } catch {
      throw new MediaDirectoryValidationError('找不到这个文件夹，请重新选择。');
    }
    if (info.isSymbolicLink()) throw new MediaDirectoryValidationError('必须选择真实文件夹，不能使用符号链接。');
    if (!info.isDirectory()) throw new MediaDirectoryValidationError('请选择文件夹，而不是单个媒体文件。');
    return resolved;
  }

  stream(item: MediaItem, options?: { start?: number; end?: number }) {
    return createReadStream(item.path, options);
  }
}
