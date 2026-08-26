import type { MediaCompatibility } from '@/server/media-compatibility';
import type { ServerSuperResolutionLevel, ServerSuperResolutionPlan } from '@/server/super-resolution';

export type PlaybackTransport = 'direct' | 'hls';

export type PlaybackPathKind =
  | 'original-direct'
  | 'original-hdr-attempt'
  | 'original-color-attempt'
  | 'video-copy'
  | 'video-copy-audio-compatible'
  | 'h264-compatible-transcode'
  | 'hdr-to-sdr'
  | 'high-bit-depth-to-sdr8'
  | 'unknown-color-to-8bit'
  | 'dolby-vision-compatibility'
  | 'standard-enhancement'
  | 'high-enhancement'
  | 'ultra-enhancement'
  | 'ai-enhancement';

export type PlaybackPathState = 'active' | 'requested' | 'processing' | 'ready' | 'failed' | 'unavailable';

export type PlaybackPresentationAssurance = 'unverified' | 'guided-user' | 'instrumented' | 'vendor';

type PlaybackDynamicRange = NonNullable<MediaCompatibility['dynamicRange']> | 'sdr10' | 'unknown';

export type PlaybackCompatibilityInfo = Omit<Pick<
  MediaCompatibility,
  'directPlay' | 'compatibilityMode' | 'compatibilityReason' | 'dynamicRange' | 'bitDepth' | 'colorTransfer'
>, 'dynamicRange'> & {
  /** `sdr10` and `unknown` are accepted while older server payloads are being migrated. */
  dynamicRange?: PlaybackDynamicRange;
  /** Used to distinguish a true HLS remux from the MP3-to-AAC compatibility path. */
  audioCodec?: string;
};

export interface PlaybackServerEnhancementStatus {
  state?: string;
  mode?: string;
  forcedCompatibility?: boolean;
  generationState?: string;
  enhancementBackend?: string;
  error?: string;
  plan?: Pick<ServerSuperResolutionPlan, 'available' | 'activeMode' | 'reason'>;
}

export interface PlaybackPathInput {
  compatibility: PlaybackCompatibilityInfo;
  transport: PlaybackTransport;
  superResolution: ServerSuperResolutionLevel;
  serverEnhancement?: PlaybackServerEnhancementStatus;
  /**
   * Evidence for the complete decode -> video texture -> WebXR display path.
   * `guided-user` records a visual check, while only instrumented/vendor
   * evidence is strong enough for the UI to call the presentation verified.
   */
  presentationAssurance?: PlaybackPresentationAssurance;
}

export interface PlaybackPathIdentity {
  kind: PlaybackPathKind;
  label: string;
  description: string;
  state: PlaybackPathState;
  stateLabel: string;
  presentationAssurance?: PlaybackPresentationAssurance;
  presentationAssuranceLabel?: string;
  presentationVerified?: boolean;
}

const enhancementIdentity: Record<Exclude<ServerSuperResolutionLevel, 'off'>, {
  kind: PlaybackPathKind;
  label: string;
  defaultBackend: string;
}> = {
  standard: { kind: 'standard-enhancement', label: '标准增强', defaultBackend: 'FFmpeg zscale + CAS' },
  high: { kind: 'high-enhancement', label: '高增强', defaultBackend: 'FFmpeg zscale + CAS' },
  ultra: { kind: 'ultra-enhancement', label: '极致增强', defaultBackend: 'FFmpeg zscale + CAS' },
  ai: { kind: 'ai-enhancement', label: 'AI 增强', defaultBackend: 'Real-ESRGAN NCNN Vulkan' },
};

const stateLabels: Record<PlaybackPathState, string> = {
  active: '当前链路',
  requested: '准备中',
  processing: '生成中',
  ready: '已就绪',
  failed: '生成失败',
  unavailable: '不可用',
};

