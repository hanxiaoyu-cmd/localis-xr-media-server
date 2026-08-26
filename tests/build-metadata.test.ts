import { describe, expect, it } from 'vitest';
import {
  BuildMetadataValidationError,
  calculateBuildId,
  createBuildMetadata,
  normalizeBuildTime,
  parseBuildMetadataJson,
  serializeBuildMetadata,
  unavailableBuildMetadata,
  validateBuildMetadata,
} from '../server/build-metadata';

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('build metadata', () => {
  it('creates a canonical, deterministic public build identity', () => {
    const input = {
      version: '0.3.0',
      commitSha: COMMIT_SHA.toUpperCase(),
      buildTime: '2026-08-26T01:02:03Z',
      dirty: true,
      channel: 'NIGHTLY',
    };
    const metadata = createBuildMetadata(input);
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      version: '0.3.0',
      commitSha: COMMIT_SHA,
      commitShortSha: '0123456789ab',
      buildTime: '2026-08-26T01:02:03.000Z',
      dirty: true,
      channel: 'nightly',
    });
    expect(metadata.buildId).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.buildId).toBe(calculateBuildId({
      version: '0.3.0',
      commitSha: COMMIT_SHA,
      buildTime: '2026-08-26T01:02:03.000Z',
      dirty: true,
      channel: 'nightly',
    }));
  });

  it('accepts complete SHA-1 and SHA-256 identities, never abbreviated input', () => {
    const sha256 = 'a'.repeat(64);
    expect(createBuildMetadata({
      version: '1.0.0-beta.1',
      commitSha: sha256,
      buildTime: '2026-08-26T01:02:03.456Z',
      dirty: false,
      channel: 'beta',
    }).commitShortSha).toBe('a'.repeat(12));

    expect(() => createBuildMetadata({
      version: '1.0.0',
      commitSha: COMMIT_SHA.slice(0, 12),
      buildTime: '2026-08-26T01:02:03.000Z',
      dirty: false,
      channel: 'stable',
    })).toThrow(BuildMetadataValidationError);
  });

  it('strictly validates canonical UTC time and rejects calendar overflow', () => {
    expect(normalizeBuildTime('2026-08-26T01:02:03.4Z')).toBe('2026-08-26T01:02:03.400Z');
    expect(normalizeBuildTime('2026-08-26T09:02:03+08:00')).toBeUndefined();
    expect(normalizeBuildTime('2026-02-30T01:02:03Z')).toBeUndefined();
    expect(normalizeBuildTime('2026-08-26')).toBeUndefined();

    const valid = createBuildMetadata({
      version: '0.3.0',
      commitSha: COMMIT_SHA,
      buildTime: '2026-08-26T01:02:03Z',
      dirty: false,
      channel: 'local',
    });
    expect(validateBuildMetadata({ ...valid, buildTime: '2026-08-26T01:02:03Z' })).toEqual({
      ok: false,
      issues: ['invalid_build_time'],
    });
  });

  it('rejects a mismatched short SHA, invalid fields and unexpected data', () => {
    const valid = createBuildMetadata({
      version: '0.3.0',
      commitSha: COMMIT_SHA,
      buildTime: '2026-08-26T01:02:03Z',
      dirty: false,
      channel: 'stable',
    });

    expect(validateBuildMetadata({ ...valid, commitShortSha: 'ffffffffffff' })).toEqual({
      ok: false,
      issues: ['commit_short_sha_mismatch'],
    });
    expect(validateBuildMetadata({ ...valid, buildId: 'f'.repeat(64) })).toEqual({
      ok: false,
      issues: ['build_id_mismatch'],
    });
    expect(validateBuildMetadata({ ...valid, cwd: 'must-not-be-persisted' })).toEqual({
      ok: false,
      issues: ['unexpected_fields'],
    });
    expect(validateBuildMetadata({ ...valid, channel: 'release/candidate', dirty: 'false' })).toEqual({
      ok: false,
      issues: ['invalid_dirty', 'invalid_channel'],
    });
  });

  it('parses and serializes only validated metadata', () => {
    const metadata = createBuildMetadata({
      version: '0.3.0',
      commitSha: COMMIT_SHA,
      buildTime: '2026-08-26T01:02:03.001Z',
      dirty: false,
      channel: 'ci',
    });
    const serialized = serializeBuildMetadata(metadata);

    expect(serialized.endsWith('\n')).toBe(true);
    expect(parseBuildMetadataJson(serialized)).toEqual({ ok: true, metadata });
    expect(parseBuildMetadataJson('{not json')).toEqual({ ok: false, issues: ['invalid_json'] });
  });

  it('uses an explicit unavailable fallback without paths or raw errors', () => {
    expect(unavailableBuildMetadata('missing')).toEqual({
      available: false,
      status: 'unavailable',
      reason: 'missing',
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
    });
  });
});
