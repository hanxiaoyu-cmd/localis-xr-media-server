import type { MediaItem } from './types';
import { isHdrDynamicRange } from './media-compatibility';

export type ServerSuperResolutionLevel = 'off' | 'standard' | 'high' | 'ultra' | 'ai';

export interface ServerSuperResolutionProfile {
  level: ServerSuperResolutionLevel;
  label: string;
  scale: number;
  maxLongEdge: number;
  maxPixels: number;
  sharpness: number;
  interpolation: 'spline16' | 'spline36' | 'lanczos';
  nvencCq: number;
  maxRate: string;
}

export interface ServerSuperResolutionPlan extends ServerSuperResolutionProfile {
  available: boolean;
  enabled: boolean;
  activeMode: 'off' | 'upscale' | 'sharpen' | 'downscale';
  sourceWidth?: number;
  sourceHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  outputFrameRate?: number;
  reason?: string;
}

export class ServerSuperResolutionUnavailableError extends Error {}

// H.264 Annex A, Level 5.2. Keeping the generated HLS inside these limits is
// important for hardware decoders used by visionOS and standalone headsets.
export const H264_LEVEL_52_MAX_MACROBLOCKS = 36_864;
export const H264_LEVEL_52_MAX_MACROBLOCKS_PER_SECOND = 2_073_600;
export const H264_LEVEL_52_MAX_LONG_EDGE = 4_096;
// When dimensions are missing, FFmpeg must choose the compatibility-stream
// scale at runtime. Eight megapixels leaves enough headroom for 16x16
// macroblock rounding at 60 fps for every even-sized frame up to 4096px.
const H264_LEVEL_52_UNKNOWN_SAFE_PIXELS = 8_000_000;

export const SERVER_SUPER_RESOLUTION_LEVELS = new Set<ServerSuperResolutionLevel>([
  'off',
  'standard',
  'high',
  'ultra',
  'ai',
]);

export const SERVER_SUPER_RESOLUTION_PROFILES: Record<ServerSuperResolutionLevel, ServerSuperResolutionProfile> = {
  off: { level: 'off', label: '关闭', scale: 1, maxLongEdge: 3840, maxPixels: 12_000_000, sharpness: 0, interpolation: 'spline16', nvencCq: 21, maxRate: '24M' },
  standard: { level: 'standard', label: '标准', scale: 1.25, maxLongEdge: 2560, maxPixels: 5_000_000, sharpness: 0.08, interpolation: 'spline16', nvencCq: 21, maxRate: '30M' },
  high: { level: 'high', label: '高', scale: 1.5, maxLongEdge: 3840, maxPixels: 9_000_000, sharpness: 0.14, interpolation: 'spline36', nvencCq: 19, maxRate: '45M' },
  ultra: { level: 'ultra', label: '极致', scale: 2, maxLongEdge: 4096, maxPixels: 12_000_000, sharpness: 0.2, interpolation: 'lanczos', nvencCq: 18, maxRate: '60M' },
  ai: { level: 'ai', label: 'AI 清晰', scale: 2, maxLongEdge: 4096, maxPixels: 12_000_000, sharpness: 0, interpolation: 'lanczos', nvencCq: 18, maxRate: '60M' },
};

export function isAiSuperResolutionLevel(level: ServerSuperResolutionLevel) {
  return level === 'ai';
}

export function parseServerSuperResolutionLevel(value: unknown): ServerSuperResolutionLevel {
  return SERVER_SUPER_RESOLUTION_LEVELS.has(value as ServerSuperResolutionLevel)
    ? value as ServerSuperResolutionLevel
    : 'off';
}

function alignedFloor(value: number, divisor: number) {
  return Math.max(divisor, Math.floor(value / divisor) * divisor);
}

function alignedCeil(value: number, divisor: number) {
  return Math.max(divisor, Math.ceil(value / divisor) * divisor);
}

export function isH264Level52Safe(width: number, height: number, frameRate: number) {
  if (![width, height, frameRate].every((value) => Number.isFinite(value) && value > 0)) return false;
  if (Math.max(width, height) > H264_LEVEL_52_MAX_LONG_EDGE) return false;
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return macroblocks <= H264_LEVEL_52_MAX_MACROBLOCKS
    && macroblocks * frameRate <= H264_LEVEL_52_MAX_MACROBLOCKS_PER_SECOND;
}

