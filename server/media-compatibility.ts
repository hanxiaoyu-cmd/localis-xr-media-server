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

export function pixelFormatBitDepth(stream?: CompatibilityProbeStream) {
  const explicit = Number(stream?.bits_per_raw_sample || stream?.bits_per_sample || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const pixelFormat = stream?.pix_fmt?.toLowerCase() || '';
  const match = pixelFormat.match(/(?:p|yuv\d+p)(9|10|12|14|16)(?:le|be)?$/);
  if (match) return Number(match[1]);
  if (/^(?:p010|p210)/.test(pixelFormat)) return 10;
  return pixelFormat ? 8 : undefined;
}

export function detectDynamicRange(stream?: CompatibilityProbeStream): DynamicRange | undefined {
  if (!stream) return undefined;
  const sideData = (stream.side_data_list || []).map((entry) => entry.side_data_type?.toLowerCase() || '');
  if (sideData.some((type) => type.includes('dovi') || type.includes('dolby vision'))) return 'dolby-vision';
  const transfer = stream.color_transfer?.toLowerCase();
  if (transfer === 'smpte2084' || sideData.some((type) => type.includes('mastering display metadata'))) return 'hdr10';
  if (transfer === 'arib-std-b67') return 'hlg';
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
    return {
      ...color,
      directPlay: false,
      compatibilityMode: 'tone-map',
      compatibilityReason: `${label} 原片的 WebXR HDR 输出无法可靠保证；兼容流会在电脑端映射为 SDR BT.709，避免发灰或过曝。`,
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
