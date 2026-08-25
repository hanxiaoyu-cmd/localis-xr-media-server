import type { DynamicRange, MediaKind } from '../../server/types';
import {
  deviceDisplayCapabilityGrantMatchesRequest,
  type DeviceDisplayCapabilityGrant,
  type DeviceDisplayCapabilityRequest,
} from './device-display-capability';

export type CanPlayTypeResult = '' | 'maybe' | 'probably';
export type MediaPresentation = 'html-video' | 'webxr';

/**
 * The serializable subset of MediaCapabilitiesDecodingInfo used by the
 * decision function. Callers perform browser API calls and pass only their
 * results so this module stays deterministic and testable outside a browser.
 */
export interface MediaDecodingEvidence {
  supported: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
}

export interface ClientPlaybackEvidence {
  canPlayType?: CanPlayTypeResult;
  mediaCapabilities?: MediaDecodingEvidence;
  /**
   * True only when canPlayType/MediaCapabilities were queried with an RFC 6381
   * codec description that accurately represents the source profile, level,
   * bit depth and chroma layout. Generic strings such as `hvc1`, `av01` or
   * `vp09` are not exact evidence for an arbitrary source stream.
   */
  codecStringExact?: boolean;
  /** Defaults to WebXR because that is Localis' primary playback surface. */
  presentation?: MediaPresentation;
  /**
   * An in-memory capability created only after a persisted profile has passed
   * exact media, browser, origin, platform, expiry and pipeline validation.
   * A plain boolean or persisted JSON object is deliberately insufficient.
   */
  presentationGrant?: DeviceDisplayCapabilityGrant;
  /** Exact request used to resolve the grant, rechecked at point of use. */
  presentationGrantRequest?: DeviceDisplayCapabilityRequest;
}

export interface ClientMediaMetadata {
  kind: MediaKind;
  mediaId?: string;
  size?: number;
  modifiedAt?: string;
  extension?: string;
  container?: string;
  videoCodec?: string;
  videoProfile?: string;
  videoLevel?: number;
  pixelFormat?: string;
  bitDepth?: number;
  dynamicRange?: DynamicRange;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  colorRange?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  projection?: string;
  stereo?: string;
}

export type ClientMediaCapabilityReasonCode =
  | 'audio-browser-supported'
  | 'browser-probably-supported'
  | 'media-capabilities-supported'
  | 'known-safe-sdr'
  | 'device-profile-guided-original'
  | 'device-profile-verified-original'
  | 'hdr-webxr-unverified'
  | 'hdr-presentation-unverified'
  | 'high-bit-depth-webxr-unverified'
  | 'color-metadata-unverified'
  | 'dynamic-range-unknown'
  | 'video-codec-unknown'
  | 'audio-codec-unsupported'
  | 'webxr-envelope-unverified'
  | 'codec-evidence-inexact'
  | 'browser-unsupported'
  | 'decoder-unsupported'
  | 'decoder-not-smooth'
  | 'browser-evidence-insufficient';

export interface ClientMediaCapabilityDecision {
  /** The original resource is reasonable to try on this client. */
  canAttemptOriginal: boolean;
  /** A compatibility stream is required for the selected presentation path. */
  requiresServerCompatibility: boolean;
  /** The video itself must be normalized; remux/audio-only fallback is insufficient. */
  requiresForcedVideoTranscode: boolean;
  reasonCode: ClientMediaCapabilityReasonCode;
  reason: string;
}

const safeH264Profiles = new Set(['constrained baseline', 'baseline', 'main', 'high']);
const safeVideoContainers = new Set(['mp4', 'm4v', 'mov', 'quicktime']);
const safeAudioCodecs = new Set(['aac', 'mp3']);

function normalized(value?: string) {
  return value?.trim().toLowerCase();
}

function decision(
  canAttemptOriginal: boolean,
  reasonCode: ClientMediaCapabilityReasonCode,
  reason: string,
  requiresForcedVideoTranscode = false,
): ClientMediaCapabilityDecision {
  return {
    canAttemptOriginal,
    requiresServerCompatibility: !canAttemptOriginal,
    requiresForcedVideoTranscode: !canAttemptOriginal && requiresForcedVideoTranscode,
    reasonCode,
    reason,
  };
}

function effectiveDynamicRange(media: ClientMediaMetadata): DynamicRange | undefined {
  const transfer = normalized(media.colorTransfer);
  // Prefer HDR transfer metadata over a conflicting SDR label. A false SDR
  // direct-play decision is more damaging than an unnecessary compatibility
  // stream.
  if (transfer === 'smpte2084' || transfer === 'pq') return 'hdr10';
  if (transfer === 'arib-std-b67' || transfer === 'hlg') return 'hlg';
  if (media.dynamicRange === 'sdr' && media.bitDepth && media.bitDepth > 8) return 'sdr10';
  return media.dynamicRange;
}

