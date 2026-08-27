import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceDirectory, '..', '..');
const outputDirectory = path.join(repositoryRoot, 'android', 'app', 'src', 'main', 'assets', 'web');
const applicationOutput = path.join(outputDirectory, 'app.js');

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  copyFile(path.join(sourceDirectory, 'index.html'), path.join(outputDirectory, 'index.html')),
  copyFile(path.join(sourceDirectory, 'styles.css'), path.join(outputDirectory, 'styles.css')),
  build({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(sourceDirectory, 'app.ts')],
    outfile: applicationOutput,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome109', 'safari16'],
    minify: true,
    sourcemap: false,
    legalComments: 'eof',
    charset: 'utf8',
    tsconfig: path.join(sourceDirectory, 'tsconfig.json'),
  }),
]);

// Three.js embeds GLSL as template literals whose source contains harmless
// line-end padding. Strip it deterministically so the committed generated
// asset passes repository whitespace checks on every platform.
const bundledApplication = await readFile(applicationOutput, 'utf8');
await writeFile(
  applicationOutput,
  bundledApplication.replace(/[ \t]+$/gm, '').replace(/^ +(?=\t)/gm, ''),
  'utf8',
);
