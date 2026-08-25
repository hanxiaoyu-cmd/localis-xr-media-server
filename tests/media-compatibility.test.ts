import { describe, expect, it } from 'vitest';
import { analyzeMediaCompatibility, detectDynamicRange, pixelFormatBitDepth } from '../server/media-compatibility';

describe('media compatibility analysis', () => {
  it('uses explicit HDR transfer functions and never guesses PQ from mastering metadata', () => {
    expect(detectDynamicRange({ color_transfer: 'smpte2084' })).toBe('hdr10');
    expect(detectDynamicRange({ color_transfer: 'arib-std-b67' })).toBe('hlg');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      side_data_list: [{ side_data_type: 'Mastering display metadata' }],
    })).toBe('unknown');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le',
      color_transfer: 'arib-std-b67',
      side_data_list: [{ side_data_type: 'Mastering display metadata' }],
    })).toBe('hlg');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le',
      color_transfer: 'smpte2084',
      side_data_list: [{ side_data_type: 'Mastering display metadata' }],
    })).toBe('hdr10');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le',
      side_data_list: [{ side_data_type: 'Mastering display metadata' }],
    })).toBe('unknown');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le',
      color_transfer: 'smpte2084',
      color_primaries: 'bt709',
    })).toBe('unknown');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le',
      color_transfer: 'arib-std-b67',
      color_primaries: 'bt2020',
      color_space: 'bt709',
    })).toBe('unknown');
    expect(detectDynamicRange({
      color_transfer: 'smpte2084',
      side_data_list: [{ side_data_type: 'DOVI configuration record' }],
    })).toBe('dolby-vision');
  });

  it('distinguishes explicitly tagged 10-bit SDR from untrustworthy high-bit-depth sources', () => {
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le', color_transfer: 'bt709', color_primaries: 'bt709',
    })).toBe('sdr10');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p12le', color_transfer: 'bt2020-12', color_primaries: 'bt2020',
    })).toBe('sdr10');
    expect(detectDynamicRange({ pix_fmt: 'yuv420p10le' })).toBe('unknown');
    expect(detectDynamicRange({ pix_fmt: 'yuv420p10le', color_transfer: 'bt709' })).toBe('unknown');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p12le', color_transfer: 'bt2020-12', color_primaries: 'bt709',
    })).toBe('unknown');
    expect(detectDynamicRange({
      pix_fmt: 'yuv420p10le', color_transfer: 'bt709', color_primaries: 'bt2020',
    })).toBe('unknown');
    expect(detectDynamicRange(undefined)).toBe('unknown');
  });

  it('extracts planar, semi-planar and packed high-bit-depth pixel formats', () => {
    expect(pixelFormatBitDepth({ pix_fmt: 'yuv420p10le' })).toBe(10);
    expect(pixelFormatBitDepth({ pix_fmt: 'gbrp12le' })).toBe(12);

    for (const pix_fmt of [
      'p010le', 'p210be', 'p410le', 'y210le', 'v210', 'v410', 'xv30le',
      'x2rgb10le', 'x2bgr10be',
    ]) {
      expect(pixelFormatBitDepth({ pix_fmt }), pix_fmt).toBe(10);
    }
    for (const pix_fmt of ['p012le', 'p212be', 'p412le', 'y212be', 'xv36le']) {
      expect(pixelFormatBitDepth({ pix_fmt }), pix_fmt).toBe(12);
    }
    for (const pix_fmt of [
      'p016le', 'p216be', 'p416le', 'y216be', 'rgb48le', 'bgr48be',
      'rgba64le', 'ayuv64be',
    ]) {
      expect(pixelFormatBitDepth({ pix_fmt }), pix_fmt).toBe(16);
    }
    expect(pixelFormatBitDepth({ bits_per_raw_sample: '0', bits_per_sample: 12, pix_fmt: 'yuv420p' })).toBe(12);
  });

  it('only reports 8-bit for explicitly known formats and fails closed for unfamiliar ones', () => {
    for (const pix_fmt of ['yuv420p', 'yuvj422p', 'nv12', 'uyvy422', 'rgb24', 'rgba', 'gray8', 'gbrp']) {
      expect(pixelFormatBitDepth({ pix_fmt }), pix_fmt).toBe(8);
      expect(detectDynamicRange({ pix_fmt }), pix_fmt).toBe('sdr');
    }
    expect(pixelFormatBitDepth({ pix_fmt: 'future_vendor_format' })).toBeUndefined();
    expect(pixelFormatBitDepth({})).toBeUndefined();
    expect(detectDynamicRange({
      pix_fmt: 'future_vendor_format', color_transfer: 'bt709', color_primaries: 'bt709',
    })).toBe('unknown');
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

  it('does not guess a Dolby Vision tone-map curve when its base transfer is absent', () => {
    const unknownBase = analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'dolby-vision.mp4',
      video: {
        codec_name: 'hevc', pix_fmt: 'yuv420p10le',
        side_data_list: [{ side_data_type: 'DOVI configuration record' }],
      },
      audio: { codec_name: 'aac' },
    });
    expect(unknownBase).toMatchObject({
      dynamicRange: 'dolby-vision',
      compatibilityMode: 'video-transcode',
    });
    expect(unknownBase.compatibilityReason).toMatch(/不会猜测 PQ\/HLG.*色彩未知/);

    const pqBase = analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'dolby-vision-pq.mp4',
      video: {
        codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084',
        side_data_list: [{ side_data_type: 'DOVI configuration record' }],
      },
      audio: { codec_name: 'aac' },
    });
    expect(pqBase).toMatchObject({ compatibilityMode: 'tone-map' });
    expect(pqBase.compatibilityReason).toMatch(/仅按明确的基底传递函数尝试映射/);
  });

  it('keeps browser-safe SDR H.264/AAC MP4 on the zero-install direct path', () => {
    expect(analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'movie.mp4',
      video: { codec_name: 'h264', profile: 'High', level: 42, pix_fmt: 'yuv420p' },
      audio: { codec_name: 'aac' },
    })).toMatchObject({ directPlay: true, compatibilityMode: 'direct', dynamicRange: 'sdr' });
  });

  it('fail-closes SDR10 and unknown high-bit-depth sources to a dithered compatibility transcode', () => {
    const sdr10 = analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'wide-color.mp4',
      video: {
        codec_name: 'h264', profile: 'High 10', pix_fmt: 'yuv420p10le',
        color_transfer: 'bt709', color_primaries: 'bt709',
      },
      audio: { codec_name: 'aac' },
    });
    expect(sdr10).toMatchObject({
      directPlay: false, compatibilityMode: 'video-transcode', dynamicRange: 'sdr10', bitDepth: 10,
    });
    expect(sdr10.compatibilityReason).toMatch(/10-bit SDR.*高质量抖动/);

    const unknown = analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'untagged-high10.mp4',
      video: { codec_name: 'h264', profile: 'High 10', pix_fmt: 'yuv420p10le' },
      audio: { codec_name: 'aac' },
    });
    expect(unknown).toMatchObject({
      directPlay: false, compatibilityMode: 'video-transcode', dynamicRange: 'unknown', bitDepth: 10,
    });
    expect(unknown.compatibilityReason).toMatch(/无法可靠判定 HDR\/SDR.*不执行猜测式 HDR 映射/);
  });

  it('fail-closes an unknown pixel format instead of assuming browser-safe 8-bit video', () => {
    const result = analyzeMediaCompatibility({
      kind: 'video',
      fileName: 'vendor-camera.mp4',
      video: {
        codec_name: 'h264', profile: 'High', pix_fmt: 'future_vendor_format',
        color_transfer: 'bt709', color_primaries: 'bt709',
      },
      audio: { codec_name: 'aac' },
    });

    expect(result).toMatchObject({
      directPlay: false, compatibilityMode: 'video-transcode', dynamicRange: 'unknown',
    });
    expect(result.bitDepth).toBeUndefined();
    expect(result.compatibilityReason).toMatch(/像素格式、位深.*无法可靠判定 HDR\/SDR/);
  });
});
