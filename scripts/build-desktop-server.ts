import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  BUILD_METADATA_FILE_NAME,
  readBuildMetadata,
  type BuildMetadata,
} from '../server/build-metadata';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const metadataPath = path.join(repositoryRoot, 'desktop', 'build', BUILD_METADATA_FILE_NAME);

async function loadBuildMetadata(): Promise<BuildMetadata> {
  const result = await readBuildMetadata(metadataPath);
  if (!result.available) throw new Error('build_metadata_unavailable');
  return result.metadata;
}

async function main(): Promise<void> {
  const metadata = await loadBuildMetadata();
  const metadataJson = JSON.stringify(metadata);

  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ['server/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'desktop/build/server.mjs',
    packages: 'external',
    define: {
      'process.env.LOCALIS_EMBEDDED_BUILD_METADATA': JSON.stringify(metadataJson),
    },
  });
}

main().catch(() => {
  process.stderr.write('Desktop server build failed.\n');
  process.exitCode = 1;
});
