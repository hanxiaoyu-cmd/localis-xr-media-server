import { describe, expect, it } from 'vitest';
import {
  buildAiFrameExtractionFilters,
  buildHdrToSdrFilters,
  buildVideoPipeline,
  isH264Level52Safe,
  isHdrToneMappedToSdr,
  parseServerSuperResolutionLevel,
  ServerSuperResolutionUnavailableError,
  serverSuperResolutionPlan,
} from '../server/super-resolution';

describe('computer-side super-resolution profiles', () => {
  it('accepts only explicit profile names', () => {
    expect(parseServerSuperResolutionLevel('standard')).toBe('standard');
    expect(parseServerSuperResolutionLevel('ultra')).toBe('ultra');
    expect(parseServerSuperResolutionLevel('ai')).toBe('ai');
    expect(parseServerSuperResolutionLevel('auto')).toBe('off');
    expect(parseServerSuperResolutionLevel('../ultra')).toBe('off');
  });

  it('plans aligned, bounded output dimensions for every level', () => {
    const item = { width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono' as const };
    expect(serverSuperResolutionPlan(item, 'off')).toMatchObject({ outputWidth: 1280, outputHeight: 720, activeMode: 'off' });
    expect(serverSuperResolutionPlan(item, 'standard')).toMatchObject({ outputWidth: 1600, outputHeight: 900, activeMode: 'upscale' });
    expect(serverSuperResolutionPlan(item, 'high')).toMatchObject({ outputWidth: 1920, outputHeight: 1080, activeMode: 'upscale' });
    expect(serverSuperResolutionPlan(item, 'ultra')).toMatchObject({ outputWidth: 2560, outputHeight: 1440, activeMode: 'upscale' });
    expect(serverSuperResolutionPlan(item, 'ai')).toMatchObject({ outputWidth: 2560, outputHeight: 1440, activeMode: 'upscale' });
    const square = serverSuperResolutionPlan({ width: 4096, height: 4096, frameRate: 30, sampleAspectRatio: '1:1', stereo: 'mono' }, 'ultra');
    expect(square).toMatchObject({ available: false, enabled: false, activeMode: 'off' });
    expect(square.reason).toMatch(/Level 5\.2/);
  });

  it('never downscales a source merely because it exceeds a profile budget', () => {
    const uhd = { width: 3840, height: 2160, frameRate: 30, sampleAspectRatio: '1:1', stereo: 'mono' as const };
    expect(serverSuperResolutionPlan(uhd, 'standard')).toMatchObject({
      available: true,
      activeMode: 'sharpen',
      outputWidth: 3840,
      outputHeight: 2160,
    });
    const plan = serverSuperResolutionPlan({ ...uhd, frameRate: 60 }, 'ultra');
    expect(plan.outputWidth).toBeGreaterThanOrEqual(uhd.width);
    expect(plan.outputHeight).toBeGreaterThanOrEqual(uhd.height);
    expect(isH264Level52Safe(plan.outputWidth!, plan.outputHeight!, plan.outputFrameRate!)).toBe(true);
  });

  it('keeps compatibility H.264 transcodes inside Level 5.2 without changing enhanced no-downsample policy', () => {
    const source = { width: 3840, height: 2880, frameRate: 60, sampleAspectRatio: '1:1', stereo: 'mono' as const };
    const compatibility = serverSuperResolutionPlan(source, 'off');
    expect(compatibility.outputWidth).toBeLessThan(source.width);
    expect(compatibility.outputHeight).toBeLessThan(source.height);
    expect(isH264Level52Safe(
      compatibility.outputWidth!, compatibility.outputHeight!, compatibility.outputFrameRate!,
    )).toBe(true);

    const enhanced = serverSuperResolutionPlan(source, 'high');
    expect(enhanced).toMatchObject({
      available: false,
      outputWidth: source.width,
      outputHeight: source.height,
    });
  });

  it('rejects enhanced output when unknown or already unsafe source dimensions cannot be preserved', () => {
    const unknown = serverSuperResolutionPlan({ stereo: 'mono' }, 'high');
    expect(unknown).toMatchObject({ available: false, enabled: false, activeMode: 'off' });
    expect(() => buildVideoPipeline({ stereo: 'mono', frameRate: 30 }, 'high', 'yuv420p'))
      .toThrow(ServerSuperResolutionUnavailableError);

    const unknownCompatibility = buildVideoPipeline({ stereo: 'mono' }, 'off', 'yuv420p');
    expect(unknownCompatibility.filters?.join(',')).toContain('sqrt(8000000/(iw*sar*ih))');

    const vr5k = serverSuperResolutionPlan({
      width: 5760, height: 2880, frameRate: 30, sampleAspectRatio: '1:1', stereo: 'sbs',
    }, 'standard');
    expect(vr5k).toMatchObject({ available: false, outputWidth: 5760, outputHeight: 2880 });
  });

  it('converts anamorphic pixels to the equivalent square-pixel display aspect', () => {
    const plan = serverSuperResolutionPlan({ width: 720, height: 576, sampleAspectRatio: '16:15', stereo: 'mono' }, 'standard');
    expect(plan.outputWidth).toBe(960);
    expect(plan.outputHeight).toBe(720);

    const narrowPixels = serverSuperResolutionPlan({
      width: 3840, height: 2160, frameRate: 30, sampleAspectRatio: '8:9', stereo: 'mono',
    }, 'standard');
    expect(narrowPixels.available).toBe(true);
    expect(narrowPixels.outputWidth).toBeGreaterThanOrEqual(3840);
    expect(narrowPixels.outputHeight).toBeGreaterThanOrEqual(2160);
    expect(narrowPixels.outputWidth! / narrowPixels.outputHeight!).toBeCloseTo((3840 * 8 / 9) / 2160, 2);
  });

  it('processes SBS and TB eyes independently before stacking', () => {
    const sbs = buildVideoPipeline({ width: 1280, height: 640, sampleAspectRatio: '1:1', stereo: 'sbs', frameRate: 30 }, 'high', 'yuv420p');
    expect(sbs.filterComplex).toContain('crop=w=iw/2');
    expect(sbs.filterComplex).toContain('hstack=inputs=2');
    expect(sbs.outputLabel).toBe('[sr_video]');
    const tb = buildVideoPipeline({ width: 640, height: 1280, sampleAspectRatio: '1:1', stereo: 'tb', frameRate: 30 }, 'ultra', 'yuv420p');
    expect(tb.filterComplex).toContain('crop=w=iw:h=ih/2');
    expect(tb.filterComplex).toContain('vstack=inputs=2');

    const sphericalSbs = buildVideoPipeline({
      width: 1280, height: 640, sampleAspectRatio: '1:1', stereo: 'sbs', frameRate: 30, projection: 'equirect360',
    }, 'high', 'yuv420p');
    expect(sphericalSbs.filterComplex).toBeUndefined();
    expect(sphericalSbs.filters?.join(',')).toContain('v360=input=equirect:output=equirect:in_stereo=sbs:out_stereo=sbs:w=960:h=960:interp=lanczos');
    expect(sphericalSbs.filters?.join(',')).not.toContain('cas=');
  });

  it('bounds AI reconstruction to seam-safe source layouts', () => {
    const flat = serverSuperResolutionPlan({
      width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono', frameRate: 30, projection: 'flat',
    }, 'ai');
    expect(flat).toMatchObject({ available: true, outputWidth: 2560, outputHeight: 1440 });

    const stereo = serverSuperResolutionPlan({
      width: 1920, height: 1080, sampleAspectRatio: '1:1', stereo: 'sbs', frameRate: 30, projection: 'equirect180',
    }, 'ai');
    expect(stereo).toMatchObject({ available: false, activeMode: 'off' });
    expect(stereo.reason).toMatch(/SBS\/TB/);

    const spherical = serverSuperResolutionPlan({
      width: 1920, height: 960, sampleAspectRatio: '1:1', stereo: 'mono', frameRate: 30, projection: 'equirect360',
    }, 'ai');
    expect(spherical).toMatchObject({ available: false, activeMode: 'off' });
    expect(() => buildVideoPipeline({
      width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono', frameRate: 30, projection: 'flat',
    }, 'ai', 'yuv420p')).toThrow(/Real-ESRGAN/);
  });

  it('uses host-side zscale and CAS and caps high frame rates', () => {
    const pipeline = buildVideoPipeline({ width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono', frameRate: 120 }, 'high', 'yuv420p');
    expect(pipeline.filters?.join(',')).toContain('zscale=w=1920:h=1080:f=spline36');
    expect(pipeline.filters?.join(',')).toContain('cas=strength=0.14:planes=1');
    expect(pipeline.filters?.join(',')).toContain('fps=60');
  });

  it.each([
    ['mono', 'filters'],
    ['sbs', 'filterComplex'],
    ['tb', 'filterComplex'],
  ] as const)('sharpens all planar GBR channels after HDR tone-map for %s video', (stereo, pipelineProperty) => {
    const pipeline = buildVideoPipeline({
      width: stereo === 'tb' ? 640 : 1280,
      height: stereo === 'tb' ? 1280 : 640,
      sampleAspectRatio: '1:1',
      stereo,
      frameRate: 30,
      dynamicRange: 'hdr10',
      colorTransfer: 'smpte2084',
      bitDepth: 10,
    }, 'high', 'yuv420p');
    const graph = pipelineProperty === 'filters'
      ? pipeline.filters?.join(',')
      : pipeline.filterComplex;
    expect(graph).toContain('format=gbrpf32le');
    expect(graph).toContain('cas=strength=0.14:planes=7');
    expect(graph).not.toContain('cas=strength=0.14:planes=1');
    if (stereo !== 'mono') {
      expect(graph?.match(/cas=strength=0\.14:planes=7/g)).toHaveLength(2);
    }
  });

  it.each(['sbs', 'tb'] as const)('keeps luma-only CAS for ordinary %s SDR YUV', (stereo) => {
    const pipeline = buildVideoPipeline({
      width: stereo === 'tb' ? 640 : 1280,
      height: stereo === 'tb' ? 1280 : 640,
      sampleAspectRatio: '1:1', stereo, frameRate: 30,
      dynamicRange: 'sdr', colorTransfer: 'bt709', bitDepth: 8,
    }, 'high', 'yuv420p');
    expect(pipeline.filterComplex?.match(/cas=strength=0\.14:planes=1/g)).toHaveLength(2);
    expect(pipeline.filterComplex).not.toContain('planes=7');
  });

  it('uses high-quality dithering only when reducing high bit depth to the 8-bit compatibility output', () => {
    const base = {
      width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono' as const, frameRate: 30,
    };
    const ordinary = buildVideoPipeline({ ...base, dynamicRange: 'sdr' as const, bitDepth: 8 }, 'off', 'yuv420p');
    expect(ordinary.filters).not.toContain('zscale=dither=error_diffusion');

    const sdr10 = buildVideoPipeline({ ...base, dynamicRange: 'sdr10' as const, bitDepth: 10 }, 'off', 'yuv420p');
    expect(sdr10.filters).toContain('zscale=dither=error_diffusion');
    expect(sdr10.filters?.join(',')).not.toContain('tonemap=');

    const unknown12 = buildVideoPipeline({ ...base, dynamicRange: 'unknown' as const, bitDepth: 12 }, 'high', 'nv12');
    expect(unknown12.filters).toContain('zscale=dither=error_diffusion');
    expect(unknown12.filters?.at(-1)).toBe('format=nv12');
  });

  it('tone-maps HDR to BT.709 before applying the final 8-bit error-diffusion dither', () => {
    const pipeline = buildVideoPipeline({
      width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono', frameRate: 30,
      dynamicRange: 'hdr10', bitDepth: 10,
    }, 'off', 'yuv420p');
    const filters = pipeline.filters || [];
    expect(filters[0]).toBe('setparams=range=tv:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc');
    expect(filters).toContain('tonemap=tonemap=hable:desat=0');
    expect(filters).toContain('zscale=p=bt709:t=bt709:m=bt709:r=tv');
    expect(filters.indexOf('zscale=p=bt709:t=bt709:m=bt709:r=tv'))
      .toBeLessThan(filters.indexOf('zscale=dither=error_diffusion'));
    expect(filters.at(-1)).toBe('format=yuv420p');
  });

  it('builds explicit RGB24 AI inputs and only claims dithering for a precision reduction', () => {
    const ordinary = buildAiFrameExtractionFilters(
      { dynamicRange: 'sdr', colorTransfer: 'bt709', bitDepth: 8 },
      30, 640, 360, 4,
    );
    expect(ordinary).not.toContain('zscale=dither=error_diffusion');
    expect(ordinary.at(-1)).toBe('format=rgb24');

    const highBit = buildAiFrameExtractionFilters(
      { dynamicRange: 'sdr10', colorTransfer: 'bt709', bitDepth: 10 },
      30, 640, 360, 4,
    );
    expect(highBit.indexOf('scale=w=640:h=360:flags=lanczos'))
      .toBeLessThan(highBit.indexOf('zscale=dither=error_diffusion'));
    expect(highBit.indexOf('zscale=dither=error_diffusion'))
      .toBeLessThan(highBit.indexOf('format=rgb24'));

    const hdr = buildAiFrameExtractionFilters(
      { dynamicRange: 'hdr10', colorTransfer: 'smpte2084', bitDepth: 10 },
      24, 320, 180, 3.5,
    );
    expect(hdr.indexOf('tonemap=tonemap=hable:desat=0'))
      .toBeLessThan(hdr.indexOf('scale=w=320:h=180:flags=lanczos'));
    expect(hdr.indexOf('scale=w=320:h=180:flags=lanczos'))
      .toBeLessThan(hdr.indexOf('zscale=dither=error_diffusion'));
    expect(hdr.at(-1)).toBe('format=rgb24');
  });

  it('does not guess a Dolby Vision base transfer or label it as tone-mapped SDR', () => {
    const unknownBase = { dynamicRange: 'dolby-vision' as const, bitDepth: 10 };
    expect(buildHdrToSdrFilters(unknownBase)).toEqual([]);
    expect(isHdrToneMappedToSdr(unknownBase)).toBe(false);

    const pq = buildHdrToSdrFilters({ ...unknownBase, colorTransfer: 'smpte2084' });
    expect(pq[0]).toContain('color_trc=smpte2084');
    expect(isHdrToneMappedToSdr({ ...unknownBase, colorTransfer: 'smpte2084' })).toBe(true);

    const hlg = buildHdrToSdrFilters({ ...unknownBase, colorTransfer: 'arib-std-b67' });
    expect(hlg[0]).toContain('color_trc=arib-std-b67');
    expect(isHdrToneMappedToSdr({ ...unknownBase, colorTransfer: 'arib-std-b67' })).toBe(true);

    expect(buildHdrToSdrFilters({ ...unknownBase, colorTransfer: 'bt709' })).toEqual([]);
  });

  it('preserves an explicitly full-range HDR input when establishing missing HDR tags', () => {
    expect(buildHdrToSdrFilters({
      dynamicRange: 'hdr10', colorTransfer: 'smpte2084', colorRange: 'pc',
    })[0]).toContain('setparams=range=pc:');
  });
});
