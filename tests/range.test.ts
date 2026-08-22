import { describe, expect, it } from 'vitest';
import { parseByteRange, RangeNotSatisfiableError } from '../server/range';

describe('parseByteRange', () => {
  it('parses fixed, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=0-0', 100)).toEqual({ start: 0, end: 0, length: 1 });
    expect(parseByteRange('bytes=40-59', 100)).toEqual({ start: 40, end: 59, length: 20 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99, length: 10 });
    expect(parseByteRange('bytes=-12', 100)).toEqual({ start: 88, end: 99, length: 12 });
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99, length: 10 });
  });

  it('rejects malformed, multiple and unsatisfiable ranges', () => {
    for (const value of ['items=0-1', 'bytes=', 'bytes=10-5', 'bytes=1-2,5-7', 'bytes=100-']) {
      expect(() => parseByteRange(value, 100), value).toThrow(RangeNotSatisfiableError);
    }
  });
});
