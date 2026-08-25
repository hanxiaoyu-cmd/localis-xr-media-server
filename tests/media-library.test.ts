import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inferProjection, MediaDirectoryValidationError, MediaLibrary } from '../server/media-library';
import type { LocalisConfig } from '../server/types';

const temporaryDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function config(mediaDirs = [path.join(process.cwd(), 'sample-media')]): Promise<LocalisConfig> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localis-library-'));
  temporaryDirs.push(dataDir);
  return {
    projectRoot: process.cwd(), dataDir, cacheDir: path.join(dataDir, 'cache'),
    mediaDirs, port: 0, host: '127.0.0.1',
    authDisabled: true, pairingCode: '123456', allowedHosts: ['localhost', '127.0.0.1'],
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', maxTranscodes: 1,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('media metadata', () => {
  it('infers common VR naming conventions', () => {
    expect(inferProjection('holiday-vr180-sbs-lr')).toMatchObject({ projection: 'equirect180', stereo: 'sbs', eyeOrder: 'lr' });
    expect(inferProjection('concert_360_tb_rl')).toMatchObject({ projection: 'equirect360', stereo: 'tb', eyeOrder: 'rl' });
    expect(inferProjection('ordinary-film')).toMatchObject({ projection: 'flat', stereo: 'mono' });
  });

  it('scans real fixtures without exposing filesystem paths', async () => {
    const library = new MediaLibrary(await config());
    await library.initialize();
    const items = library.list();
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.find((item) => item.title === 'demo-vr180-sbs-lr')).toMatchObject({ projection: 'equirect180', stereo: 'sbs', videoCodec: 'h264' });
    expect(items.find((item) => item.title === 'legacy-transcode')).toMatchObject({ directPlay: false, videoCodec: 'mpeg4' });
    expect(items.find((item) => item.title === 'high10-incompatible')).toMatchObject({
      directPlay: false,
      videoCodec: 'h264',
      videoProfile: 'High 10',
      pixelFormat: 'yuv420p10le',
      bitDepth: 10,
      dynamicRange: 'unknown',
      compatibilityMode: 'video-transcode',
    });
    expect(items.find((item) => item.title === 'common-format')).toMatchObject({ kind: 'video', directPlay: false });
    expect(items.find((item) => item.title === 'common-audio')).toMatchObject({ kind: 'audio', audioCodec: 'ac3', directPlay: false });
    expect(items.find((item) => item.title === 'hdr10-source')).toMatchObject({
      directPlay: false,
      dynamicRange: 'hdr10',
      bitDepth: 10,
      colorPrimaries: 'bt2020',
      colorTransfer: 'smpte2084',
      compatibilityMode: 'tone-map',
    });
    expect(JSON.stringify(items)).not.toContain(process.cwd());
    expect(JSON.stringify(items)).not.toContain('externalPath');
  });

  it('rejects empty paths and media files instead of resolving them as the project root', async () => {
    const library = new MediaLibrary(await config());
    await expect(library.validateDirectory('   ')).rejects.toBeInstanceOf(MediaDirectoryValidationError);
    await expect(library.validateDirectory(`"${path.join(process.cwd(), 'sample-media', 'flat-demo.mp4')}"`))
      .rejects.toThrow(/文件夹/);
    await expect(library.validateDirectory(`"${path.join(process.cwd(), 'sample-media')}"`))
      .resolves.toBe(path.join(process.cwd(), 'sample-media'));
  });

  it('treats an audio cover image as attached artwork rather than a playable video stream', async () => {
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'localis-attached-cover-'));
    temporaryDirs.push(mediaDir);
    const cover = path.join(mediaDir, 'cover.jpg');
    const output = path.join(mediaDir, 'covered-audio.flac');
    await mkdir(mediaDir, { recursive: true });
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x8844ff:s=64x64',
      '-frames:v', '1', cover,
    ], { windowsHide: true });
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', path.join(process.cwd(), 'sample-media', 'localis-tone.flac'), '-i', cover,
      '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'copy', '-c:v', 'copy',
      '-disposition:v:0', 'attached_pic', output,
    ], { windowsHide: true });
    const library = new MediaLibrary(await config([mediaDir]));
    await library.initialize();
    expect(library.list().find((item) => item.title === 'covered-audio')).toMatchObject({
      kind: 'audio',
      audioCodec: 'flac',
      videoCodec: undefined,
      posterUrl: undefined,
    });
  });
});
