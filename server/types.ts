export type MediaKind = 'video' | 'audio';
export type Projection = 'flat' | 'equirect180' | 'equirect360';
export type StereoLayout = 'mono' | 'sbs' | 'tb';
export type EyeOrder = 'lr' | 'rl';
export type MediaSourceType = 'local' | 'webdav' | 'baidu';
export type DynamicRange = 'sdr' | 'hdr10' | 'hlg' | 'dolby-vision';
export type CompatibilityMode = 'direct' | 'remux' | 'audio-transcode' | 'video-transcode' | 'tone-map';

export interface MediaTrack {
  index: number;
  codec: string;
  language?: string;
  title?: string;
  channels?: number;
}

export interface SubtitleTrack extends MediaTrack {
  source: 'embedded' | 'external';
  externalPath?: string;
}

export interface MediaItem {
  id: string;
  kind: MediaKind;
  title: string;
  fileName: string;
  relativePath: string;
  extension: string;
  size: number;
  modifiedAt: string;
  duration: number;
  width?: number;
  height?: number;
  frameRate?: number;
  videoCodec?: string;
  videoProfile?: string;
  videoLevel?: number;
  pixelFormat?: string;
  bitDepth?: number;
  dynamicRange?: DynamicRange;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  sampleAspectRatio?: string;
  audioCodec?: string;
  container?: string;
  projection: Projection;
  stereo: StereoLayout;
  eyeOrder: EyeOrder;
  yawOffset: number;
  audioTracks: MediaTrack[];
  subtitleTracks: SubtitleTrack[];
  directPlay: boolean;
  compatibilityMode: CompatibilityMode;
  compatibilityReason: string;
  sourceType: MediaSourceType;
  sourceId?: string;
  remoteFileId?: string;
  path: string;
  libraryRoot: string;
}

export type PublicMediaItem = Omit<MediaItem, 'path' | 'libraryRoot' | 'sourceId' | 'remoteFileId'> & {
  streamUrl: string;
  posterUrl?: string;
  hlsUrl: string;
};

export interface LocalisConfig {
  projectRoot: string;
  dataDir: string;
  cacheDir: string;
  mediaDirs: string[];
  port: number;
  host: string;
  frontendOrigin?: string;
  authDisabled: boolean;
  pairingCode: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  publicHostname?: string;
  allowedHosts: string[];
  ffmpegPath: string;
  ffprobePath: string;
  aiSuperResolutionPath?: string;
  aiSuperResolutionModelsPath?: string;
  maxTranscodes: number;
  maxCacheBytes?: number;
  cloudCacheBytes?: number;
  maxCloudDownloads?: number;
  /**
   * Publisher-managed Baidu application identity. These values are read by the
   * computer-side server only and are never returned to the browser.
   */
  baiduAppKey?: string;
  baiduSecretKey?: string;
  baiduAppFolder?: string;
}

export interface PlaybackProgress {
  mediaId: string;
  position: number;
  duration: number;
  updatedAt: string;
}
