import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBuildMetadata,
  normalizeBuildTime,
  parseBuildMetadataJson,
} from '../server/build-metadata';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const metadataPath = path.join(repositoryRoot, 'desktop', 'build', 'build-metadata.json');

async function packageVersions(): Promise<{ packageVersion?: string; lockVersion?: string }> {
  try {
    const [packageDocument, lockDocument] = await Promise.all([
      readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
      readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    ]);
    const parsed = JSON.parse(packageDocument) as { version?: unknown };
    const lock = JSON.parse(lockDocument) as { version?: unknown; packages?: Record<string, { version?: unknown }> };
    const packageVersion = typeof parsed.version === 'string' ? parsed.version : undefined;
    const rootLockVersion = lock.packages?.['']?.version;
    const lockVersion = typeof rootLockVersion === 'string'
      ? rootLockVersion
      : typeof lock.version === 'string' ? lock.version : undefined;
    return { packageVersion, lockVersion };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(metadataPath, 'utf8');
  } catch {
    throw new Error('unavailable');
  }

  const result = parseBuildMetadataJson(contents);
  if (!result.ok) throw new Error(`invalid:${result.issues.join(',')}`);
  const metadata = result.metadata;

  const versions = await packageVersions();
  if (!versions.packageVersion || metadata.version !== versions.packageVersion) throw new Error('version_mismatch');
  if (!versions.lockVersion || versions.packageVersion !== versions.lockVersion) throw new Error('lock_version_mismatch');

  const expectedCommit = process.env.LOCALIS_COMMIT_SHA?.trim();
  if (expectedCommit) {
    const normalized = expectedCommit.toLowerCase();
    const expected = createBuildMetadata({
      version: metadata.version,
      commitSha: normalized,
      buildTime: metadata.buildTime,
      dirty: metadata.dirty,
      channel: metadata.channel,
    });
    if (metadata.commitSha !== expected.commitSha) throw new Error('commit_mismatch');
  }

  const expectedTime = process.env.LOCALIS_BUILD_TIME?.trim();
  if (expectedTime) {
    const normalized = normalizeBuildTime(expectedTime);
    if (!normalized || metadata.buildTime !== normalized) throw new Error('time_mismatch');
  }

  const expectedChannel = process.env.LOCALIS_BUILD_CHANNEL?.trim().toLowerCase();
  if (expectedChannel && metadata.channel !== expectedChannel) throw new Error('channel_mismatch');
  if (metadata.channel === 'release' && metadata.dirty) throw new Error('dirty_release');

  process.stdout.write('Build metadata verified.\n');
}

main().catch((error: unknown) => {
  const diagnostic = error instanceof Error ? error.message : 'verification_failed';
  process.stderr.write(`Build metadata verification failed: ${diagnostic}.\n`);
  process.exitCode = 1;
});
