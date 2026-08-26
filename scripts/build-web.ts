import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_METADATA_FILE_NAME,
  readBuildMetadata,
  type BuildMetadata,
} from '../server/build-metadata';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const metadataPath = path.join(repositoryRoot, 'desktop', 'build', BUILD_METADATA_FILE_NAME);
const vinextCliPath = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('vinext'))),
  'cli.js',
);

async function loadBuildMetadata(): Promise<BuildMetadata> {
  const result = await readBuildMetadata(metadataPath);
  if (!result.available) throw new Error('build_metadata_unavailable');
  return result.metadata;
}

function runVinextBuild(metadataJson: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vinextCliPath, 'build'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NEXT_PUBLIC_LOCALIS_BUILD_METADATA: metadataJson,
      },
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.once('error', () => {
      process.stderr.write('Unable to start the local web build.\n');
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const metadata = await loadBuildMetadata();
  const exitCode = await runVinextBuild(JSON.stringify(metadata));
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch(() => {
  process.stderr.write('Web build metadata validation failed.\n');
  process.exitCode = 1;
});
