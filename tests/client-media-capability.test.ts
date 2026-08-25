import { describe, expect, it } from 'vitest';
import {
  evaluateClientMediaCapability,
  type ClientPlaybackEvidence,
  type ClientMediaMetadata,
} from '../app/lib/client-media-capability';
import {
  createGuidedUserDeviceDisplayProfile,
  getOrCreateDeviceDisplayInstallationId,
  resolveDeviceDisplayCapabilityGrant,
  upsertDeviceDisplayCapabilityProfile,
  type DeviceDisplayCapabilityGrant,
  type DeviceDisplayCapabilityRequest,
  type DeviceDisplayStorage,
  type VerifiedDisplayDynamicRange,
} from '../app/lib/device-display-capability';

const safeSdr: ClientMediaMetadata = {
  kind: 'video',
  mediaId: 'media-1',
  size: 120_000_000,
  modifiedAt: '2026-08-25T00:00:00.000Z',
  extension: '.mp4',
  container: 'mp4',
  videoCodec: 'h264',
  videoProfile: 'High',
  videoLevel: 51,
  pixelFormat: 'yuv420p',
  bitDepth: 8,
  dynamicRange: 'sdr',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorSpace: 'bt709',
  colorRange: 'tv',
  audioCodec: 'aac',
  width: 3840,
  height: 2160,
  frameRate: 60,
  projection: 'flat',
  stereo: 'mono',
};

const exactHdr10: ClientMediaMetadata = {
  ...safeSdr,
  videoCodec: 'hevc',
  videoProfile: 'Main 10',
  videoLevel: 153,
  pixelFormat: 'yuv420p10le',
  bitDepth: 10,
  dynamicRange: 'hdr10',
  colorPrimaries: 'bt2020',
  colorTransfer: 'smpte2084',
  colorSpace: 'bt2020nc',
};

function guidedCapability(dynamicRange: VerifiedDisplayDynamicRange): {
  grant: DeviceDisplayCapabilityGrant;
  request: DeviceDisplayCapabilityRequest;
} {
  const values = new Map<string, string>();
  const storage: DeviceDisplayStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const installationId = '11111111-1111-4111-8111-111111111111';
  const installation = getOrCreateDeviceDisplayInstallationId(storage, () => installationId);
  if (!installation.ok) throw new Error(installation.detail);
  const environment = {
    origin: 'https://xr.example.com',
    browserProduct: 'chrome' as const,
    browserEngine: 'chromium' as const,
    browserMajor: 140,
    platform: 'android',
    presentation: 'webxr' as const,
    pipelineVersion: 'webxr-video-v1',
  };
  const media = {
    mediaId: 'media-1',
    size: 120_000_000,
    modifiedAt: '2026-08-25T00:00:00.000Z',
    codec: 'hevc',
    profile: 'main 10',
    level: 153,
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    dynamicRange,
    colorPrimaries: 'bt2020',
    colorTransfer: dynamicRange === 'hlg' ? 'arib-std-b67' : dynamicRange === 'sdr10' ? 'bt709' : 'smpte2084',
    colorSpace: dynamicRange === 'sdr10' ? 'bt709' : 'bt2020nc',
    colorRange: 'tv',
    container: 'mp4',
    width: 3840,
    height: 2160,
    fps: 60,
    projection: 'flat' as const,
    stereo: 'mono' as const,
  };
  const recordedAt = new Date().toISOString();
  const created = createGuidedUserDeviceDisplayProfile({
    installationId,
    environment,
    media,
    now: recordedAt,
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });
  if (!created.ok) throw new Error(created.detail);
  const written = upsertDeviceDisplayCapabilityProfile(storage, created.profile);
  if (!written.ok) throw new Error(written.detail);
  const request = {
    installationId,
    environment,
    media,
  };
  const resolved = resolveDeviceDisplayCapabilityGrant(storage, {
    ...request,
    now: new Date(new Date(recordedAt).getTime() + 1_000),
  });
  if (!resolved.granted) throw new Error(resolved.detail);
  return { grant: resolved.grant, request };
}

