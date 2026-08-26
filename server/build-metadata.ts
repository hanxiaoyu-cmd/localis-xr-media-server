import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_METADATA_FILE_NAME = 'build-metadata.json';
export const BUILD_METADATA_SHORT_SHA_LENGTH = 12;

const BUILD_METADATA_KEYS = [
  'schemaVersion',
  'buildId',
  'version',
  'commitSha',
  'commitShortSha',
  'buildTime',
  'dirty',
  'channel',
] as const;

const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHORT_SHA_PATTERN = /^[0-9a-f]{12}$/;
const CANONICAL_ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INPUT_ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const BUILD_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface BuildMetadata {
  schemaVersion: 1;
  buildId: string;
  version: string;
  commitSha: string;
  commitShortSha: string;
  buildTime: string;
  dirty: boolean;
  channel: string;
}

export interface BuildMetadataInput {
  version: string;
  commitSha: string;
  buildTime: string;
  dirty: boolean;
  channel: string;
}

export type BuildMetadataIssue =
  | 'invalid_json'
  | 'not_an_object'
  | 'unexpected_fields'
  | 'invalid_schema_version'
  | 'invalid_build_id'
  | 'build_id_mismatch'
  | 'invalid_version'
  | 'invalid_commit_sha'
  | 'invalid_commit_short_sha'
  | 'commit_short_sha_mismatch'
  | 'invalid_build_time'
  | 'invalid_dirty'
  | 'invalid_channel';

export type BuildMetadataValidationResult =
  | { ok: true; metadata: BuildMetadata }
  | { ok: false; issues: BuildMetadataIssue[] };

export type BuildMetadataUnavailableReason = 'missing' | 'unreadable' | 'invalid';

export interface UnavailableBuildMetadata {
  schemaVersion: 1;
  buildId: 'unavailable';
  version: 'unavailable';
  commitSha: 'unavailable';
  commitShortSha: 'unavailable';
  buildTime: 'unavailable';
  dirty: null;
  channel: 'unavailable';
}

export type BuildMetadataReadResult =
  | {
      available: true;
      status: 'available';
      metadata: BuildMetadata;
    }
  | {
      available: false;
      status: 'unavailable';
      reason: BuildMetadataUnavailableReason;
      metadata: UnavailableBuildMetadata;
    };

export class BuildMetadataValidationError extends Error {
  readonly issues: BuildMetadataIssue[];

