import path from 'node:path';
import type { CompatibilityMode, DynamicRange, MediaKind } from './types';

export interface CompatibilityProbeStream {
  codec_name?: string;
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
}

export interface MediaCompatibility {
  directPlay: boolean;
  compatibilityMode: CompatibilityMode;
  compatibilityReason: string;
  dynamicRange?: DynamicRange;
  bitDepth?: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
}

const directVideoExtensions = new Set(['.mp4', '.m4v', '.mov']);
const directAudioExtensions = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac']);
const browserSafeProfiles = new Set(['Constrained Baseline', 'Baseline', 'Main', 'High']);

// ffprobe does not always populate bits_per_raw_sample. Keep this allowlist
// deliberately explicit: an unfamiliar pixel format is not evidence of 8-bit
// video and must take the conservative compatibility path.
const knownEightBitPixelFormats = new Set([
  '0bgr', '0rgb', 'abgr', 'argb', 'bgr0', 'bgra', 'rgba', 'rgb0',
  'bgr24', 'rgb24', 'bgr8', 'rgb8',
  'gray', 'gray8', 'ya8', 'pal8', 'monob', 'monow',
  'nv12', 'nv21', 'nv16', 'nv24', 'nv42',
  'uyvy422', 'yuyv422', 'yvyu422', 'uyyvyy411',
  'yuv410p', 'yuv411p', 'yuv420p', 'yuv422p', 'yuv440p', 'yuv444p',
  'yuvj411p', 'yuvj420p', 'yuvj422p', 'yuvj440p', 'yuvj444p',
  'yuva420p', 'yuva422p', 'yuva444p', 'gbrp', 'gbrap',
  'v308', 'v408',
]);

function packedPixelFormatBitDepth(pixelFormat: string) {
  const semiPlanar = pixelFormat.match(/^p[024]1(0|2|6)(?:le|be)?$/);
  if (semiPlanar) return semiPlanar[1] === '0' ? 10 : semiPlanar[1] === '2' ? 12 : 16;

  const packedYuv = pixelFormat.match(/^y(?:2|4)1(0|2|6)(?:le|be)?$/);
  if (packedYuv) return packedYuv[1] === '0' ? 10 : packedYuv[1] === '2' ? 12 : 16;

  if (/^(?:v210|v410)(?:le|be)?$/.test(pixelFormat)) return 10;
  if (/^xv30(?:le|be)?$/.test(pixelFormat)) return 10;
  if (/^xv36(?:le|be)?$/.test(pixelFormat)) return 12;
  if (/^xv48(?:le|be)?$/.test(pixelFormat)) return 16;
  if (/^x2(?:rgb|bgr)10(?:le|be)?$/.test(pixelFormat)) return 10;
  if (/^(?:r210|r10k)(?:le|be)?$/.test(pixelFormat)) return 10;
  if (/^(?:rgb|bgr)48(?:le|be)?$/.test(pixelFormat)) return 16;
  if (/^(?:rgba|bgra|argb|abgr|ayuv)64(?:le|be)?$/.test(pixelFormat)) return 16;
  if (/^y416(?:le|be)?$/.test(pixelFormat)) return 16;
  return undefined;
}

export function pixelFormatBitDepth(stream?: CompatibilityProbeStream) {
  const explicit = [stream?.bits_per_raw_sample, stream?.bits_per_sample]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  if (explicit) return explicit;
  const pixelFormat = stream?.pix_fmt?.toLowerCase() || '';
  const match = pixelFormat.match(/(?:p|gray|ya|xyz)(9|10|12|14|16)(?:le|be)?$/);
  if (match) return Number(match[1]);
  if (/^(?:gbrap?|gray)f32(?:le|be)?$/.test(pixelFormat)) return 32;
  const packedDepth = packedPixelFormatBitDepth(pixelFormat);
  if (packedDepth) return packedDepth;
  return knownEightBitPixelFormats.has(pixelFormat) ? 8 : undefined;
}

