import { describe, expect, it, vi } from 'vitest';
import type { PublicMediaItem } from '../server/types';
import { browserMediaContentType, probeBrowserMediaCapability } from '../app/lib/browser-media-capability';

const baseItem: PublicMediaItem = {
  id: 'media-1',
  kind: 'video',
  title: 'Movie',
  fileName: 'movie.mp4',
  relativePath: 'movie.mp4',
  extension: '.mp4',
  size: 120_000_000,
  modifiedAt: '2026-08-25T00:00:00.000Z',
  duration: 60,
  width: 3840,
  height: 2160,
  frameRate: 60,
  videoCodec: 'h264',
  videoProfile: 'High',
  videoLevel: 51,
  pixelFormat: 'yuv420p',
  bitDepth: 8,
  dynamicRange: 'sdr',
  colorTransfer: 'bt709',
  audioCodec: 'aac',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  projection: 'flat',
  stereo: 'mono',
  eyeOrder: 'lr',
  yawOffset: 0,
  audioTracks: [],
  subtitleTracks: [],
  directPlay: true,
  compatibilityMode: 'direct',
  compatibilityReason: 'safe',
  sourceType: 'local',
  streamUrl: '/api/media/media-1/stream',
  hlsUrl: '/api/media/media-1/hls/off/index.m3u8',
};

describe('browser media capability probe', () => {
  it('builds an exact codec-aware content type for safe H.264 MP4', () => {
    expect(browserMediaContentType(baseItem)).toBe('video/mp4; codecs="avc1.640033, mp4a.40.2"');
  });

  it.each([
    ['H.264 High 10', { videoCodec: 'h264', videoProfile: 'High 10', pixelFormat: 'yuv420p10le', bitDepth: 10 }],
    ['H.264 High 4:4:4', { videoCodec: 'h264', videoProfile: 'High 4:4:4 Predictive', pixelFormat: 'yuv444p', bitDepth: 8 }],
    ['HEVC', { videoCodec: 'hevc', videoProfile: 'Main 10', pixelFormat: 'yuv420p10le', bitDepth: 10 }],
    ['AV1', { videoCodec: 'av1', videoProfile: 'Main', pixelFormat: 'yuv420p10le', bitDepth: 10 }],
    ['VP9', { videoCodec: 'vp9', videoProfile: 'Profile 2', pixelFormat: 'yuv420p10le', bitDepth: 10 }],
  ])('does not synthesize an easier RFC 6381 description for %s', (_label, patch) => {
    expect(browserMediaContentType({ ...baseItem, ...patch })).toBeUndefined();
  });

  it('allows the known-safe SDR baseline from canPlayType evidence', async () => {
    const result = await probeBrowserMediaCapability(baseItem, { canPlayType: () => 'maybe' });
    expect(result.decision).toMatchObject({ canAttemptOriginal: true, reasonCode: 'known-safe-sdr' });
  });

  it('does not query browser APIs with a generic HEVC descriptor', async () => {
    const canPlayType = vi.fn(() => 'probably' as const);
    const decodingInfo = vi.fn(async () => ({ supported: true, smooth: true, powerEfficient: true }));
    const result = await probeBrowserMediaCapability(
      { ...baseItem, directPlay: false, videoCodec: 'hevc', pixelFormat: 'yuv420p10le', bitDepth: 10 },
      { canPlayType, decodingInfo },
    );

    expect(result.contentType).toBeUndefined();
    expect(result.evidence.codecStringExact).toBe(false);
    expect(result.decision).toMatchObject({
      canAttemptOriginal: false,
      requiresServerCompatibility: true,
      reasonCode: 'high-bit-depth-webxr-unverified',
    });
    expect(canPlayType).not.toHaveBeenCalled();
    expect(decodingInfo).not.toHaveBeenCalled();
  });

  it('keeps HDR on the compatibility path even when decoding is supported and smooth', async () => {
    const result = await probeBrowserMediaCapability(
      {
        ...baseItem,
        directPlay: false,
        compatibilityMode: 'tone-map',
        videoCodec: 'hevc',
        pixelFormat: 'yuv420p10le',
        bitDepth: 10,
        dynamicRange: 'hdr10',
        colorTransfer: 'smpte2084',
      },
      {
        canPlayType: () => 'probably',
        decodingInfo: async () => ({ supported: true, smooth: true }),
      },
    );
    expect(result.decision).toMatchObject({
      canAttemptOriginal: false,
      requiresServerCompatibility: true,
      reasonCode: 'hdr-webxr-unverified',
    });
  });

  it('falls back conservatively when MediaCapabilities rejects the query', async () => {
    const result = await probeBrowserMediaCapability(
      {
        ...baseItem,
        directPlay: false,
        fileName: 'movie.webm',
        extension: '.webm',
        container: 'matroska,webm',
        videoCodec: 'vp8',
        videoProfile: undefined,
        videoLevel: undefined,
        audioCodec: undefined,
      },
      { canPlayType: () => 'maybe', decodingInfo: async () => { throw new Error('unsupported config'); } },
    );
    expect(result.decision).toMatchObject({ canAttemptOriginal: false, reasonCode: 'browser-evidence-insufficient' });
  });

  it('does not auto-direct an unverified audio codec', async () => {
    const result = await probeBrowserMediaCapability(
      { ...baseItem, directPlay: false, videoCodec: 'hevc', audioCodec: 'dts' },
      { canPlayType: () => 'probably', decodingInfo: async () => ({ supported: true, smooth: true }) },
    );
    expect(result.decision.reasonCode).toBe('audio-codec-unsupported');
  });
});
