export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export class RangeNotSatisfiableError extends Error {}

export function parseByteRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header) return undefined;
  if (!Number.isSafeInteger(size) || size < 0 || !header.startsWith('bytes=')) {
    throw new RangeNotSatisfiableError('Invalid range');
  }

  const value = header.slice(6).trim();
  if (!value || value.includes(',')) throw new RangeNotSatisfiableError('Only one byte range is supported');
  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new RangeNotSatisfiableError('Malformed range');

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new RangeNotSatisfiableError('Invalid suffix');
    start = Math.max(0, size - suffixLength);
    end = Math.max(0, size - 1);
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw new RangeNotSatisfiableError('Invalid range bounds');
    }
    end = Math.min(end, size - 1);
  }

  if (size === 0 || start >= size) throw new RangeNotSatisfiableError('Range starts after the resource');
  return { start, end, length: end - start + 1 };
}
