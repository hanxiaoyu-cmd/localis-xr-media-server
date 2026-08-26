import { describe, expect, it } from 'vitest';
import type { PublicMediaItem } from '../server/types';
import {
  buildDeviceDisplayEnvironment,
  buildExactDisplayMediaInput,
} from '../app/lib/device-display-environment';
import { DEVICE_DISPLAY_PIPELINE_VERSION } from '../app/lib/device-display-capability';

const baseItem: PublicMediaItem = {
  id: 'media-hdr-1',
  kind: 'video',
  title: 'HDR movie',
  fileName: 'movie.mkv',
  relativePath: 'movie.mkv',
  extension: '.mkv',
  size: 8_000_000_000,
  modifiedAt: '2026-08-25T08:30:00+08:00',
  duration: 3_600,
  width: 3840,
  height: 2160,
  frameRate: 59.94,
  videoCodec: 'HEVC',
  videoProfile: 'Main 10',
  videoLevel: 153,
  pixelFormat: 'YUV420P10LE',
  bitDepth: 10,
  dynamicRange: 'hdr10',
  colorPrimaries: 'BT2020',
  colorTransfer: 'SMPTE2084',
  colorSpace: 'BT2020NC',
  colorRange: 'TV',
  audioCodec: 'aac',
  container: 'Matroska,WebM',
  projection: 'equirect180',
  stereo: 'sbs',
  eyeOrder: 'lr',
  yawOffset: 0,
  audioTracks: [],
  subtitleTracks: [],
  directPlay: false,
  compatibilityMode: 'tone-map',
  compatibilityReason: 'HDR 安全播放',
  sourceType: 'local',
  streamUrl: '/api/media/media-hdr-1/stream',
  hlsUrl: '/api/media/media-hdr-1/hls/off/index.m3u8',
};

