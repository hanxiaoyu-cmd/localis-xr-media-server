import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSubtitleVtt, srtToVtt } from '../server/subtitles';
import type { LocalisConfig, MediaItem, SubtitleTrack } from '../server/types';

describe('subtitle conversion', () => {
  it('normalizes BOM, line endings and SRT timestamps', () => {
    const input = '\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n测试字幕\r\n';
    expect(srtToVtt(input)).toBe('WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.500\n测试字幕\n');
  });

  it('versions converted subtitle cache entries when an external ASS file changes', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localis-subtitle-version-'));
    try {
      const subtitlePath = path.join(dataDir, 'movie.ass');
      const ass = (caption: string) => `[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,${caption}\n`;
      await writeFile(subtitlePath, ass('OLD-CAPTION'));
      const config = {
        projectRoot: process.cwd(), dataDir, cacheDir: path.join(dataDir, 'cache'), mediaDirs: [],
        port: 0, host: '127.0.0.1', authDisabled: true, pairingCode: '123456', allowedHosts: ['localhost'],
        ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', maxTranscodes: 1,
      } satisfies LocalisConfig;
      const item = {
        id: 'subtitle-version-item', kind: 'video', title: 'movie', fileName: 'movie.mkv', relativePath: 'movie.mkv',
        extension: '.mkv', size: 1, modifiedAt: new Date().toISOString(), duration: 2,
        projection: 'flat', stereo: 'mono', eyeOrder: 'lr', yawOffset: 0,
        audioTracks: [], subtitleTracks: [], directPlay: false, path: subtitlePath, libraryRoot: dataDir,
      } satisfies MediaItem;
      const track = { index: 1000, codec: 'ass', source: 'external', externalPath: subtitlePath } satisfies SubtitleTrack;
      expect(await getSubtitleVtt(config, item, track)).toContain('OLD-CAPTION');
      await writeFile(subtitlePath, ass('NEW-CAPTION-LONGER'));
      const refreshed = await getSubtitleVtt(config, item, track);
      expect(refreshed).toContain('NEW-CAPTION-LONGER');
      expect(refreshed).not.toContain('OLD-CAPTION');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