export function serverSuperResolutionPlan(
  item: Pick<MediaItem, 'width' | 'height' | 'sampleAspectRatio' | 'stereo' | 'frameRate'> & { projection?: MediaItem['projection'] },
  level: ServerSuperResolutionLevel,
): ServerSuperResolutionPlan {
  const profile = SERVER_SUPER_RESOLUTION_PROFILES[level];
  const sourceWidth = item.width;
  const sourceHeight = item.height;
  if (!sourceWidth || !sourceHeight) {
    return level === 'off'
      ? { ...profile, available: true, enabled: false, activeMode: 'off' }
      : {
          ...profile,
          available: false,
          enabled: false,
          activeMode: 'off',
          reason: '无法确认源视频尺寸，已拒绝生成可能超出 H.264 Level 5.2 安全范围的超分流。',
        };
  }

  const [sarNumerator, sarDenominator] = (item.sampleAspectRatio || '1:1').split(':').map(Number);
  const sar = Number.isFinite(sarNumerator) && Number.isFinite(sarDenominator) && sarDenominator > 0
    ? sarNumerator / sarDenominator
    : 1;
  const displayWidth = sourceWidth * sar;
  const displayHeight = sourceHeight;
  const longEdge = Math.max(displayWidth, displayHeight);
  const widthAlignment = item.stereo === 'sbs' || level === 'ai' ? 4 : 2;
  const heightAlignment = item.stereo === 'tb' || level === 'ai' ? 4 : 2;
  const outputFrameRate = Math.min(60, Math.max(1, item.frameRate || 60));

  if (level === 'ai' && (item.stereo !== 'mono' || item.projection === 'equirect360')) {
    return {
      ...profile,
      available: false,
      enabled: false,
      activeMode: 'off',
      sourceWidth,
      sourceHeight,
      outputFrameRate,
      reason: 'AI 清晰当前只处理单目平面或 VR180 视频；SBS/TB 与 VR360 请使用标准、高或极致档，避免眼间串色与 360° 接缝。',
    };
  }

  if (level === 'off') {
    let scale = Math.min(1, profile.maxLongEdge / longEdge);
    const plannedPixels = displayWidth * displayHeight * scale * scale;
    if (plannedPixels > profile.maxPixels) scale *= Math.sqrt(profile.maxPixels / plannedPixels);
    const dimensionsAt = (candidateScale: number) => ({
      width: alignedFloor(displayWidth * candidateScale, widthAlignment),
      height: alignedFloor(displayHeight * candidateScale, heightAlignment),
    });
    let target = dimensionsAt(scale);
    if (!isH264Level52Safe(target.width, target.height, outputFrameRate)) {
      let low = 0;
      let high = scale;
      for (let iteration = 0; iteration < 32; iteration += 1) {
        const middle = (low + high) / 2;
        const candidate = dimensionsAt(middle);
        if (isH264Level52Safe(candidate.width, candidate.height, outputFrameRate)) low = middle;
        else high = middle;
      }
      target = dimensionsAt(low);
    }
    return {
      ...profile,
      available: true,
      enabled: false,
      activeMode: 'off',
      sourceWidth,
      sourceHeight,
      outputWidth: target.width,
      outputHeight: target.height,
      outputFrameRate,
    };
  }

  // Square-pixel output must preserve both the display aspect and every coded
  // source dimension. A SAR below 1 therefore needs a proportional expansion
  // instead of quietly discarding horizontal samples during SAR normalization.
  const noDownsampleScale = Math.max(1, sourceWidth / displayWidth, sourceHeight / displayHeight);
  const minimumWidth = alignedCeil(displayWidth * noDownsampleScale, widthAlignment);
  const minimumHeight = alignedCeil(displayHeight * noDownsampleScale, heightAlignment);
  if (!isH264Level52Safe(minimumWidth, minimumHeight, outputFrameRate)) {
    return {
      ...profile,
      available: false,
      enabled: false,
      activeMode: 'off',
      sourceWidth,
      sourceHeight,
      outputWidth: minimumWidth,
      outputHeight: minimumHeight,
      outputFrameRate,
      reason: '源视频本身超过 H.264 Level 5.2 的安全尺寸或像素率；为避免降采样，未生成此超分档位。请使用原片或 HEVC。',
    };
  }

  // Profile limits bound additional pixels only. If the source is already
  // larger than a profile budget, keep it at 1x and perform sharpen-only
  // processing instead of degrading a 4K/5K source to the profile cap.
  const sourcePixels = displayWidth * displayHeight;
  const requestedScale = Math.min(
    profile.scale,
    profile.maxLongEdge / longEdge,
    Math.sqrt(profile.maxPixels / sourcePixels),
  );
  const profileScale = Math.max(noDownsampleScale, requestedScale);

  const dimensionsAt = (scale: number) => ({
    width: Math.max(minimumWidth, alignedFloor(displayWidth * scale, widthAlignment)),
    height: Math.max(minimumHeight, alignedFloor(displayHeight * scale, heightAlignment)),
  });
  let target = dimensionsAt(profileScale);
  if (!isH264Level52Safe(target.width, target.height, outputFrameRate)) {
    let low = 1;
    let high = profileScale;
    // Encoder limits include macroblock rounding, so a short binary search is
    // safer than a pixel-only formula near the Level 5.2 boundary.
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const middle = (low + high) / 2;
      const candidate = dimensionsAt(middle);
      if (isH264Level52Safe(candidate.width, candidate.height, outputFrameRate)) low = middle;
      else high = middle;
    }
    target = dimensionsAt(low);
  }
  const outputWidth = target.width;
  const outputHeight = target.height;
  const areaScale = outputWidth * outputHeight / (displayWidth * displayHeight);
  const activeMode = areaScale > 1.01 ? 'upscale' : 'sharpen';
  if (level === 'ai' && activeMode !== 'upscale') {
    return {
      ...profile,
      available: false,
      enabled: false,
      activeMode: 'off',
      sourceWidth,
      sourceHeight,
      outputWidth,
      outputHeight,
      outputFrameRate,
      reason: '源画面已达到 AI 档的输出预算；继续神经网络重建只会增加等待，不会提高可播放分辨率，请使用原片或极致档。',
    };
  }
  return {
    ...profile,
    available: true,
    enabled: true,
    activeMode,
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    outputFrameRate,
    reason: profileScale === noDownsampleScale && profile.scale > noDownsampleScale
      ? '源画面已达到或超过此档位预算，保持原尺寸并仅执行安全锐化。'
      : undefined,
  };
}

