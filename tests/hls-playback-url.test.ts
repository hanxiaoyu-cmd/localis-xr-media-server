import { describe, expect, it } from 'vitest';
import { evaluateClientMediaCapability } from '../app/lib/client-media-capability';
import { hlsPlaybackUrls } from '../app/lib/hls-playback-url';

const safeSdr = {
  kind: 'video' as const,
  extension: 'mp4',
  container: 'mp4',
  videoCodec: 'h264',
  videoProfile: 'High',
  videoLevel: 42,
  pixelFormat: 'yuv420p',
  bitDepth: 8,
  dynamicRange: 'sdr' as const,
  audioCodec: 'aac',
  width: 1920,
  height: 1080,
  frameRate: 30,
};

describe('HLS playback URL selection', () => {
  it('carries a WebXR envelope rejection into the dedicated compatibility path', () => {
    const capability = evaluateClientMediaCapability(
      { ...safeSdr, width: 7680, height: 3840 },
      {
        presentation: 'webxr',
        canPlayType: 'probably',
        mediaCapabilities: { supported: true, smooth: true },
      },
    );
    const urls = hlsPlaybackUrls({
      mediaId: 'wide xr',
      superResolution: 'off',
      requiresForcedVideoTranscode: capability.requiresForcedVideoTranscode,
    });

    expect(capability.reasonCode).toBe('webxr-envelope-unverified');
    expect(urls).toEqual({
      manifestUrl: '/api/media/wide%20xr/hls/compat/index.m3u8',
      statusUrl: '/api/media/wide%20xr/hls/compat/status',
      forceCompatibility: true,
    });
  });

  it('forces compatibility after a runtime direct-play failure', () => {
    expect(hlsPlaybackUrls({
      mediaId: 'safe',
      superResolution: 'off',
      directPlaybackFailed: true,
    })).toMatchObject({
      manifestUrl: '/api/media/safe/hls/compat/index.m3u8',
      forceCompatibility: true,
    });
  });

  it('keeps a manual compatibility-stream choice adaptive for a safe original', () => {
    const capability = evaluateClientMediaCapability(safeSdr, {
      presentation: 'webxr',
      canPlayType: 'probably',
    });
    expect(capability.canAttemptOriginal).toBe(true);
    expect(hlsPlaybackUrls({
      mediaId: 'safe',
      superResolution: 'off',
      requiresForcedVideoTranscode: capability.requiresForcedVideoTranscode,
    })).toEqual({
      manifestUrl: '/api/media/safe/hls/off/index.m3u8',
      statusUrl: '/api/media/safe/hls/off/status',
      forceCompatibility: false,
    });
  });

  it('keeps video copy available when only the audio codec needs compatibility', () => {
    const capability = evaluateClientMediaCapability(
      { ...safeSdr, audioCodec: 'dts' },
      { presentation: 'webxr', canPlayType: 'probably' },
    );
    expect(capability).toMatchObject({
      requiresServerCompatibility: true,
      requiresForcedVideoTranscode: false,
      reasonCode: 'audio-codec-unsupported',
    });
    expect(hlsPlaybackUrls({
      mediaId: 'dts-video',
      superResolution: 'off',
      requiresForcedVideoTranscode: capability.requiresForcedVideoTranscode,
    })).toMatchObject({
      manifestUrl: '/api/media/dts-video/hls/off/index.m3u8',
      forceCompatibility: false,
    });
  });

  it('does not create a redundant compatibility profile for enhanced output', () => {
    expect(hlsPlaybackUrls({
      mediaId: 'video',
      superResolution: 'high',
      requiresForcedVideoTranscode: true,
      directPlaybackFailed: true,
    })).toMatchObject({
      manifestUrl: '/api/media/video/hls/high/index.m3u8',
      statusUrl: '/api/media/video/hls/high/status',
      forceCompatibility: false,
    });
  });
});
