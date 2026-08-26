import { describe, expect, it } from 'vitest';
import {
  qualifiesXrOriginalSample,
  type XrOriginalSamplePoint,
} from '../app/lib/xr-original-sample';

const start: XrOriginalSamplePoint = { wallTime: 1_000, mediaTime: 20, totalFrames: 500 };

describe('guided WebXR original sample', () => {
  it('requires wall time, media progression and decoded frame progression together', () => {
    expect(qualifiesXrOriginalSample(
      start,
      { wallTime: 11_000, mediaTime: 29.5, totalFrames: 720 },
      true,
    )).toBe(true);
  });

  it('rejects a paused, stalled, too-short, non-direct or missing sample', () => {
    expect(qualifiesXrOriginalSample(start, { wallTime: 11_000, mediaTime: 20, totalFrames: 500 }, true)).toBe(false);
    expect(qualifiesXrOriginalSample(start, { wallTime: 10_999, mediaTime: 30, totalFrames: 720 }, true)).toBe(false);
    expect(qualifiesXrOriginalSample(start, { wallTime: 11_000, mediaTime: 30, totalFrames: 500 }, true)).toBe(false);
    expect(qualifiesXrOriginalSample(start, { wallTime: 11_000, mediaTime: 30, totalFrames: 720 }, false)).toBe(false);
    expect(qualifiesXrOriginalSample(undefined, { wallTime: 11_000, mediaTime: 30 }, true)).toBe(false);
  });

  it('works when a browser does not expose frame counters', () => {
    expect(qualifiesXrOriginalSample(
      { wallTime: 0, mediaTime: 0 },
      { wallTime: 10_000, mediaTime: 9.5 },
      true,
    )).toBe(true);
  });
});