export function buildVideoFilters(
  item: Pick<MediaItem, 'width' | 'height' | 'sampleAspectRatio' | 'stereo' | 'frameRate' | 'dynamicRange'>,
  level: ServerSuperResolutionLevel,
  pixelFormat: 'yuv420p' | 'nv12',
) {
  if (level === 'ai') {
    throw new ServerSuperResolutionUnavailableError('AI 清晰必须由电脑端 Real-ESRGAN 分片流水线生成。');
  }
  const sourceFps = Math.max(1, item.frameRate || 30);
  const fps = Math.min(60, Math.max(1, item.frameRate || 60));
  const filters: string[] = [...buildHdrToSdrFilters(item)];
  if (level === 'off') {
    const plan = serverSuperResolutionPlan(item, level);
    if (plan.outputWidth && plan.outputHeight) {
      filters.push(`scale=w=${plan.outputWidth}:h=${plan.outputHeight}:flags=bicubic`);
    } else {
      const runtimeScale = `min(1,min(${H264_LEVEL_52_MAX_LONG_EDGE}/max(iw*sar\,ih),sqrt(${H264_LEVEL_52_UNKNOWN_SAFE_PIXELS}/(iw*sar*ih))))`;
      filters.push(
        `scale=w='max(2,trunc(iw*sar*${runtimeScale}/2)*2)':h='max(2,trunc(ih*${runtimeScale}/2)*2)':flags=bicubic`,
      );
    }
  } else {
    const profile = SERVER_SUPER_RESOLUTION_PROFILES[level];
    const plan = serverSuperResolutionPlan(item, level);
    if (!plan.available || !plan.outputWidth || !plan.outputHeight) {
      throw new ServerSuperResolutionUnavailableError(plan.reason || '无法安全生成电脑端超分流。');
    }
    filters.push(`zscale=w=${plan.outputWidth}:h=${plan.outputHeight}:f=${profile.interpolation}`);
    filters.push(`cas=strength=${profile.sharpness.toFixed(2)}:planes=1`);
  }
  filters.push('setsar=1');
  if (!item.frameRate) filters.push("fps='min(source_fps,60)'");
  else if (sourceFps > 60) filters.push(`fps=${fps}`);
  filters.push(`format=${pixelFormat}`);
  return { filters, fps };
}

/**
 * WebXR browsers do not expose a dependable HDR presentation path. Whenever
 * Localis has to create an 8-bit compatibility stream, convert HDR on the PC
 * instead of letting an implicit pixel-format conversion produce grey or
 * clipped output. Original-file playback remains available as an explicit
 * device-dependent attempt in the player.
 */
