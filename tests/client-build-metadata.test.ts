import { describe, expect, it } from 'vitest';
import { buildReloadKey, compareBuildMetadata } from '../app/lib/client-build-metadata';
import type { BuildMetadata, BuildMetadataReadResult } from '../server/build-metadata';

const client: BuildMetadata = {
  schemaVersion: 1,
  buildId: 'a'.repeat(64),
  version: '0.3.0',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  commitShortSha: '0123456789ab',
  buildTime: '2026-08-26T01:02:03.000Z',
  dirty: false,
  channel: 'test',
};

function available(metadata: BuildMetadata): BuildMetadataReadResult {
  return { available: true, status: 'available', metadata };
}

describe('client/server build compatibility', () => {
  it('matches only the exact build id', () => {
    expect(compareBuildMetadata(client, available(client))).toBe('match');
    expect(compareBuildMetadata(client, available({ ...client, buildId: 'b'.repeat(64) }))).toBe('mismatch');
  });

  it('fails closed for an identified client connected to an old or invalid server', () => {
    expect(compareBuildMetadata(client, undefined)).toBe('mismatch');
    expect(compareBuildMetadata(client, {
      available: false,
      status: 'unavailable',
      reason: 'invalid',
      metadata: {
        schemaVersion: 1,
        buildId: 'unavailable',
        version: 'unavailable',
        commitSha: 'unavailable',
        commitShortSha: 'unavailable',
        buildTime: 'unavailable',
        dirty: null,
        channel: 'unavailable',
      },
    })).toBe('mismatch');
  });

  it('does not block source-mode development without an embedded client identity', () => {
    expect(compareBuildMetadata(undefined, available(client))).toBe('unverifiable');
  });

  it('uses both identities in the one-shot reload key', () => {
    expect(buildReloadKey(client, available({ ...client, buildId: 'b'.repeat(64) })))
      .toBe(`localis-build-reload:${'a'.repeat(64)}:${'b'.repeat(64)}`);
  });
});
