import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BuildMetadataValidationError,
  createBuildMetadata,
  serializeBuildMetadata,
} from '../server/build-metadata';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const outputPath = path.join(repositoryRoot, 'desktop', 'build', 'build-metadata.json');

async function runGit(arguments_: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', arguments_, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    throw new Error('Git build identity is unavailable');
  }
}

async function packageVersion(): Promise<string> {
  try {
    const contents = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(contents) as { version?: unknown };
    if (typeof parsed.version !== 'string') throw new Error('missing version');
    return parsed.version;
  } catch {
    throw new Error('Package version is unavailable');
  }
}

async function deriveDirty(commitWasProvided: boolean): Promise<boolean> {
  try {
    return (await runGit(['status', '--porcelain=v1', '--untracked-files=normal'])).length > 0;
  } catch {
    if (commitWasProvided) return false;
    throw new Error('Git working-tree state is unavailable');
  }
}

async function deriveBuildTime(commit: string): Promise<string> {
  const seconds = Number(await runGit(['show', '-s', '--format=%ct', commit]));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Git commit time is unavailable');
  return new Date(seconds * 1_000).toISOString();
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const providedCommit = process.env.LOCALIS_COMMIT_SHA?.trim();
  if (providedCommit) {
    const checkedOutCommit = await runGit(['rev-parse', 'HEAD']);
    if (checkedOutCommit.toLowerCase() !== providedCommit.toLowerCase()) {
      throw new Error('Git checkout does not match the requested build identity');
    }
  }
  const commitSha = providedCommit || await runGit(['rev-parse', 'HEAD']);
  const metadata = createBuildMetadata({
    version: await packageVersion(),
    commitSha,
    buildTime: process.env.LOCALIS_BUILD_TIME?.trim() || await deriveBuildTime(commitSha),
    dirty: await deriveDirty(Boolean(providedCommit)),
    channel: process.env.LOCALIS_BUILD_CHANNEL?.trim() || 'local',
  });

  await writeAtomic(outputPath, serializeBuildMetadata(metadata));
  process.stdout.write('Build metadata generated.\n');
}

main().catch((error: unknown) => {
  if (error instanceof BuildMetadataValidationError) {
    process.stderr.write(`Build metadata generation failed: ${error.issues.join(', ')}.\n`);
  } else if (error instanceof Error && /^(?:Git|Package)/.test(error.message)) {
    process.stderr.write(`Build metadata generation failed: ${error.message}.\n`);
  } else {
    process.stderr.write('Build metadata generation failed.\n');
  }
  process.exitCode = 1;
});
