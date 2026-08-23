import { describe, expect, it } from 'vitest';
import { chooseHlsTransport, isAppleSafari } from '../app/lib/hls-transport';

describe('HLS transport selection', () => {
  it('keeps native HLS on Apple Safari and Vision Pro Safari', () => {
    const visionPro = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
    expect(isAppleSafari(visionPro)).toBe(true);
    expect(chooseHlsTransport({ nativeHls: true, mediaSourceHls: true, userAgent: visionPro })).toBe('native');
  });

  it('prefers hls.js on Chromium even when canPlayType claims native HLS', () => {
    const chromium = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
    expect(isAppleSafari(chromium)).toBe(false);
    expect(chooseHlsTransport({ nativeHls: true, mediaSourceHls: true, userAgent: chromium })).toBe('hls.js');
  });

  it('falls back to native support when MediaSource is unavailable', () => {
    expect(chooseHlsTransport({ nativeHls: true, mediaSourceHls: false, userAgent: 'HeadsetBrowser/1.0' })).toBe('native');
    expect(chooseHlsTransport({ nativeHls: false, mediaSourceHls: false, userAgent: 'HeadsetBrowser/1.0' })).toBe('unsupported');
  });
});