function result(
  kind: PlaybackPathKind,
  label: string,
  description: string,
  state: PlaybackPathState = 'active',
): PlaybackPathIdentity {
  return { kind, label, description, state, stateLabel: stateLabels[state] };
}

function dynamicRangeLabel(compatibility: PlaybackCompatibilityInfo) {
  const range = compatibility.dynamicRange === 'dolby-vision' ? '杜比视界'
    : compatibility.dynamicRange === 'hdr10' ? 'HDR10'
      : compatibility.dynamicRange === 'hlg' ? 'HLG'
        : compatibility.dynamicRange === 'sdr10' ? '高位深 SDR'
          : compatibility.dynamicRange === 'unknown' || compatibility.dynamicRange === undefined
            ? '未知色彩范围'
            : 'SDR';
  return compatibility.bitDepth ? `${range} ${compatibility.bitDepth}-bit` : range;
}

function isHdr(compatibility: PlaybackCompatibilityInfo) {
  return compatibility.dynamicRange === 'hdr10'
    || compatibility.dynamicRange === 'hlg'
    || compatibility.dynamicRange === 'dolby-vision'
    || (compatibility.compatibilityMode === 'tone-map'
      && compatibility.dynamicRange !== 'sdr10'
      && compatibility.dynamicRange !== 'unknown');
}

function isDolbyVision(compatibility: PlaybackCompatibilityInfo) {
  return compatibility.dynamicRange === 'dolby-vision';
}

function hasKnownHdrTransfer(compatibility: PlaybackCompatibilityInfo) {
  if (compatibility.dynamicRange === 'hdr10' || compatibility.dynamicRange === 'hlg') return true;
  const transfer = compatibility.colorTransfer?.trim().toLowerCase();
  return isDolbyVision(compatibility)
    && (transfer === 'smpte2084' || transfer === 'pq' || transfer === 'arib-std-b67' || transfer === 'hlg');
}

function isHighBitDepthSdr(compatibility: PlaybackCompatibilityInfo) {
  return compatibility.dynamicRange === 'sdr10'
    || (compatibility.dynamicRange === 'sdr' && Boolean(compatibility.bitDepth && compatibility.bitDepth > 8));
}

function hasUnknownColorMetadata(compatibility: PlaybackCompatibilityInfo) {
  return compatibility.dynamicRange === 'unknown' || compatibility.dynamicRange === undefined;
}

function sourceDepthLabel(compatibility: PlaybackCompatibilityInfo) {
  return compatibility.bitDepth && compatibility.bitDepth > 8
    ? `${compatibility.bitDepth}-bit`
    : '10/12-bit';
}

const assuranceCopy: Record<PlaybackPresentationAssurance, {
  label: string;
  verified: boolean;
  description: string;
}> = {
  unverified: {
    label: '设备链路未认证',
    verified: false,
    description: '当前设备展示链路未经认证；这只表示原片已交给浏览器，不宣称 HDR、位深或色彩已正确呈现。',
  },
  'guided-user': {
    label: '用户引导确认',
    verified: false,
    description: '已完成用户引导观感确认，但未经仪器或厂商认证，不称为已验证的 HDR/10-bit 输出。',
  },
  instrumented: {
    label: '仪器验证',
    verified: true,
    description: '当前设备组合已有仪器测试记录，可标记为已验证呈现。',
  },
  vendor: {
    label: '厂商认证',
    verified: true,
    description: '当前设备组合已有厂商认证记录，可标记为已验证呈现。',
  },
};

function withPresentationAssurance(
  identity: PlaybackPathIdentity,
  assurance: PlaybackPresentationAssurance = 'unverified',
): PlaybackPathIdentity {
  const copy = assuranceCopy[assurance];
  return {
    ...identity,
    description: `${identity.description} ${copy.description}`,
    presentationAssurance: assurance,
    presentationAssuranceLabel: copy.label,
    presentationVerified: copy.verified,
  };
}

