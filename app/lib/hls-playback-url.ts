import type { ServerSuperResolutionLevel } from '@/server/super-resolution';

export interface HlsPlaybackUrlOptions {
  mediaId: string;
  superResolution: ServerSuperResolutionLevel;
  /** A remux/audio-only fallback would preserve the rejected video risk. */
  requiresForcedVideoTranscode?: boolean;
  /** A direct attempt failed at runtime and must not fall back to a mere remux. */
  directPlaybackFailed?: boolean;
}

export interface HlsPlaybackUrls {
  manifestUrl: string;
  statusUrl: string;
  forceCompatibility: boolean;
}

/**
 * Selects a stable HLS path for the complete manifest/segment request chain.
 * `compat` is a path component (not a query) so native HLS clients retain the
 * forced-transcode intent while resolving relative init and segment URLs.
 */
export function hlsPlaybackUrls(options: HlsPlaybackUrlOptions): HlsPlaybackUrls {
  const forceCompatibility = options.superResolution === 'off'
    && Boolean(options.requiresForcedVideoTranscode || options.directPlaybackFailed);
  const profile = forceCompatibility ? 'compat' : options.superResolution;
  const base = `/api/media/${encodeURIComponent(options.mediaId)}/hls/${profile}`;
  return {
    manifestUrl: `${base}/index.m3u8`,
    statusUrl: `${base}/status`,
    forceCompatibility,
  };
}
