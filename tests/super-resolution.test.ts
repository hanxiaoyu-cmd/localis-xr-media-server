import { describe, expect, it } from 'vitest';
import {
  planSuperResolution,
  spatialSuperResolutionFragmentShader,
  stereoSamplingBounds,
  superResolutionRegion,
} from '../app/lib/video-super-resolution';

describe('Localis spatial super-resolution', () => {
  it('plans adaptive upscaling within texture and memory limits', () => {
    expect(planSuperResolution(1280, 720, 'auto')).toMatchObject({
      activeMode: 'upscale', outputWidth: 1920, outputHeight: 1080, scale: 1.5,
    });
    const quality4k = planSuperResolution(3840, 2160, 'quality');
    expect(quality4k.activeMode).toBe('upscale');
    expect(quality4k.outputWidth * quality4k.outputHeight).toBeLessThanOrEqual(12_000_000);
    expect(quality4k.scale).toBeGreaterThan(1);
    expect(planSuperResolution(3840, 2160, 'auto')).toMatchObject({ activeMode: 'sharp', scale: 1 });
    expect(planSuperResolution(1280, 720, 'off')).toMatchObject({ activeMode: 'off', scale: 1 });
  });

  it('refuses unsafe render targets when even the source exceeds the GPU budget', () => {
    expect(planSuperResolution(7680, 4320, 'quality', 8192)).toMatchObject({ activeMode: 'off' });
    expect(planSuperResolution(4096, 2160, 'quality', 2048)).toMatchObject({ activeMode: 'off' });
    expect(planSuperResolution(7680, 4320, 'quality', 8192).reason).toMatch(/GPU/);
  });

  it('keeps SBS and top-bottom sampling inside the current eye region', () => {
    expect(superResolutionRegion('sbs', 0.499, 0.5)).toEqual({ minX: 0, minY: 0, maxX: 0.5, maxY: 1 });
    expect(superResolutionRegion('sbs', 0.501, 0.5)).toEqual({ minX: 0.5, minY: 0, maxX: 1, maxY: 1 });
    expect(superResolutionRegion('tb', 0.5, 0.499)).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 0.5 });
    expect(superResolutionRegion('tb', 0.5, 0.501)).toEqual({ minX: 0, minY: 0.5, maxX: 1, maxY: 1 });
    const left = stereoSamplingBounds('sbs', 0, 1920, 960);
    const right = stereoSamplingBounds('sbs', 1, 1920, 960);
    expect(left.minimum).toBeGreaterThan(0);
    expect(left.minimum + left.span).toBeLessThan(0.5);
    expect(right.minimum).toBeGreaterThan(0.5);
    expect(right.minimum + right.span).toBeLessThan(1);
  });

  it('ships explicit clamping, wrap and finite-value guards in the GPU program', () => {
    expect(spatialSuperResolutionFragmentShader).toContain('safeUv');
    expect(spatialSuperResolutionFragmentShader).toContain('max(dot(weights, vec4(1.0)), 0.0001)');
    expect(spatialSuperResolutionFragmentShader).toContain('clamp(encoded, 0.0, 1.0)');
    expect(spatialSuperResolutionFragmentShader).toContain('mod(mod(coordinate.x');
  });
});