describe('client media capability decisions', () => {
  it.each([
    ['hdr10', 'smpte2084'],
    ['hlg', 'arib-std-b67'],
    ['dolby-vision', undefined],
  ] as const)('does not treat unverified %s WebXR as safe direct play', (dynamicRange, colorTransfer) => {
    const result = evaluateClientMediaCapability(
      { ...safeSdr, videoCodec: 'hevc', bitDepth: 10, dynamicRange, colorTransfer },
      {
        canPlayType: 'probably',
        mediaCapabilities: { supported: true, smooth: true, powerEfficient: true },
        presentation: 'webxr',
      },
    );

    expect(result).toMatchObject({
      canAttemptOriginal: false,
      requiresServerCompatibility: true,
      reasonCode: 'hdr-webxr-unverified',
    });
  });

  it('accepts only a resolved exact-media grant for a previously observed HDR original', () => {
    const capability = guidedCapability('hdr10');
    const result = evaluateClientMediaCapability(
      exactHdr10,
      {
        canPlayType: 'probably',
        mediaCapabilities: { supported: true, smooth: true },
        codecStringExact: false,
        presentation: 'webxr',
        presentationGrant: capability.grant,
        presentationGrantRequest: capability.request,
      },
    );

    expect(result).toMatchObject({
      canAttemptOriginal: true,
      requiresServerCompatibility: false,
      reasonCode: 'device-profile-guided-original',
    });
  });

  it('does not accept a legacy boolean or a structurally forged persisted object as authority', () => {
    const hdr = exactHdr10;
    expect(evaluateClientMediaCapability(hdr, {
      canPlayType: 'probably',
      hdrPresentationVerified: true,
    } as unknown as ClientPlaybackEvidence).reasonCode).toBe('hdr-webxr-unverified');

    expect(evaluateClientMediaCapability(hdr, {
      canPlayType: 'probably',
      presentationGrant: {
        kind: 'device-display-capability-grant',
        profileId: '22222222-2222-4222-8222-222222222222',
        evidenceSource: 'guided-user',
        presentation: 'webxr',
        verifiedDynamicRange: 'hdr10',
        mediaId: 'media-1',
        expiresAt: '2026-11-23T00:00:00.000Z',
      } as unknown as DeviceDisplayCapabilityGrant,
    }).reasonCode).toBe('hdr-webxr-unverified');
  });

  it('does not reuse a legitimate grant for another exact media scope', () => {
    const capability = guidedCapability('hdr10');
    expect(evaluateClientMediaCapability(
      { ...exactHdr10, mediaId: 'media-2' },
      {
        canPlayType: 'probably',
        presentationGrant: capability.grant,
        presentationGrantRequest: capability.request,
      },
    )).toMatchObject({ canAttemptOriginal: false, reasonCode: 'hdr-webxr-unverified' });
  });

  it('honors an explicit decoder rejection even with a current display grant', () => {
    const capability = guidedCapability('hdr10');
    expect(evaluateClientMediaCapability(
      exactHdr10,
      {
        canPlayType: 'probably',
        mediaCapabilities: { supported: false, smooth: false },
        presentationGrant: capability.grant,
        presentationGrantRequest: capability.request,
      },
    )).toMatchObject({ canAttemptOriginal: false, reasonCode: 'decoder-unsupported' });
  });

  it('keeps unverified 8K or high-frame-rate WebXR outside the automatic direct envelope', () => {
    expect(evaluateClientMediaCapability(
      { ...safeSdr, width: 7680, height: 3840 },
      { canPlayType: 'probably', mediaCapabilities: { supported: true, smooth: true } },
    ).reasonCode).toBe('webxr-envelope-unverified');
    expect(evaluateClientMediaCapability(
      { ...safeSdr, frameRate: 90 },
      { canPlayType: 'probably', mediaCapabilities: { supported: true, smooth: true } },
    )).toMatchObject({
      reasonCode: 'webxr-envelope-unverified',
      requiresForcedVideoTranscode: true,
    });
  });

  it('treats conflicting PQ transfer metadata as HDR instead of trusting an SDR label', () => {
    const result = evaluateClientMediaCapability(
      { ...safeSdr, dynamicRange: 'sdr', colorTransfer: 'smpte2084' },
      { canPlayType: 'probably', mediaCapabilities: { supported: true, smooth: true } },
    );

    expect(result.reasonCode).toBe('hdr-webxr-unverified');
  });

  it('allows the known-safe H.264 8-bit SDR MP4 baseline on a maybe response', () => {
    expect(evaluateClientMediaCapability(safeSdr, { canPlayType: 'maybe' })).toMatchObject({
      canAttemptOriginal: true,
      requiresServerCompatibility: false,
      reasonCode: 'known-safe-sdr',
    });
    expect(evaluateClientMediaCapability(safeSdr, { canPlayType: '' })).toMatchObject({
      canAttemptOriginal: true,
      requiresServerCompatibility: false,
      reasonCode: 'known-safe-sdr',
    });
  });

  it('allows a browser-specific codec only with exact codec evidence and smooth decoding', () => {
    const hevc = { ...safeSdr, videoCodec: 'hevc', videoProfile: 'Main', pixelFormat: 'yuv420p', bitDepth: 8 };

    expect(evaluateClientMediaCapability(hevc, {
      canPlayType: 'maybe',
      mediaCapabilities: { supported: true, smooth: true, powerEfficient: false },
      codecStringExact: true,
    })).toMatchObject({ canAttemptOriginal: true, reasonCode: 'media-capabilities-supported' });

    expect(evaluateClientMediaCapability(hevc, {
      canPlayType: 'maybe',
      mediaCapabilities: { supported: true, smooth: false },
      codecStringExact: true,
    })).toMatchObject({
      canAttemptOriginal: false,
      requiresServerCompatibility: true,
      reasonCode: 'decoder-not-smooth',
    });
  });

  it.each(['hevc', 'av1', 'vp9'] as const)(
    'rejects smooth decoder evidence for %s when the codec string was generic or unavailable',
    (videoCodec) => {
      expect(evaluateClientMediaCapability(
        { ...safeSdr, videoCodec, videoProfile: 'complex', pixelFormat: 'yuv420p10le', bitDepth: 10 },
        {
          canPlayType: 'probably',
          mediaCapabilities: { supported: true, smooth: true },
          codecStringExact: false,
        },
      )).toMatchObject({
        canAttemptOriginal: false,
        requiresServerCompatibility: true,
        reasonCode: 'high-bit-depth-webxr-unverified',
      });
    },
  );

  it('honors an explicit MediaCapabilities rejection even when canPlayType says probably', () => {
    expect(evaluateClientMediaCapability(safeSdr, {
      canPlayType: 'probably',
      mediaCapabilities: { supported: false, smooth: false },
    })).toMatchObject({ canAttemptOriginal: false, reasonCode: 'decoder-unsupported' });
  });

  it('does not auto-direct an otherwise supported video with an unverified audio codec', () => {
    expect(evaluateClientMediaCapability(
      { ...safeSdr, videoCodec: 'hevc', audioCodec: 'dts' },
      { canPlayType: 'probably', mediaCapabilities: { supported: true, smooth: true } },
    )).toMatchObject({
      canAttemptOriginal: false,
      requiresServerCompatibility: true,
      requiresForcedVideoTranscode: false,
      reasonCode: 'audio-codec-unsupported',
    });
  });

  it('requires server compatibility when browser evidence is absent or only weak for a non-safe codec', () => {
    expect(evaluateClientMediaCapability(
      { ...safeSdr, videoCodec: 'av1', pixelFormat: 'yuv420p10le', bitDepth: 10 },
      { canPlayType: '' },
    ).reasonCode).toBe('high-bit-depth-webxr-unverified');
    expect(evaluateClientMediaCapability(
      { ...safeSdr, videoCodec: 'av1', pixelFormat: 'yuv420p10le', bitDepth: 10 },
      { canPlayType: 'maybe' },
    )).toMatchObject({
      canAttemptOriginal: false,
      requiresServerCompatibility: true,
      reasonCode: 'high-bit-depth-webxr-unverified',
    });
  });

  it('does not guess when dynamic range or video codec metadata is missing', () => {
    expect(evaluateClientMediaCapability(
      { ...safeSdr, dynamicRange: undefined, colorTransfer: undefined },
      { canPlayType: 'probably' },
    ).reasonCode).toBe('dynamic-range-unknown');

    expect(evaluateClientMediaCapability(
      { ...safeSdr, videoCodec: undefined },
      { canPlayType: 'probably' },
    ).reasonCode).toBe('video-codec-unknown');
  });

  it('supports audio decisions without browser globals', () => {
    expect(evaluateClientMediaCapability(
      { kind: 'audio', extension: '.flac', audioCodec: 'flac' },
      { canPlayType: 'maybe' },
    )).toMatchObject({ canAttemptOriginal: true, reasonCode: 'audio-browser-supported' });

    expect(evaluateClientMediaCapability(
      { kind: 'audio', extension: '.flac', audioCodec: 'flac' },
      { canPlayType: '' },
    )).toMatchObject({ canAttemptOriginal: false, requiresServerCompatibility: true });
  });
});