function serverPathState(status?: PlaybackServerEnhancementStatus): PlaybackPathState {
  if (status?.state === 'unavailable' || status?.plan?.available === false) return 'unavailable';
  if (status?.state === 'failed' || status?.generationState === 'failed') return 'failed';
  if (status?.state === 'ready' || status?.generationState === 'complete') return 'ready';
  if (status?.state === 'running' || status?.generationState === 'processing') {
    return 'processing';
  }
  return 'requested';
}

function enhancementAction(status?: PlaybackServerEnhancementStatus) {
  return status?.plan?.activeMode === 'upscale' ? '放大与锐化'
    : status?.plan?.activeMode === 'sharpen' ? '原尺寸锐化'
      : status?.plan?.activeMode === 'downscale' ? '兼容缩放'
        : '增强处理';
}

function describeEnhancement(input: PlaybackPathInput): PlaybackPathIdentity {
  const level = input.superResolution as Exclude<ServerSuperResolutionLevel, 'off'>;
  const identity = enhancementIdentity[level];
  const status = input.serverEnhancement;
  const state = serverPathState(status);
  const reason = status?.error || status?.plan?.reason;
  if (state === 'unavailable') {
    return result(identity.kind, identity.label, `请求的${identity.label}不可用：${reason || '服务器无法安全生成该档位。'}`, state);
  }
  if (state === 'failed') {
    return result(identity.kind, identity.label, `${identity.label}生成失败：${reason || '服务器端处理未完成。'}`, state);
  }

  const backend = status?.enhancementBackend || identity.defaultBackend;
  const operation = level === 'ai' ? 'AI 重建' : enhancementAction(status);
  const colorSuffix = hasUnknownColorMetadata(input.compatibility)
    ? '；源色彩元数据不完整，因此只输出 8-bit H.264 色彩未知兼容流，不保证亮度、动态范围或色彩正确'
    : isDolbyVision(input.compatibility)
      ? hasKnownHdrTransfer(input.compatibility)
        ? `；杜比视界仅按明确的基底传递函数尝试映射到 8-bit BT.709，不执行 Dolby Vision 重建，也不保证色彩准确；${sourceDepthLabel(input.compatibility)} 降位深使用抖动`
        : '；杜比视界基底传递函数不明确，只生成 8-bit H.264 色彩未知兼容流，不保证亮度、动态范围或色彩正确'
      : isHdr(input.compatibility)
      ? `；HDR 同时映射为 SDR BT.709，${sourceDepthLabel(input.compatibility)} → 8-bit SDR 会产生不可逆位深损失，并使用抖动减轻色带`
      : isHighBitDepthSdr(input.compatibility)
        ? `；源 ${sourceDepthLabel(input.compatibility)} SDR 使用抖动降为 8-bit SDR，存在不可逆位深损失`
        : '';
  return result(
    identity.kind,
    identity.label,
    `电脑端使用 ${backend} 执行${operation}，输出 8-bit H.264/AAC HLS${colorSuffix}。`,
    state,
  );
}

/**
 * Describes the bytes currently selected for playback, rather than the source
 * file's theoretical capabilities. Direct transport therefore always wins
 * over a saved enhancement preference, while HLS reports every server-side
 * copy, conversion, tone-map, or enhancement step.
 */
