import { describe, expect, it } from 'vitest';
import { analyzeMediaCompatibility, detectDynamicRange, pixelFormatBitDepth } from '../server/media-compatibility';

describe('media compatibility analysis', () => {
  it('recognizes HDR10, HLG and Dolby Vision metadata', () => {
    expect(detectDynamicRange({ color_transfer: 'smpte2084' })).toBe('hdr10');
    expect(detectDynamicRange({ color_transfer: 'arib-std-b67' })).toBe('hlg');
    expect(detectDynamicRange({
      color_transfer: 'smpte2084',
      side_data_list: [{ side_data_type: 'DOVI configuration record' }],
    })).toBe('dolby-vision');
  });

  it('extracts common high-bit-depth pixel formats', () => {
    expect(pixelFormatBitDepth({ pix_fmt: 'yuv420p10le' })).toBe(10);
    expect(pixelFormatBitDepth({ pix_fmt: 'p010le' })).toBe(10);
    expect(pixelFormatBitDepth({ pix_fmt: 'yuv420p' })).toBe(8);
  });

  it('forces HDR through the private PC-side tone-map path', () => {
    expect(analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'movie.mp4',
      video: { codec_name: 'h264', profile: 'High', level: 51, pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' },
      audio: { codec_name: 'aac' },
    })).toMatchObject({
      directPlay: false,
      compatibilityMode: 'tone-map',
      dynamicRange: 'hdr10',
      bitDepth: 10,
    });
  });

  it('keeps browser-safe SDR H.264/AAC MP4 on the zero-install direct path', () => {
    expect(analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'movie.mp4',
      video: { codec_name: 'h264', profile: 'High', level: 42, pix_fmt: 'yuv420p' },
      audio: { codec_name: 'aac' },
    })).toMatchObject({ directPlay: true, compatibilityMode: 'direct', dynamicRange: 'sdr' });
  });
});