describe('device display environment binding', () => {
  it.each([
    [
      'Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80',
      'edge',
      'chromium',
      130,
    ],
    [
      'Chrome',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36',
      'chrome',
      'chromium',
      129,
    ],
    [
      'Safari',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15',
      'safari',
      'webkit',
      18,
    ],
    [
      'Firefox',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'firefox',
      'gecko',
      131,
    ],
  ] as const)('binds %s to the correct engine and major version', (
    _label,
    userAgent,
    browserName,
    browserEngine,
    browserMajor,
  ) => {
    expect(buildDeviceDisplayEnvironment({
      origin: 'https://XR.Example.test:8443/player?id=1',
      userAgent,
      platform: '  VisionOS  ',
    })).toEqual({
      ok: true,
      browserName,
      environment: {
        origin: 'https://xr.example.test:8443',
        browserProduct: browserName,
        browserEngine,
        browserMajor,
        platform: 'visionos',
        presentation: 'webxr',
        pipelineVersion: DEVICE_DISPLAY_PIPELINE_VERSION,
      },
    });
  });

  it.each([
    ['unknown UA', { userAgent: 'LocalisXR/1.0' }, 'unsupported-browser'],
    ['empty UA', { userAgent: '' }, 'unsupported-browser'],
    ['opaque origin', { origin: 'file:///movie.html' }, 'invalid-origin'],
    ['missing platform', { platform: '  ' }, 'invalid-platform'],
  ] as const)('fails closed for %s with a Chinese diagnostic', (_label, patch, reason) => {
    const result = buildDeviceDisplayEnvironment({
      origin: 'https://xr.example.test',
      userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      ...patch,
    });

    expect(result).toMatchObject({ ok: false, reason });
    expect(!result.ok && /[\u4e00-\u9fff]/u.test(result.detail)).toBe(true);
  });

  it.each([
    ['CriOS', 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1', 'chrome'],
    ['FxiOS', 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/131.0 Mobile/15E148 Safari/605.1.15', 'firefox'],
  ] as const)('does not mistake %s on iOS for a non-WebKit engine', (_token, userAgent, browserName) => {
    expect(buildDeviceDisplayEnvironment({
      origin: 'https://xr.example.test',
      userAgent,
      platform: 'iPhone',
    })).toMatchObject({
      ok: true,
      browserName,
      environment: { browserProduct: browserName, browserEngine: 'webkit' },
    });
  });

  it.each([
    [
      'Meta Quest',
      'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile VR Safari/537.36 OculusBrowser/32.0.0.15.101',
      'meta-quest',
      32,
    ],
    [
      'PICO Browser',
      'Mozilla/5.0 (Linux; Android 10; PICO 4) AppleWebKit/537.36 Chrome/105.0.0.0 Mobile Safari/537.36 PicoBrowser/5.12.4',
      'pico',
      5,
    ],
    [
      'PICO Browser spaced token',
      'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/105.0.0.0 PICO Browser/7.2 Safari/537.36',
      'pico',
      7,
    ],
  ] as const)('prioritizes %s product identity over its Chrome token', (
    _label,
    userAgent,
    browserProduct,
    browserMajor,
  ) => {
    expect(buildDeviceDisplayEnvironment({
      origin: 'https://xr.example.test',
      userAgent,
      platform: 'Android',
    })).toMatchObject({
      ok: true,
      browserName: browserProduct,
      environment: { browserProduct, browserEngine: 'chromium', browserMajor },
    });
  });

  it.each([
    ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36 SamsungBrowser/25.0'],
    ['Opera', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 OPR/80.0.0.0'],
    ['Android WebView wv', 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36'],
    ['Android WebView token', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 WebView/120.0 Mobile Safari/537.36'],
    ['headless Chrome', 'Mozilla/5.0 HeadlessChrome/130.0.0.0 Safari/537.36'],
  ] as const)('fails closed for known derived browser %s', (_label, userAgent) => {
    expect(buildDeviceDisplayEnvironment({
      origin: 'https://xr.example.test',
      userAgent,
      platform: 'Android',
    })).toMatchObject({ ok: false, reason: 'unsupported-browser' });
  });
});

describe('exact display media binding', () => {
  it('builds a canonical fingerprint only from complete probe metadata', () => {
    expect(buildExactDisplayMediaInput(baseItem)).toEqual({
      ok: true,
      media: {
        mediaId: 'media-hdr-1',
        size: 8_000_000_000,
        modifiedAt: '2026-08-25T00:30:00.000Z',
        codec: 'hevc',
        profile: 'main 10',
        level: 153,
        pixelFormat: 'yuv420p10le',
        bitDepth: 10,
        dynamicRange: 'hdr10',
        colorPrimaries: 'bt2020',
        colorTransfer: 'smpte2084',
        colorSpace: 'bt2020nc',
        colorRange: 'tv',
        container: 'matroska,webm',
        width: 3840,
        height: 2160,
        fps: 59.94,
        projection: 'equirect180',
        stereo: 'sbs',
      },
    });
  });

  it.each([
    ['id', 'mediaId'],
    ['size', 'size'],
    ['modifiedAt', 'modifiedAt'],
    ['videoCodec', 'codec'],
    ['videoProfile', 'profile'],
    ['videoLevel', 'level'],
    ['pixelFormat', 'pixelFormat'],
    ['bitDepth', 'bitDepth'],
    ['dynamicRange', 'dynamicRange'],
    ['colorPrimaries', 'colorPrimaries'],
    ['colorTransfer', 'colorTransfer'],
    ['colorSpace', 'colorSpace'],
    ['colorRange', 'colorRange'],
    ['container', 'container'],
    ['width', 'width'],
    ['height', 'height'],
    ['frameRate', 'fps'],
    ['projection', 'projection'],
    ['stereo', 'stereo'],
  ] as const)('fails closed when %s is missing', (sourceField, exactField) => {
    const result = buildExactDisplayMediaInput({
      ...baseItem,
      [sourceField]: undefined,
    } as unknown as PublicMediaItem);

    expect(result).toMatchObject({
      ok: false,
      reason: 'incomplete-metadata',
      missingFields: [exactField],
    });
    expect(!result.ok && /[\u4e00-\u9fff]/u.test(result.detail)).toBe(true);
  });

  it('reports invalid values separately and never repairs them with defaults', () => {
    const result = buildExactDisplayMediaInput({
      ...baseItem,
      modifiedAt: 'not-a-date',
      bitDepth: 0,
      frameRate: Number.NaN,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid-metadata',
      missingFields: [],
      invalidFields: ['modifiedAt', 'bitDepth', 'fps'],
    });
  });

  it('rejects audio without manufacturing video metadata', () => {
    expect(buildExactDisplayMediaInput({ ...baseItem, kind: 'audio' })).toMatchObject({
      ok: false,
      reason: 'not-video',
      missingFields: [],
      invalidFields: [],
    });
  });
});