export function describePlaybackPath(input: PlaybackPathInput): PlaybackPathIdentity {
  const { compatibility, transport, superResolution } = input;

  if (transport === 'direct') {
    if (hasUnknownColorMetadata(compatibility)) {
      return withPresentationAssurance(result(
        'original-color-attempt',
        '原始色彩实验尝试',
        `${dynamicRangeLabel(compatibility)}的原始文件直接交给浏览器；源色彩元数据不完整，因此即使设备链路有认证记录，也不宣称色彩准确。`,
      ), 'unverified');
    }
    if (isHdr(compatibility) || isHighBitDepthSdr(compatibility)) {
      return withPresentationAssurance(result(
        'original-hdr-attempt',
        '原始 HDR/10-bit 实验尝试',
        `${dynamicRangeLabel(compatibility)} 原始文件直接交给浏览器；Localis 不做色调映射或位深转换，实际呈现取决于头显、浏览器和 WebXR 合成链路。`,
      ), input.presentationAssurance);
    }
    return result(
      'original-direct',
      '原片直出',
      '浏览器直接读取原始文件；视频与音频均不经过 Localis 转码。',
    );
  }

  if (superResolution !== 'off') return describeEnhancement(input);

  const state = serverPathState(input.serverEnhancement);
  if (hasUnknownColorMetadata(compatibility)) {
    return result(
      'unknown-color-to-8bit',
      '未知色彩 → 8-bit 兼容',
      '源色彩元数据不完整；电脑端仅输出 8-bit H.264/AAC 色彩未知兼容流。该路径不保证亮度、动态范围或色彩正确，原文件不被修改。',
      state,
    );
  }
  if (isDolbyVision(compatibility)) {
    return result(
      'dolby-vision-compatibility',
      '杜比视界兼容（未认证）',
      hasKnownHdrTransfer(compatibility)
        ? `${dynamicRangeLabel(compatibility)} 仅按明确的基底传递函数尝试映射为 8-bit BT.709；Localis 不执行 Dolby Vision 动态元数据重建，使用抖动降位深，但不保证杜比视界色彩准确。原文件不被修改。`
        : `${dynamicRangeLabel(compatibility)} 的基底传递函数不明确；电脑端只生成 8-bit H.264/AAC 色彩未知兼容流，不保证亮度、动态范围或色彩正确。原文件不被修改。`,
      state,
    );
  }
  if (isHdr(compatibility)) {
    return result(
      'hdr-to-sdr',
      'HDR → SDR',
      `${dynamicRangeLabel(compatibility)} 在电脑端映射为 SDR BT.709；${sourceDepthLabel(compatibility)} → 8-bit SDR 会产生不可逆位深损失，并使用抖动减轻色带。输出为 H.264/AAC HLS，原文件不被修改。`,
      state,
    );
  }
  if (isHighBitDepthSdr(compatibility)) {
    const depth = sourceDepthLabel(compatibility);
    return result(
      'high-bit-depth-to-sdr8',
      `${depth} → 8-bit SDR`,
      `源文件为 ${depth} SDR；电脑端使用抖动降为 8-bit H.264/AAC HLS，以减轻色带，但位深信息会不可逆损失。原文件不被修改。`,
      state,
    );
  }

  if (input.serverEnhancement?.mode === 'transcode' || input.serverEnhancement?.forcedCompatibility) {
    return result(
      'h264-compatible-transcode',
      'H.264 兼容转码',
      '视频在电脑端转换为最高 4K/60 fps 的 8-bit H.264 SDR，音频兼容为 AAC 立体声，并以 HLS 传输。',
      state,
    );
  }

  const audioNeedsCompatibility = compatibility.compatibilityMode === 'audio-transcode'
    || ((compatibility.compatibilityMode === 'direct' || compatibility.compatibilityMode === 'remux')
      && Boolean(compatibility.audioCodec)
      && compatibility.audioCodec?.toLowerCase() !== 'aac');
  if (audioNeedsCompatibility) {
    return result(
      'video-copy-audio-compatible',
      '视频直拷贝 · 音频兼容',
      'H.264 视频不重新编码；音频在电脑端转换为 AAC 立体声后封装为 HLS。',
      state,
    );
  }

  if (compatibility.compatibilityMode === 'direct' || compatibility.compatibilityMode === 'remux') {
    return result(
      'video-copy',
      '视频直拷贝',
      'H.264 视频不重新编码；AAC 音频保持原样，仅重新封装为 HLS。',
      state,
    );
  }

  return result(
    'h264-compatible-transcode',
    'H.264 兼容转码',
    '视频在电脑端转换为 8-bit H.264，音频兼容为 AAC 立体声，并以 HLS 传输。',
    state,
  );
}