function applicablePresentationGrant(
  media: ClientMediaMetadata,
  range: DynamicRange,
  evidence: ClientPlaybackEvidence,
): DeviceDisplayCapabilityGrant | undefined {
  const grant = evidence.presentationGrant;
  const request = evidence.presentationGrantRequest;
  if (!request || !deviceDisplayCapabilityGrantMatchesRequest(grant, request)) return undefined;
  if ((evidence.presentation || 'webxr') !== grant.presentation) return undefined;
  const modifiedAtMilliseconds = media.modifiedAt ? new Date(media.modifiedAt).getTime() : Number.NaN;
  const modifiedAt = Number.isFinite(modifiedAtMilliseconds)
    ? new Date(modifiedAtMilliseconds).toISOString()
    : undefined;
  const scope = grant.media;
  const exactMatch = grant.verifiedDynamicRange === range
    && scope.dynamicRange === range
    && scope.mediaId === media.mediaId
    && scope.size === media.size
    && scope.modifiedAt === modifiedAt
    && scope.codec === normalized(media.videoCodec)
    && scope.profile === normalized(media.videoProfile)
    && scope.level === media.videoLevel
    && scope.pixelFormat === normalized(media.pixelFormat)
    && scope.bitDepth === media.bitDepth
    && scope.colorPrimaries === normalized(media.colorPrimaries)
    && scope.colorTransfer === normalized(media.colorTransfer)
    && scope.colorSpace === normalized(media.colorSpace)
    && scope.colorRange === normalized(media.colorRange)
    && scope.container === normalized(media.container)
    && scope.width === media.width
    && scope.height === media.height
    && scope.fps === media.frameRate
    && scope.projection === media.projection
    && scope.stereo === media.stereo;
  return exactMatch ? grant : undefined;
}

function isKnownBrowserSafeSdr(media: ClientMediaMetadata, range: DynamicRange) {
  const extension = normalized(media.extension)?.replace(/^\./, '');
  const container = normalized(media.container);
  const codec = normalized(media.videoCodec);
  const profile = normalized(media.videoProfile);
  const pixelFormat = normalized(media.pixelFormat);
  const audioCodec = normalized(media.audioCodec);
  const videoContainerSafe = Boolean(
    (extension && safeVideoContainers.has(extension))
    || (container && safeVideoContainers.has(container)),
  );

  return range === 'sdr'
    && videoContainerSafe
    && (codec === 'h264' || codec === 'avc' || codec === 'avc1')
    && pixelFormat === 'yuv420p'
    && (!media.bitDepth || media.bitDepth <= 8)
    && (!profile || safeH264Profiles.has(profile))
    && (!media.videoLevel || media.videoLevel <= 52)
    && (!audioCodec || safeAudioCodecs.has(audioCodec));
}

/**
 * Conservatively decides whether Localis may try the original resource.
 *
 * A positive result is permission to attempt playback, not a guarantee. A
 * negative result means the client should select the private server-side
 * compatibility path immediately. In particular, decode support alone never
 * makes an unverified HDR WebXR presentation safe.
 */