const missingColorMetadata = new Set(['', 'unknown', 'unspecified', 'reserved', 'n/a']);

function normalizedColorMetadata(value?: string) {
  const normalized = value?.trim().toLowerCase() || '';
  return missingColorMetadata.has(normalized) ? undefined : normalized;
}

const sdrColorPairs: Record<string, ReadonlySet<string>> = {
  bt709: new Set(['bt709']),
  'iec61966-2-1': new Set(['bt709', 'jedec-p22']),
  'iec61966-2-4': new Set(['bt709']),
  bt470m: new Set(['bt470m']),
  gamma22: new Set(['bt470m']),
  bt470bg: new Set(['bt470bg']),
  gamma28: new Set(['bt470bg']),
  smpte170m: new Set(['smpte170m']),
  smpte240m: new Set(['smpte240m']),
  'bt2020-10': new Set(['bt2020']),
  'bt2020-12': new Set(['bt2020']),
};

function hasExplicitSdrColorPair(transfer?: string, primaries?: string) {
  if (!transfer || !primaries) return false;
  return sdrColorPairs[transfer]?.has(primaries) === true;
}

export function detectDynamicRange(stream?: CompatibilityProbeStream): DynamicRange {
  if (!stream) return 'unknown';
  const sideData = (stream.side_data_list || []).map((entry) => entry.side_data_type?.toLowerCase() || '');
  if (sideData.some((type) => type.includes('dovi') || type.includes('dolby vision'))) return 'dolby-vision';
  const transfer = normalizedColorMetadata(stream.color_transfer);
  const primaries = normalizedColorMetadata(stream.color_primaries);
  const matrix = normalizedColorMetadata(stream.color_space);
  const conflictsWithBt2020Hdr = Boolean(
    (primaries && primaries !== 'bt2020')
    || (matrix && matrix !== 'bt2020nc'),
  );
  // Explicit HDR transfer functions win over ancillary mastering metadata: HLG
  // commonly carries mastering side data too and must never be fed through a
  // PQ curve. Mastering metadata alone, or paired with an SDR transfer, does not
  // prove an HDR EOTF, so fail closed instead of guessing a tone-map curve.
  if (transfer === 'smpte2084') return conflictsWithBt2020Hdr ? 'unknown' : 'hdr10';
  if (transfer === 'arib-std-b67') return conflictsWithBt2020Hdr ? 'unknown' : 'hlg';
  if (sideData.some((type) => type.includes('mastering display metadata'))) return 'unknown';

  const bitDepth = pixelFormatBitDepth(stream);
  if (!bitDepth) return 'unknown';
  if (bitDepth > 8) {
    return hasExplicitSdrColorPair(transfer, primaries) ? 'sdr10' : 'unknown';
  }
  return 'sdr';
}

export function isHdrDynamicRange(value?: DynamicRange) {
  return value === 'hdr10' || value === 'hlg' || value === 'dolby-vision';
}