export function buildHdrToSdrFilters(item: Pick<MediaItem, 'dynamicRange'>) {
  if (!isHdrDynamicRange(item.dynamicRange)) return [];
  return [
    'zscale=t=linear:npl=100',
    'format=gbrpf32le',
    'tonemap=tonemap=hable:desat=0',
    'zscale=p=bt709:t=bt709:m=bt709:r=tv',
  ];
}

export function buildVideoPipeline(
  item: Pick<MediaItem, 'width' | 'height' | 'sampleAspectRatio' | 'stereo' | 'frameRate' | 'dynamicRange'> & { projection?: MediaItem['projection'] },
  level: ServerSuperResolutionLevel,
  pixelFormat: 'yuv420p' | 'nv12',
): { fps: number; filters?: string[]; filterComplex?: string; outputLabel?: string } {
  const simple = buildVideoFilters(item, level, pixelFormat);
  const plan = serverSuperResolutionPlan(item, level);
  if (level !== 'off' && (!plan.available || !plan.outputWidth || !plan.outputHeight)) {
    throw new ServerSuperResolutionUnavailableError(plan.reason || '无法安全生成电脑端超分流。');
  }
  if (!plan.outputWidth || !plan.outputHeight) return simple;

  const profile = SERVER_SUPER_RESOLUTION_PROFILES[level];
  const hdrToSdr = buildHdrToSdrFilters(item);
  const post = [
    ...(!item.frameRate ? ["fps='min(source_fps,60)'"] : item.frameRate > 60 ? [`fps=${simple.fps}`] : []),
    `format=${pixelFormat}`,
  ];
  if (item.projection === 'equirect360') {
    const stereo = item.stereo === 'mono' ? '2d' : item.stereo;
    const width = item.stereo === 'sbs' ? plan.outputWidth / 2 : plan.outputWidth;
    const height = item.stereo === 'tb' ? plan.outputHeight / 2 : plan.outputHeight;
    const interpolation = profile.interpolation === 'spline16' ? 'spline16' : 'lanczos';
    return {
      fps: simple.fps,
      filters: [
        ...hdrToSdr,
        `v360=input=equirect:output=equirect:in_stereo=${stereo}:out_stereo=${stereo}:w=${width}:h=${height}:interp=${interpolation}`,
        // Never apply a packed-frame spatial filter here. On SBS/TB it would
        // sample across the eye boundary, and on mono it would break the 360°
        // horizontal wrap seam. v360 already performs wrap-aware interpolation.
        'setsar=1',
        ...post,
      ],
    };
  }
  if (level === 'off' || item.stereo === 'mono') return simple;
  const enhance = (width: number, height: number) => [
    `zscale=w=${width}:h=${height}:f=${profile.interpolation}`,
    `cas=strength=${profile.sharpness.toFixed(2)}:planes=1`,
    'setsar=1',
  ].join(',');

  if (item.stereo === 'sbs') {
    const eyeWidth = Math.max(2, Math.floor(plan.outputWidth / 4) * 2);
    const graph = [
      `[0:v:0]${hdrToSdr.length ? `${hdrToSdr.join(',')},` : ''}split=2[sr_left_source][sr_right_source]`,
      `[sr_left_source]crop=w=iw/2:h=ih:x=0:y=0,${enhance(eyeWidth, plan.outputHeight)}[sr_left]`,
      `[sr_right_source]crop=w=iw/2:h=ih:x=iw/2:y=0,${enhance(eyeWidth, plan.outputHeight)}[sr_right]`,
      `[sr_left][sr_right]hstack=inputs=2,${post.join(',')}[sr_video]`,
    ].join(';');
    return { fps: simple.fps, filterComplex: graph, outputLabel: '[sr_video]' };
  }

  const eyeHeight = Math.max(2, Math.floor(plan.outputHeight / 4) * 2);
  const graph = [
    `[0:v:0]${hdrToSdr.length ? `${hdrToSdr.join(',')},` : ''}split=2[sr_top_source][sr_bottom_source]`,
    `[sr_top_source]crop=w=iw:h=ih/2:x=0:y=0,${enhance(plan.outputWidth, eyeHeight)}[sr_top]`,
    `[sr_bottom_source]crop=w=iw:h=ih/2:x=0:y=ih/2,${enhance(plan.outputWidth, eyeHeight)}[sr_bottom]`,
    `[sr_top][sr_bottom]vstack=inputs=2,${post.join(',')}[sr_video]`,
  ].join(';');
  return { fps: simple.fps, filterComplex: graph, outputLabel: '[sr_video]' };
}
