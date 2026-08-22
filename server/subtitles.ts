import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LocalisConfig, MediaItem, SubtitleTrack } from './types';

const execFileAsync = promisify(execFile);
const conversions = new Map<string, Promise<string>>();

export function srtToVtt(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

export async function getSubtitleVtt(config: LocalisConfig, item: MediaItem, track: SubtitleTrack): Promise<string> {
  if (track.source === 'external' && track.externalPath) {
    const extension = path.extname(track.externalPath).toLowerCase();
    if (extension === '.vtt') return readFile(track.externalPath, 'utf8');
    if (extension === '.srt') return srtToVtt(await readFile(track.externalPath, 'utf8'));
  }

  const input = track.externalPath || item.path;
  const inputStat = await stat(input);
  const version = createHash('sha256')
    .update(['v2', item.id, track.index, inputStat.size, Math.trunc(inputStat.mtimeMs)].join('|'))
    .digest('hex')
    .slice(0, 20);
  const subtitleDir = path.join(config.cacheDir, 'subtitles');
  const output = path.join(subtitleDir, `${item.id}-${track.index}-${version}.vtt`);
  await mkdir(subtitleDir, { recursive: true });
  try {
    return await readFile(output, 'utf8');
  } catch {
    // The conversion below is single-flight and atomically published.
  }

  const known = conversions.get(output);
  if (known) return known;
  const operation = (async () => {
    const temporary = `${output}.${process.pid}.${randomBytes(6).toString('hex')}.part`;
    try {
      const map = track.source === 'embedded' ? `0:${track.index}` : '0:0';
      await execFileAsync(config.ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', input, '-map', map, '-f', 'webvtt', temporary,
      ], {
        windowsHide: true,
        timeout: 60_000,
      });
      const converted = (await readFile(temporary, 'utf8')).replace(/^\uFEFF/, '');
      await writeFile(temporary, converted);
      await rename(temporary, output);
      return converted;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  })();
  conversions.set(output, operation);
  try {
    return await operation;
  } finally {
    if (conversions.get(output) === operation) conversions.delete(output);
  }
}
