import { describe, expect, it } from 'vitest';
import { stereoSamplingBounds } from '../app/lib/xr-video-stage';

describe('XR stereo texture sampling', () => {
  it('maps TB left eye to the source top half after VideoTexture flipY', () => {
    const left = stereoSamplingBounds('tb', 0, 3840, 2160);
    const right = stereoSamplingBounds('tb', 1, 3840, 2160);
    expect(left.minimum).toBeGreaterThan(0.5);
    expect(left.minimum + left.span).toBeLessThan(1);
    expect(right.minimum).toBeGreaterThan(0);
    expect(right.minimum + right.span).toBeLessThan(0.5);
  });

  it('keeps SBS left and right eyes in their horizontal halves', () => {
    const left = stereoSamplingBounds('sbs', 0, 3840, 2160);
    const right = stereoSamplingBounds('sbs', 1, 3840, 2160);
    expect(left.minimum + left.span).toBeLessThan(0.5);
    expect(right.minimum).toBeGreaterThan(0.5);
  });
});
