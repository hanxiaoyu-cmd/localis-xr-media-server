import { describe, expect, it } from 'vitest';
import { savedServerSuperResolution } from '../app/lib/server-super-resolution-preference';

function storage(values: Record<string, string> = {}) {
  return {
    getItem(key: string) {
      return values[key] ?? null;
    },
  };
}

describe('server super-resolution preference', () => {
  it('defaults to original-first when storage or a saved preference is absent', () => {
    expect(savedServerSuperResolution()).toBe('off');
    expect(savedServerSuperResolution(storage())).toBe('off');
  });

  it.each(['off', 'standard', 'high', 'ultra', 'ai'] as const)(
    'preserves an explicit current preference of %s',
    (level) => {
      expect(savedServerSuperResolution(storage({ 'localis.serverSuperResolution': level }))).toBe(level);
    },
  );

  it.each([
    ['off', 'off'],
    ['auto', 'standard'],
    ['quality', 'high'],
    ['sharp', 'standard'],
  ] as const)('keeps the legacy %s preference compatible as %s', (legacy, expected) => {
    expect(savedServerSuperResolution(storage({ 'localis.superResolution': legacy }))).toBe(expected);
  });

  it('prefers an explicit current preference over a legacy preference', () => {
    expect(savedServerSuperResolution(storage({
      'localis.serverSuperResolution': 'ultra',
      'localis.superResolution': 'off',
    }))).toBe('ultra');
  });

  it('does not enable enhancement for unknown stored values', () => {
    expect(savedServerSuperResolution(storage({ 'localis.serverSuperResolution': 'future-mode' }))).toBe('off');
    expect(savedServerSuperResolution(storage({
      'localis.serverSuperResolution': 'future-mode',
      'localis.superResolution': 'quality',
    }))).toBe('off');
    expect(savedServerSuperResolution(storage({ 'localis.superResolution': 'future-mode' }))).toBe('off');
  });
});
