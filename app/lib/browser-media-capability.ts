import type { PublicMediaItem } from '../../server/types';
import {
  evaluateClientMediaCapability,
  type CanPlayTypeResult,
  type ClientMediaCapabilityDecision,
  type ClientPlaybackEvidence,
  type MediaDecodingEvidence,
} from './client-media-capability';
import type {
  DeviceDisplayCapabilityGrant,
  DeviceDisplayCapabilityRequest,
} from './device-display-capability';

export interface ClientVideoDecodingConfiguration {
  contentType: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
}

export interface ClientMediaDecodingConfiguration {
  type: 'file';
  video: ClientVideoDecodingConfiguration;
}

export interface BrowserMediaCapabilityEnvironment {
  canPlayType(contentType: string): CanPlayTypeResult;
  decodingInfo?: (configuration: ClientMediaDecodingConfiguration) => Promise<MediaDecodingEvidence>;
  /** Already resolved against the current exact media and WebXR environment. */
  presentationGrant?: DeviceDisplayCapabilityGrant;
  presentationGrantRequest?: DeviceDisplayCapabilityRequest;
}

export interface BrowserMediaCapabilityResult {
  contentType?: string;
  evidence: ClientPlaybackEvidence;
  decision: ClientMediaCapabilityDecision;
}

const videoMimeTypes: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  ogv: 'video/ogg',
};

const audioMimeTypes: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};

function extensionOf(item: Pick<PublicMediaItem, 'extension' | 'fileName'>) {
  const declared = item.extension?.trim().toLowerCase().replace(/^\./, '');
  if (declared) return declared;
  const match = item.fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1];
}

const h264ProfilePrefix: Record<string, string> = {
  'constrained baseline': '42e0',
  baseline: '4200',
  main: '4d00',
  high: '6400',
};

function h264Codec(item: Pick<PublicMediaItem, 'videoProfile' | 'videoLevel' | 'pixelFormat' | 'bitDepth'>) {
  const profile = item.videoProfile?.trim().toLowerCase();
  const profilePrefix = profile && h264ProfilePrefix[profile];
  const pixelFormat = item.pixelFormat?.trim().toLowerCase();
  const level = item.videoLevel;

  // ffprobe profile names such as High 10, High 4:2:2 and High 4:4:4
  // Predictive cannot be represented as ordinary High. Requiring the safe
  // 8-bit 4:2:0 envelope also catches streams whose profile label is incomplete.
  if (!profilePrefix || pixelFormat !== 'yuv420p' || (item.bitDepth && item.bitDepth > 8)) return undefined;
  if (!Number.isInteger(level) || !level || level < 0 || level > 255) return undefined;
  const levelIdc = level.toString(16).padStart(2, '0');
  return `avc1.${profilePrefix}${levelIdc}`;
}

function videoCodecOf(item: PublicMediaItem) {
  switch (item.videoCodec?.trim().toLowerCase()) {
    case 'h264':
    case 'avc':
    case 'avc1':
      return h264Codec(item);
    case 'hevc':
    case 'h265':
    case 'av1':
    case 'vp9':
      // These RFC 6381 codec strings require profile/tier/level, bit depth,
      // chroma and constraint data that PublicMediaItem does not currently
      // carry. A generic identifier could probe an easier stream than the
      // actual file, so it must not be used as positive decode evidence.
      return undefined;
    case 'vp8':
      return 'vp8';
    default:
      return undefined;
  }
}

function audioCodecOf(item: PublicMediaItem) {
  switch (item.audioCodec?.trim().toLowerCase()) {
    case 'aac': return 'mp4a.40.2';
    case 'mp3': return 'mp3';
    case undefined: return undefined;
    default: return item.audioCodec?.trim().toLowerCase();
  }
}

export function browserMediaContentType(item: PublicMediaItem, includeAudio = true) {
  const extension = extensionOf(item);
  const mime = extension && (item.kind === 'video' ? videoMimeTypes[extension] : audioMimeTypes[extension]);
  if (!mime) return undefined;

  if (item.kind === 'audio') {
    const codec = audioCodecOf(item);
    return codec ? `${mime}; codecs="${codec}"` : mime;
  }

  const videoCodec = videoCodecOf(item);
  if (!videoCodec) return undefined;
  const codecs = [videoCodec, ...(includeAudio ? [audioCodecOf(item)] : [])].filter(Boolean);
  return `${mime}; codecs="${codecs.join(', ')}"`;
}

function mediaMetadata(item: PublicMediaItem) {
  return {
    kind: item.kind,
    mediaId: item.id,
    size: item.size,
    modifiedAt: item.modifiedAt,
    extension: item.extension,
    container: item.container,
    videoCodec: item.videoCodec,
    videoProfile: item.videoProfile,
    videoLevel: item.videoLevel,
    pixelFormat: item.pixelFormat,
    bitDepth: item.bitDepth,
    dynamicRange: item.dynamicRange,
    colorTransfer: item.colorTransfer,
    colorPrimaries: item.colorPrimaries,
    colorSpace: item.colorSpace,
    colorRange: item.colorRange,
    audioCodec: item.audioCodec,
    width: item.width,
    height: item.height,
    frameRate: item.frameRate,
    projection: item.projection,
    stereo: item.stereo,
  };
}

/**
 * Collects only browser-declared decode evidence. HDR presentation remains
 * unverified here because MediaCapabilities cannot prove the WebXR texture and
 * compositor preserve the source transfer function and colour volume.
 */
export async function probeBrowserMediaCapability(
  item: PublicMediaItem,
  environment: BrowserMediaCapabilityEnvironment,
): Promise<BrowserMediaCapabilityResult> {
  const contentType = browserMediaContentType(item);
  const videoContentType = item.kind === 'video' ? browserMediaContentType(item, false) : undefined;
  let canPlayType: CanPlayTypeResult = '';
  if (contentType) {
    try {
      canPlayType = environment.canPlayType(contentType);
    } catch {
      canPlayType = '';
    }
  }

  let mediaCapabilities: MediaDecodingEvidence | undefined;
  if (
    item.kind === 'video'
    && canPlayType
    && videoContentType
    && environment.decodingInfo
    && item.width
    && item.height
    && item.frameRate
    && item.duration > 0
  ) {
    try {
      mediaCapabilities = await environment.decodingInfo({
        type: 'file',
        video: {
          contentType: videoContentType,
          width: item.width,
          height: item.height,
          bitrate: Math.max(1, Math.round(item.size * 8 / item.duration)),
          framerate: item.frameRate,
        },
      });
    } catch {
      // Some browsers expose MediaCapabilities but reject otherwise valid
      // container/codec strings. canPlayType remains useful evidence.
    }
  }

  const evidence: ClientPlaybackEvidence = {
    canPlayType,
    mediaCapabilities,
    codecStringExact: item.kind === 'audio' ? Boolean(contentType) : Boolean(videoContentType),
    presentation: 'webxr',
    presentationGrant: environment.presentationGrant,
    presentationGrantRequest: environment.presentationGrantRequest,
  };
  return {
    contentType,
    evidence,
    decision: evaluateClientMediaCapability(mediaMetadata(item), evidence),
  };
}