  constructor(issues: BuildMetadataIssue[]) {
    super(`Invalid build metadata (${issues.join(', ')})`);
    this.name = 'BuildMetadataValidationError';
    this.issues = [...issues];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCanonicalIsoTime(value: string): boolean {
  if (!CANONICAL_ISO_TIME_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function calculateBuildId(input: BuildMetadataInput): string {
  const canonicalIdentity = JSON.stringify({
    schemaVersion: 1,
    version: input.version,
    commitSha: input.commitSha,
    buildTime: input.buildTime,
    dirty: input.dirty,
    channel: input.channel,
  });
  return createHash('sha256').update(canonicalIdentity, 'utf8').digest('hex');
}

/**
 * Converts an accepted UTC ISO-8601 input to the single on-disk representation.
 * Offsets, date-only strings and calendar overflow are deliberately rejected.
 */
export function normalizeBuildTime(value: string): string | undefined {
  const candidate = value.trim();
  if (!INPUT_ISO_TIME_PATTERN.test(candidate)) return undefined;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  const canonical = parsed.toISOString();

  const inputWithoutMilliseconds = candidate.replace(/\.\d{1,3}Z$/, 'Z');
  const canonicalWithoutMilliseconds = canonical.replace(/\.\d{3}Z$/, 'Z');
  if (inputWithoutMilliseconds !== canonicalWithoutMilliseconds) return undefined;
  return canonical;
}

export function validateBuildMetadata(value: unknown): BuildMetadataValidationResult {
  if (!isRecord(value)) return { ok: false, issues: ['not_an_object'] };

  const issues: BuildMetadataIssue[] = [];
  const keys = Object.keys(value).sort();
  const expectedKeys = [...BUILD_METADATA_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    issues.push('unexpected_fields');
  }

  if (value.schemaVersion !== 1) issues.push('invalid_schema_version');
  if (typeof value.buildId !== 'string' || !BUILD_ID_PATTERN.test(value.buildId)) {
    issues.push('invalid_build_id');
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    issues.push('invalid_version');
  }
  if (typeof value.commitSha !== 'string' || !FULL_SHA_PATTERN.test(value.commitSha)) {
    issues.push('invalid_commit_sha');
  }
  if (typeof value.commitShortSha !== 'string' || !SHORT_SHA_PATTERN.test(value.commitShortSha)) {
    issues.push('invalid_commit_short_sha');
  }
  if (
    typeof value.commitSha === 'string'
    && FULL_SHA_PATTERN.test(value.commitSha)
    && typeof value.commitShortSha === 'string'
    && SHORT_SHA_PATTERN.test(value.commitShortSha)
    && value.commitShortSha !== value.commitSha.slice(0, BUILD_METADATA_SHORT_SHA_LENGTH)
  ) {
    issues.push('commit_short_sha_mismatch');
  }
  if (typeof value.buildTime !== 'string' || !hasCanonicalIsoTime(value.buildTime)) {
    issues.push('invalid_build_time');
  }
  if (typeof value.dirty !== 'boolean') issues.push('invalid_dirty');
  if (typeof value.channel !== 'string' || !CHANNEL_PATTERN.test(value.channel)) {
    issues.push('invalid_channel');
  }

  if (
    issues.every((issue) => ![
      'invalid_schema_version',
      'invalid_build_id',
      'invalid_version',
      'invalid_commit_sha',
      'invalid_build_time',
      'invalid_dirty',
      'invalid_channel',
    ].includes(issue))
    && value.buildId !== calculateBuildId({
      version: value.version as string,
      commitSha: value.commitSha as string,
      buildTime: value.buildTime as string,
      dirty: value.dirty as boolean,
      channel: value.channel as string,
    })
  ) {
    issues.push('build_id_mismatch');
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, metadata: value as unknown as BuildMetadata };
}

export function createBuildMetadata(input: BuildMetadataInput): BuildMetadata {
  const commitSha = input.commitSha.trim().toLowerCase();
  const buildTime = normalizeBuildTime(input.buildTime);
  const candidate = {
    schemaVersion: 1 as const,
    buildId: '',
    version: input.version.trim(),
    commitSha,
    commitShortSha: commitSha.slice(0, BUILD_METADATA_SHORT_SHA_LENGTH),
    buildTime: buildTime ?? input.buildTime.trim(),
    dirty: input.dirty,
    channel: input.channel.trim().toLowerCase(),
  };
  candidate.buildId = calculateBuildId(candidate);
  const result = validateBuildMetadata(candidate);
  if (!result.ok) throw new BuildMetadataValidationError(result.issues);
  return result.metadata;
}

export function parseBuildMetadataJson(value: string): BuildMetadataValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { ok: false, issues: ['invalid_json'] };
  }
  return validateBuildMetadata(parsed);
}

export function serializeBuildMetadata(metadata: BuildMetadata): string {
  const result = validateBuildMetadata(metadata);
  if (!result.ok) throw new BuildMetadataValidationError(result.issues);
  return `${JSON.stringify(result.metadata, null, 2)}\n`;
}

export function unavailableBuildMetadata(reason: BuildMetadataUnavailableReason): BuildMetadataReadResult {
  return {
    available: false,
    status: 'unavailable',
    reason,
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
  };
}

export function defaultBuildMetadataPath(moduleUrl = import.meta.url): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  if (path.basename(moduleDirectory) === 'server') {
    return path.resolve(moduleDirectory, '..', 'desktop', 'build', BUILD_METADATA_FILE_NAME);
  }
  return path.join(moduleDirectory, BUILD_METADATA_FILE_NAME);
}

/** Reads only the generated public build identity and never exposes paths or I/O errors. */
export async function readBuildMetadata(filePath = defaultBuildMetadataPath()): Promise<BuildMetadataReadResult> {
  let value: string;
  try {
    value = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    return unavailableBuildMetadata(code === 'ENOENT' ? 'missing' : 'unreadable');
  }

  const result = parseBuildMetadataJson(value);
  if (!result.ok) return unavailableBuildMetadata('invalid');
  return { available: true, status: 'available', metadata: result.metadata };
}

const embeddedBuildMetadataJson = process.env.LOCALIS_EMBEDDED_BUILD_METADATA;

/** Uses the server-bundle identity when present; source-mode servers fall back to the generated file. */
export async function getBuildMetadata(filePath?: string): Promise<BuildMetadataReadResult> {
  if (!filePath && embeddedBuildMetadataJson) {
    const result = parseBuildMetadataJson(embeddedBuildMetadataJson);
    return result.ok
      ? { available: true, status: 'available', metadata: result.metadata }
      : unavailableBuildMetadata('invalid');
  }
  return readBuildMetadata(filePath);
}
