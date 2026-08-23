import { describe, expect, it } from 'vitest';
import {
  buildVideoPipeline,
  isH264Level52Safe,
  parseServerSuperResolutionLevel,
  ServerSuperResolutionUnavailableError,
  serverSuperResolutionPlan,
} from '../server/super-resolution';

describe('computer-side super-resolution profiles', () => {
  it('accepts only explicit profile names', () => {
    expect(parseServerSuperResolutionLevel('standard')).toBe('standard');
    expect(parseServerSuperResolutionLevel('ultra')).toBe('ultra');
    expect(parseServerSuperResolutionLevel('auto')).toBe('off');
    expect(parseServerSuperResolutionLevel('../ultra')).toBe('off');
  });

  it('plans aligned, bounded output dimensions for every level', () => {
    const item = { width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono' as const };
    expect(serverSuperResolutionPlan(item, 'off')).toMatchObject({ outputWidth: 1280, outputHeight: 720, activeMode: 'off' });
    expect(serverSuperResolutionPlan(item, 'standard')).toMatchObject({ outputWidth: 1600, outputHeight: 900, activeMode: 'upscale' });
    expect(serverSuperResolutionPlan(item, 'high')).toMatchObject({ outputWidth: 1920, outputHeight: 1080, activeMode: 'upscale' });
    expect(serverSuperResolutionPlan(item, 'ultra')).toMatchObject({ outputWidth: 2560, outputHeight: 1440, activeMode: 'upscale' });
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

  it('uses host-side zscale and CAS and caps high frame rates', () => {
    const pipeline = buildVideoPipeline({ width: 1280, height: 720, sampleAspectRatio: '1:1', stereo: 'mono', frameRate: 120 }, 'high', 'yuv420p');
    expect(pipeline.filters?.join(',')).toContain('zscale=w=1920:h=1080:f=spline36');
    expect(pipeline.filters?.join(',')).toContain('cas=strength=0.14');
    expect(pipeline.filters?.join(',')).toContain('fps=60');
  });
});