export function evaluateClientMediaCapability(
  media: ClientMediaMetadata,
  evidence: ClientPlaybackEvidence,
): ClientMediaCapabilityDecision {
  const canPlayType = evidence.canPlayType || '';
  const decoding = evidence.mediaCapabilities;

  if (media.kind === 'audio') {
    if (!canPlayType) {
      return decision(false, 'browser-unsupported', '浏览器未声明支持该原始音频，需使用电脑端兼容流。');
    }
    if (decoding?.supported === false) {
      return decision(false, 'decoder-unsupported', 'MediaCapabilities 判定该原始音频不可解码，需使用电脑端兼容流。');
    }
    return decision(true, 'audio-browser-supported', '浏览器声明可以读取该原始音频，可尝试直接播放。');
  }

  const range = effectiveDynamicRange(media);
  if (!range) {
    return decision(
      false,
      'dynamic-range-unknown',
      '原片动态范围尚未确认，不能将其视为安全的 WebXR 直连素材。',
      true,
    );
  }

  if (!normalized(media.videoCodec)) {
    return decision(false, 'video-codec-unknown', '原片视频编码尚未确认，需先使用电脑端兼容流。');
  }

  const audioCodec = normalized(media.audioCodec);
  if (audioCodec && !safeAudioCodecs.has(audioCodec)) {
    return decision(
      false,
      'audio-codec-unsupported',
      `${audioCodec.toUpperCase()} 音轨尚未完成浏览器直连验证；为避免无声播放，需使用电脑端音频兼容流。`,
    );
  }

  // Explicit browser rejection remains authoritative even when a previous
  // guided display check exists. Browser upgrades and runtime decoder changes
  // must fail closed instead of blindly trusting old success.
  if (decoding?.supported === false) {
    return decision(
      false,
      'decoder-unsupported',
      'MediaCapabilities 判定该原片不可解码，需使用电脑端兼容流。',
      true,
    );
  }

  if (decoding?.smooth === false) {
    return decision(
      false,
      'decoder-not-smooth',
      '浏览器预计原片无法流畅解码，使用电脑端兼容流可降低卡顿风险。',
      true,
    );
  }

  if (range === 'unknown') {
    return decision(
      false,
      'color-metadata-unverified',
      '原片色彩元数据不完整或互相冲突，不能保存设备确认；仅使用 8-bit 色彩未知兼容流，不保证亮度或色彩正确。',
    );
  }

  const grant = applicablePresentationGrant(media, range, evidence);
  if (grant) {
    if (grant.evidenceSource === 'guided-user') {
      return decision(
        true,
        'device-profile-guided-original',
        '本设备已在 WebXR 中人工确认过这一精确原片，可再次尝试直连；该记录不等同于仪器验证 HDR。',
      );
    }
    return decision(
      true,
      'device-profile-verified-original',
      grant.evidenceSource === 'instrumented'
        ? '当前设备、浏览器与精确原片已有仪器验证记录，可尝试原片直连。'
        : '当前设备、浏览器与精确原片已有厂商认证记录，可尝试原片直连。',
    );
  }

  if (range === 'sdr10' || (media.bitDepth && media.bitDepth > 8 && range === 'sdr')) {
    return decision(
      false,
      'high-bit-depth-webxr-unverified',
      '浏览器解码能力不能证明 WebXR 保留 10/12-bit 精度；本设备尚未人工确认这一原片，先使用带抖动的 8-bit SDR 兼容流。',
    );
  }

  if (range !== 'sdr') {
    const presentation = evidence.presentation || 'webxr';
    if (presentation === 'webxr') {
      return decision(
        false,
        'hdr-webxr-unverified',
        range === 'dolby-vision'
          ? '浏览器解码能力不能证明 WebXR 保留 Dolby Vision；当前设备也不能建立本地杜比视界授权，先使用未认证的 8-bit 兼容流。'
          : '浏览器解码能力不能证明 WebXR HDR 输出正确；当前设备未完成端到端验证，需使用电脑端 SDR 兼容流。',
      );
    }
    return decision(
      false,
      'hdr-presentation-unverified',
      '浏览器可能能够解码 HDR，但当前显示链路尚未验证，需使用电脑端 SDR 兼容流。',
    );
  }

  if (
    (evidence.presentation || 'webxr') === 'webxr'
    && ((media.width && media.height && Math.max(media.width, media.height) > 4096)
      || (media.frameRate && media.frameRate > 60))
  ) {
    return decision(
      false,
      'webxr-envelope-unverified',
      '解码支持不能证明该分辨率或帧率可稳定进入 WebXR 纹理；真机验收前使用电脑端兼容流。',
      true,
    );
  }

  // This is the same conservative H.264/AAC or MP3 baseline the server has
  // historically attempted directly. Keep it original-first even when a
  // browser returns an empty canPlayType result, and retain runtime fallback.
  if (isKnownBrowserSafeSdr(media, range)) {
    return decision(true, 'known-safe-sdr', '这是浏览器安全范围内的 H.264 8-bit SDR MP4，可尝试原片直连。');
  }

  if (!evidence.codecStringExact) {
    return decision(
      false,
      'codec-evidence-inexact',
      '当前 codec 字符串无法精确描述原片 profile、位深或色度格式，不能用泛化的浏览器结果决定原片直连。',
    );
  }

  if (!canPlayType) {
    return decision(false, 'browser-unsupported', 'canPlayType 未声明支持该原片组合，需使用电脑端兼容流。');
  }

  if (decoding?.supported === true && decoding.smooth === true) {
    const efficiency = decoding.powerEfficient === false ? '，但可能增加耗电' : '';
    return decision(
      true,
      'media-capabilities-supported',
      `MediaCapabilities 确认当前编码受支持且预计流畅${efficiency}，可尝试原片直连。`,
    );
  }

  if (canPlayType === 'probably') {
    return decision(true, 'browser-probably-supported', '浏览器明确声明很可能支持该原片，可尝试直连并保留失败回退。');
  }

  return decision(
    false,
    'browser-evidence-insufficient',
    '浏览器仅返回可能支持，且缺少流畅解码证据；为保证 XR 观看体验应使用电脑端兼容流。',
  );
}
