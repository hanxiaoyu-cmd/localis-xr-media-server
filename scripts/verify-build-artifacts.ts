import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_METADATA_FILE_NAME, readBuildMetadata } from '../server/build-metadata';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactRoot = process.argv[2] ? path.resolve(repositoryRoot, process.argv[2]) : repositoryRoot;

async function treeContains(directory: string, value: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(entryPath, value)) return true;
    } else if (/\.(?:js|mjs)$/i.test(entry.name) && (await readFile(entryPath, 'utf8')).includes(value)) {
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const metadataResult = await readBuildMetadata(path.join(
    artifactRoot,
    'desktop',
    'build',
    BUILD_METADATA_FILE_NAME,
  ));
  if (!metadataResult.available) throw new Error('metadata_unavailable');
  const metadata = metadataResult.metadata;

  const serverBundle = await readFile(path.join(artifactRoot, 'desktop', 'build', 'server.mjs'), 'utf8');
  if (!serverBundle.includes(metadata.buildId) || !serverBundle.includes(metadata.commitSha)) {
    throw new Error('server_identity_mismatch');
  }
  if (serverBundle.includes('process.env.LOCALIS_EMBEDDED_BUILD_METADATA')) {
    throw new Error('server_identity_not_compiled');
  }

  const clientDirectory = path.join(artifactRoot, 'dist', 'client');
  if (!await treeContains(clientDirectory, metadata.buildId)) throw new Error('client_identity_mismatch');

  process.stdout.write('Build artifacts verified.\n');
}

main().catch((error: unknown) => {
  const diagnostic = error instanceof Error && /^[a-z_]+$/.test(error.message)
    ? error.message
    : 'verification_failed';
  process.stderr.write(`Build artifact verification failed: ${diagnostic}.\n`);
  process.exitCode = 1;
});
