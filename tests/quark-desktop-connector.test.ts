import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaLibrary } from '../server/media-library';
import {
  QuarkConnectorError,
  QuarkDesktopConnector,
  type QuarkCommandExecutor,
} from '../server/quark-desktop-connector';
import type { LocalisConfig } from '../server/types';

const temporaryDirectories: string[] = [];

function configFor(root: string): LocalisConfig {
  return {
    projectRoot: process.cwd(),
    dataDir: root,
    cacheDir: path.join(root, 'cache'),
    mediaDirs: [],
    port: 0,
    host: '127.0.0.1',
    authDisabled: true,
    pairingCode: '123456',
    allowedHosts: ['localhost', '127.0.0.1'],
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxTranscodes: 1,
    cloudCacheBytes: 64 * 1024 * 1024,
  };
}

afterEach(async () => {
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('QuarkDesktopConnector', () => {
  it('installs only after a computer action and uses the official repository without returning credentials', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-quark-install-'));
    temporaryDirectories.push(root);
    const companion = path.join(root, 'companion');
    const calls: Array<{ file: string; args: string[] }> = [];
    const execute: QuarkCommandExecutor = async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === 'git' && args[0] === 'clone') {
        const repository = args.at(-1)!;
        await mkdir(path.join(repository, '.git'), { recursive: true });
        await mkdir(path.join(repository, 'skills', 'quarkclouddrive'), { recursive: true });
        await writeFile(path.join(repository, 'skills', 'quarkclouddrive', 'install.sh'), '#!/bin/sh\n');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'fake-bash') {
        const cli = path.join(companion, 'repository', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs');
        await mkdir(path.dirname(cli), { recursive: true });
        await writeFile(cli, '// official test stub');
        return { stdout: 'installed', stderr: '', exitCode: 0 };
      }
      if (file === process.execPath && args[1] === '--version') {
        return { stdout: '1.0.14-ee6c8bc\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
    };
    const connector = new QuarkDesktopConnector(configFor(root), { execute, companionRoot: companion, bashPath: 'fake-bash' });
    await connector.initialize();
    expect(connector.status()).toMatchObject({ installed: false, official: true, accountState: 'unauthenticated' });

    connector.startInstall();
    await connector.waitForIdle();
    expect(connector.status()).toMatchObject({ installed: true, version: '1.0.14-ee6c8bc', operation: { kind: 'install', state: 'succeeded' } });
    expect(calls[0]).toMatchObject({ file: 'git', args: expect.arrayContaining(['clone', 'https://github.com/quark-clouddrive/quarkclouddrive_offical.git']) });
    expect(calls.some((entry) => entry.file === 'fake-bash')).toBe(true);
    expect(JSON.stringify(connector.status())).not.toMatch(/cookie|fid|secret|accessToken|refreshToken/i);
    connector.shutdown();
  });

  it('logs in, returns opaque search choices and imports a complete verified file before it enters the library', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-quark-flow-'));
    temporaryDirectories.push(root);
    const companion = path.join(root, 'companion');
    const cli = path.join(companion, 'repository', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, '// official test stub');
    const samplePath = path.join(process.cwd(), 'sample-media', 'flat-demo.mp4');
    const sampleSize = (await stat(samplePath)).size;
    const commands: string[][] = [];
    const execute: QuarkCommandExecutor = async (file, args, options) => {
      if (file === 'ffprobe') return { stdout: '{"format":{"duration":"1"},"streams":[{"codec_type":"video"}]}', stderr: '', exitCode: 0 };
      expect(file).toBe(process.execPath);
      if (args[1] === '--version') return { stdout: '1.0.14-ee6c8bc\n', stderr: '', exitCode: 0 };
      commands.push([...args]);
      const command = args[1];
      if (command === 'login') {
        options.onStdoutLine?.('{"code":0,"msg":"授权成功","action":"login","type":"result","data":{}}');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command === 'search') {
        const artifactDirectory = path.join(path.dirname(path.dirname(cli)), 'localis', 'search', 'test-user');
        const artifactPath = path.join(artifactDirectory, 'search-20260823-220000-a7b3c9.jsonl');
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(artifactPath, [
          JSON.stringify({ fid: 'private-fid-video', filename: 'Localis VR180 SBS.mp4', size: sampleSize, updated_at: 1_787_472_000 }),
          JSON.stringify({ fid: 'private-fid-audio', filename: 'concert.flac', size: 456, updated_at: 1_787_472_000 }),
          JSON.stringify({ fid: 'private-fid-document', filename: 'ignore.pdf', size: 42, updated_at: 1_787_472_000 }),
        ].join('\n'));
        const resultLine = JSON.stringify({
          code: 0,
          msg: '成功',
          action: 'search',
          type: 'result',
          data: {
            total: 3,
            check_all_link: 'https://pan.quark.cn/skill#/search-result',
            file_list: [{ fid: 'private-fid-document', filename: 'ignore.pdf', size: 42, updated_at: 1_787_472_000 }],
          },
        });
        const artifactLine = JSON.stringify({
          code: 0,
          msg: '成功',
          action: 'search',
          type: 'artifact',
          data: { file_path: artifactPath, count: 3, format: 'jsonl' },
        });
        options.onStdoutLine?.(resultLine);
        options.onStdoutLine?.(artifactLine);
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command === 'download') {
        const output = args[args.indexOf('--output-dir') + 1];
        await mkdir(output, { recursive: true });
        await copyFile(samplePath, path.join(output, 'Localis VR180 SBS.mp4'));
        options.onStdoutLine?.(JSON.stringify({ action: 'download', type: 'progress', data: { current: sampleSize, total: sampleSize, percent: 100 } }));
        options.onStdoutLine?.(JSON.stringify({ code: 0, msg: '成功', action: 'download', type: 'result', data: { successCount: 1 } }));
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
    };

    const config = configFor(root);
    const connector = new QuarkDesktopConnector(config, { execute, companionRoot: companion, bashPath: 'fake-bash' });
    await connector.initialize();
    const library = new MediaLibrary(config);
    await library.initialize();
    const scan = vi.spyOn(library, 'scan');
    connector.setOnImported(() => library.scan());

    connector.startLogin();
    await connector.waitForIdle();
    expect(connector.status()).toMatchObject({ installed: true, accountState: 'authenticated' });

    const keyword = 'VR180 视频;$(not-a-command)';
    const search = await connector.search(keyword);
    expect(search).toMatchObject({ total: 3, checkAllUrl: expect.stringMatching(/^https:\/\/pan\.quark\.cn/) });
    expect(search.results.map((entry) => entry.fileName)).toEqual(['Localis VR180 SBS.mp4', 'concert.flac']);
    expect(JSON.stringify(search)).not.toContain('private-fid');
    expect(search.results[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    const searchCommand = commands.find((args) => args[1] === 'search')!;
    expect(searchCommand[searchCommand.indexOf('--keyword') + 1]).toBe(keyword);

    const queued = connector.startDownload(search.results[0].id);
    expect(library.list()).toHaveLength(0);
    await connector.waitForIdle(20_000);
    const completed = connector.download(queued.id);
    expect(completed).toMatchObject({ state: 'ready', message: '已下载到电脑并加入资料库。' });
    expect(scan).toHaveBeenCalled();
    const imported = library.list().find((entry) => entry.fileName === 'Localis VR180 SBS.mp4');
    expect(imported).toMatchObject({ sourceType: 'local', projection: 'equirect180', stereo: 'sbs' });
    const importedBytes = await readFile(path.join(connector.importsRoot, 'Localis VR180 SBS.mp4'));
    expect(importedBytes).toEqual(await readFile(path.join(process.cwd(), 'sample-media', 'flat-demo.mp4')));
    expect(commands.find((args) => args[1] === 'download')).toEqual(expect.arrayContaining([
      '--fid', 'private-fid-video', '--output-dir', expect.any(String), '--overwrite', '--session-input', expect.any(String), '--session-id', expect.any(String),
    ]));

    config.cloudCacheBytes = importedBytes.byteLength;
    const quotaBlocked = connector.startDownload(search.results[1].id);
    await connector.waitForIdle();
    expect(connector.download(quotaBlocked.id)).toMatchObject({
      state: 'failed',
      error: '电脑端夸克资料库已达到云盘容量上限，请先移走不再需要的文件。',
    });
    expect(commands.filter((args) => args[1] === 'download')).toHaveLength(1);
    connector.shutdown();
  });

  it('surfaces the official unauthenticated result and never exposes an arbitrary FID endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-quark-auth-'));
    temporaryDirectories.push(root);
    const companion = path.join(root, 'companion');
    const cli = path.join(companion, 'repository', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, '// official test stub');
    const execute: QuarkCommandExecutor = async (_file, args) => args[1] === '--version'
      ? { stdout: '1.0.14-ee6c8bc\n', stderr: '', exitCode: 0 }
      : {
        stdout: '{"code":-103,"msg":"未登录，请先执行 login 命令完成登录授权","action":"login","type":"result","data":{}}\n',
        stderr: '',
        exitCode: 1,
      };
    const connector = new QuarkDesktopConnector(configFor(root), { execute, companionRoot: companion });
    await connector.initialize();
    expect(() => connector.startLogin('  ')).toThrow(expect.objectContaining({
      code: 'invalid_quark_authorization_code',
    }));
    await expect(connector.search('测试视频')).rejects.toMatchObject({
      code: 'quark_official_error', status: 401,
    } satisfies Partial<QuarkConnectorError>);
    expect(connector.status()).toMatchObject({ accountState: 'unauthenticated' });
    expect(() => connector.startDownload('private-fid-supplied-by-browser')).toThrow(expect.objectContaining({
      code: 'quark_search_result_expired', status: 404,
    }));
    connector.shutdown();
  });

  it('streams official NDJSON progress from a real child process instead of buffering the download', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-quark-stream-'));
    temporaryDirectories.push(root);
    const companion = path.join(root, 'companion');
    const cli = path.join(companion, 'repository', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs');
    const samplePath = path.join(process.cwd(), 'sample-media', 'flat-demo.mp4');
    const sampleSize = (await stat(samplePath)).size;
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = args[0];
const finish = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  if (process.env.OPENCLAW_CLI !== '1') {
    finish({ code: -104, msg: '无法识别当前 Agent 环境，禁止继续使用', action: 'runtime', type: 'result', data: {} });
    process.exitCode = 1;
    return;
  }
  if (command === '--version') { process.stdout.write('1.0.14-test\\n'); return; }
  if (command === 'search') {
    const artifactDir = path.join(__dirname, '..', 'localis', 'search', 'test-user');
    const artifactPath = path.join(artifactDir, 'search-20260823-220000-a7b3c9.jsonl');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ fid: 'stream-fid', filename: 'stream.mp4', size: ${sampleSize}, updated_at: 1787472000 }));
    finish({ code: 0, msg: '成功', action: 'search', type: 'result', data: { total: 1, file_list: [] } });
    finish({ code: 0, msg: '成功', action: 'search', type: 'artifact', data: { file_path: artifactPath, count: 1, format: 'jsonl' } });
    return;
  }
  if (command === 'download') {
    const output = args[args.indexOf('--output-dir') + 1];
    finish({ action: 'download', type: 'progress', data: { current: Math.floor(${sampleSize} / 4), total: ${sampleSize}, percent: 25 } });
    await sleep(350);
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(${JSON.stringify(samplePath)}, path.join(output, 'stream.mp4'));
    finish({ action: 'download', type: 'progress', data: { current: ${sampleSize}, total: ${sampleSize}, percent: 100 } });
    finish({ code: 0, msg: '成功', action: 'download', type: 'result', data: { successCount: 1 } });
    return;
  }
  process.exitCode = 1;
})();
`);

    const connector = new QuarkDesktopConnector(configFor(root), { companionRoot: companion });
    await connector.initialize();
    const search = await connector.search('stream video');
    const queued = connector.startDownload(search.results[0].id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connector.download(queued.id)).toMatchObject({
      state: 'downloading',
      progressBytes: Math.floor(sampleSize / 4),
      totalBytes: sampleSize,
    });
    await connector.waitForIdle(20_000);
    expect(connector.download(queued.id)).toMatchObject({ state: 'ready', progressBytes: sampleSize, totalBytes: sampleSize });
    connector.shutdown();
  });
});