export function analyzeMediaCompatibility(options: {
  kind: MediaKind;
  fileName: string;
  video?: CompatibilityProbeStream;
  audio?: CompatibilityProbeStream;
}): MediaCompatibility {
  const extension = path.extname(options.fileName).toLowerCase();
  if (options.kind === 'audio') {
    const directPlay = directAudioExtensions.has(extension);
    return {
      directPlay,
      compatibilityMode: directPlay ? 'direct' : 'audio-transcode',
      compatibilityReason: directPlay
        ? '浏览器可直接读取此音频格式。'
        : '浏览器兼容性不稳定，Localis 将在电脑端转换为 AAC。',
    };
  }

  const { video, audio } = options;
  const dynamicRange = detectDynamicRange(video);
  const bitDepth = pixelFormatBitDepth(video);
  const color = {
    dynamicRange,
    bitDepth,
    colorPrimaries: video?.color_primaries,
    colorTransfer: video?.color_transfer,
    colorSpace: video?.color_space,
    colorRange: video?.color_range,
  };
  const browserSafeH264 = video?.codec_name === 'h264'
    && video.pix_fmt === 'yuv420p'
    && (!video.profile || browserSafeProfiles.has(video.profile))
    && (!video.level || video.level <= 52);
  const browserSafeAudio = !audio || audio.codec_name === 'aac' || audio.codec_name === 'mp3';

  if (isHdrDynamicRange(dynamicRange)) {
    const label = dynamicRange === 'dolby-vision' ? '杜比视界' : dynamicRange === 'hlg' ? 'HLG' : 'HDR10';
    const explicitDolbyBase = dynamicRange === 'dolby-vision'
      && (normalizedColorMetadata(video?.color_transfer) === 'smpte2084'
        || normalizedColorMetadata(video?.color_transfer) === 'arib-std-b67');
    return {
      ...color,
      directPlay: false,
      compatibilityMode: dynamicRange === 'dolby-vision' && !explicitDolbyBase ? 'video-transcode' : 'tone-map',
      compatibilityReason: dynamicRange === 'dolby-vision'
        ? explicitDolbyBase
          ? '杜比视界不受 WebXR 端到端保证；兼容流仅按明确的基底传递函数尝试映射到 8-bit BT.709，不执行 Dolby Vision 动态元数据重建，也不保证色彩准确。'
          : '杜比视界基底传递函数不明确；Localis 不会猜测 PQ/HLG，只生成 8-bit H.264 色彩未知兼容流，不保证亮度、动态范围或色彩正确。'
        : `${label} 原片的 WebXR HDR 输出无法可靠保证；兼容流会在电脑端映射为 SDR BT.709，避免发灰或过曝。`,
    };
  }
  if (dynamicRange === 'sdr10') {
    return {
      ...color,
      directPlay: false,
      compatibilityMode: 'video-transcode',
      compatibilityReason: `${bitDepth || 10}-bit SDR 原片需要降为 8-bit H.264 兼容流；电脑端会使用高质量抖动，尽量减少色带。`,
    };
  }
  if (dynamicRange === 'unknown') {
    const depthLabel = bitDepth && bitDepth > 8 ? `${bitDepth}-bit ` : '';
    return {
      ...color,
      directPlay: false,
      compatibilityMode: 'video-transcode',
      compatibilityReason: `${depthLabel}源片的像素格式、位深、色彩传递函数或原色信息缺失、未知或互相冲突，无法可靠判定 HDR/SDR；Localis 将保守生成 8-bit H.264 兼容流，不执行猜测式 HDR 映射。`,
    };
  }
  if (!directVideoExtensions.has(extension)) {
    return {
      ...color,
      directPlay: false,
      compatibilityMode: browserSafeH264 && browserSafeAudio ? 'remux' : browserSafeH264 ? 'audio-transcode' : 'video-transcode',
      compatibilityReason: browserSafeH264
        ? '视频编码可保留，Localis 将重新封装为浏览器兼容 HLS。'
        : '容器或视频编码不适合浏览器直连，Localis 将在电脑端生成兼容流。',
    };
  }
  if (!browserSafeH264) {
    return {
      ...color,
      directPlay: false,
      compatibilityMode: 'video-transcode',
      compatibilityReason: video?.codec_name === 'h264'
        ? `H.264 ${video.profile || ''} ${video.pix_fmt || ''}`.trim() + ' 不在浏览器安全范围内，将生成 8-bit H.264 兼容流。'
        : `${(video?.codec_name || '未知视频编码').toUpperCase()} 需要由电脑转换为 H.264 兼容流。`,
    };
  }
  if (!browserSafeAudio) {
    return {
      ...color,
      directPlay: false,
      compatibilityMode: 'audio-transcode',
      compatibilityReason: `${(audio?.codec_name || '此音轨').toUpperCase()} 不适合浏览器直连；视频保持原样，仅将音频转换为 AAC。`,
    };
  }
  return {
    ...color,
    directPlay: true,
    compatibilityMode: 'direct',
    compatibilityReason: '浏览器安全的 H.264 8-bit MP4，可使用原文件直连。',
  };
}
