import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../server/app';
import { PairingAuth } from '../server/auth';
import { unavailableBuildMetadata } from '../server/build-metadata';
import {
  FolderBrowser,
  FolderBrowserError,
  type FolderBrowserFileSystem,
} from '../server/folder-browser';
import type { MediaLibrary } from '../server/media-library';
import type { ProgressStore } from '../server/progress-store';
import type { TranscodeManager } from '../server/transcode-manager';
import type { LocalisConfig } from '../server/types';

const temporaryDirectories: string[] = [];

const directory = { isDirectory: () => true, isSymbolicLink: () => false };
const file = { isDirectory: () => false, isSymbolicLink: () => false };
const link = { isDirectory: () => false, isSymbolicLink: () => true };

function fileSystemError(code: string) {
  return Object.assign(new Error(code), { code });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('folder browser', () => {
  it('returns only real child directories, parent state, configured status and truncation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-folder-browser-'));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(path.join(root, 'Folder 10')),
      mkdir(path.join(root, 'Folder 2')),
      writeFile(path.join(root, 'movie.mp4'), 'not returned'),
    ]);
    await symlink(path.join(root, 'Folder 2'), path.join(root, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');

    const browser = new FolderBrowser({ mediaDirs: [root] }, { maxFolders: 1 });
    const result = await browser.browse(root);

    expect(result).toMatchObject({
      currentPath: path.normalize(root),
      parentPath: path.dirname(root),
      alreadyAdded: true,
      truncated: true,
      folders: [{ name: 'Folder 2', path: path.join(root, 'Folder 2') }],
    });
    expect(result.locations).toContainEqual(expect.objectContaining({ path: path.normalize(root), kind: 'media' }));
    expect(result.folders.map((entry) => entry.name)).not.toContain('movie.mp4');
    expect(result.folders.map((entry) => entry.name)).not.toContain('linked-folder');
  });

  it('rejects relative paths, files, and direct or ancestor symbolic links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localis-folder-browser-invalid-'));
    temporaryDirectories.push(root);
    const regularFile = path.join(root, 'video.mp4');
    const realDirectory = path.join(root, 'real');
    const linkedDirectory = path.join(root, 'linked');
    await writeFile(regularFile, 'video');
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const browser = new FolderBrowser({ mediaDirs: [] });

    await expect(browser.browse('relative/path')).rejects.toMatchObject({ code: 'invalid_folder_path', status: 400 });
    await expect(browser.browse(regularFile)).rejects.toMatchObject({ code: 'not_a_directory', status: 400 });
    await expect(browser.browse(linkedDirectory)).rejects.toMatchObject({ code: 'symbolic_link_not_allowed', status: 400 });
    await expect(browser.browse(path.join(linkedDirectory, 'child'))).rejects.toMatchObject({ code: 'symbolic_link_not_allowed', status: 400 });
  });

  it('maps missing, denied, and unexpected filesystem failures to safe errors', async () => {
    const createBrowser = (code: string) => new FolderBrowser({ mediaDirs: [] }, {
      platform: 'linux',
      homeDirectory: '/home/test',
      fileSystem: {
        lstat: async () => { throw fileSystemError(code); },
        readdir: async () => [],
      },
    });

    await expect(createBrowser('ENOENT').browse('/missing')).rejects.toMatchObject({ code: 'folder_not_found', status: 404 });
    await expect(createBrowser('EACCES').browse('/private')).rejects.toMatchObject({ code: 'folder_access_denied', status: 403 });
    await expect(createBrowser('EIO').browse('/broken')).rejects.toMatchObject({ code: 'folder_unavailable', status: 500 });
  });

  it('bounds slow directory reads and rejects Windows root-relative paths', async () => {
    const slowBrowser = new FolderBrowser({ mediaDirs: [] }, {
      platform: 'linux',
      homeDirectory: '/home/test',
      browseTimeoutMs: 10,
      fileSystem: {
        lstat: () => new Promise(() => undefined),
        readdir: async () => [],
      },
    });
    await expect(slowBrowser.browse('/offline')).rejects.toMatchObject({ code: 'folder_browse_timeout', status: 504 });

    const windowsBrowser = new FolderBrowser({ mediaDirs: [] }, {
      platform: 'win32',
      homeDirectory: 'C:\\Users\\Test',
      fileSystem: { lstat: async () => directory, readdir: async () => [] },
    });
    await expect(windowsBrowser.browse('\\Videos')).rejects.toMatchObject({ code: 'invalid_folder_path', status: 400 });
    await expect(windowsBrowser.browse('/Videos')).rejects.toMatchObject({ code: 'invalid_folder_path', status: 400 });
    await expect(windowsBrowser.browse('\\\\server')).rejects.toMatchObject({ code: 'invalid_folder_path', status: 400 });
  });

  it('builds Windows common, drive, and media locations, starts at home, and caches drive probes', async () => {
    const existing = new Set([
      'C:\\',
      'C:\\Media',
      'C:\\Users',
      'C:\\Users\\Test',
      'C:\\Users\\Test\\Desktop',
      'C:\\Users\\Test\\Documents',
      'C:\\Users\\Test\\Downloads',
      'D:\\',
    ].map((target) => path.win32.normalize(target).toLowerCase()));
    const lstat = vi.fn(async (target: string) => {
        if (existing.has(path.win32.normalize(target).toLowerCase())) return directory;
        throw fileSystemError('ENOENT');
    });
    const fakeFileSystem: FolderBrowserFileSystem = {
      lstat,
      readdir: async () => [
        { name: 'Videos', ...directory },
        { name: 'clip.mp4', ...file },
        { name: 'Shortcut', ...link },
      ],
    };
    const browser = new FolderBrowser({ mediaDirs: ['C:\\Media'] }, {
      fileSystem: fakeFileSystem,
      platform: 'win32',
      homeDirectory: 'C:\\Users\\Test',
      environment: { ...process.env, USERPROFILE: 'C:\\Users\\Test' },
    });

    const result = await browser.browse();
    expect(result).toMatchObject({
      currentPath: 'C:\\Users\\Test',
      parentPath: 'C:\\Users',
      alreadyAdded: false,
      folders: [{ name: 'Videos', path: 'C:\\Users\\Test\\Videos' }],
    });
    expect(result.locations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'C:\\Media', kind: 'media' }),
      expect.objectContaining({ path: 'C:\\Users\\Test', kind: 'home' }),
      expect.objectContaining({ path: 'C:\\Users\\Test\\Desktop', kind: 'desktop' }),
      expect.objectContaining({ path: 'C:\\Users\\Test\\Documents', kind: 'documents' }),
      expect.objectContaining({ path: 'C:\\Users\\Test\\Downloads', kind: 'downloads' }),
      expect.objectContaining({ path: 'C:\\', kind: 'drive' }),
      expect.objectContaining({ path: 'D:\\', kind: 'drive' }),
    ]));
    await browser.browse('C:\\Media');
    expect(lstat.mock.calls.filter(([target]) => path.win32.normalize(target) === 'D:\\')).toHaveLength(1);
  });
});

describe('folder browser API', () => {
  it('runs after pairing auth and returns browser errors as JSON', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localis-folder-browser-api-'));
    temporaryDirectories.push(dataDir);
    const config: LocalisConfig = {
      projectRoot: process.cwd(), dataDir, cacheDir: path.join(dataDir, 'cache'), mediaDirs: [],
      port: 0, host: '127.0.0.1', authDisabled: false, pairingCode: '246810',
      allowedHosts: ['localhost'], ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', maxTranscodes: 1,
    };
    const auth = new PairingAuth(config);
    await auth.initialize();
    const browse = vi.fn(async () => ({ currentPath: 'C:\\', folders: [], locations: [], alreadyAdded: false }));
    const folderBrowser = { browse } as unknown as FolderBrowser;
    const app = createApiApp({
      config,
      auth,
      folderBrowser,
      library: { items: new Map() } as unknown as MediaLibrary,
      progress: {} as ProgressStore,
      transcodes: {} as TranscodeManager,
      buildMetadata: unavailableBuildMetadata('missing'),
    });

    await request(app).get('/api/library/folders/browse').set('Host', 'localhost').expect(401, { error: 'pairing_required' });
    expect(browse).not.toHaveBeenCalled();

    const paired = await request(app).post('/api/pair/verify')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ code: '246810' })
      .expect(200);
    const cookie = paired.headers['set-cookie'][0] as string;
    const response = await request(app).get('/api/library/folders/browse?path=C%3A%5C')
      .set('Host', 'localhost')
      .set('Cookie', cookie)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(response.body).toEqual({ currentPath: 'C:\\', folders: [], locations: [], alreadyAdded: false });
    expect(browse).toHaveBeenCalledWith('C:\\');

    folderBrowser.browse = vi.fn(async () => {
      throw new FolderBrowserError('folder_access_denied', 403, '没有权限读取这个文件夹。');
    });
    const denied = await request(app).get('/api/library/folders/browse?path=C%3A%5Cprivate')
      .set('Host', 'localhost')
      .set('Cookie', cookie)
      .expect(403);
    expect(denied.body).toEqual({ error: 'folder_access_denied', message: '没有权限读取这个文件夹。' });

    const remoteApi = createApiApp({
      config,
      auth,
      folderBrowser,
      isFolderBrowserLoopback: () => false,
      library: { items: new Map() } as unknown as MediaLibrary,
      progress: {} as ProgressStore,
      transcodes: {} as TranscodeManager,
      buildMetadata: unavailableBuildMetadata('missing'),
    });
    const remote = await request(remoteApi).get('/api/library/folders/browse')
      .set('Host', 'localhost')
      .set('Cookie', cookie)
      .expect('Cache-Control', 'no-store')
      .expect(403);
    expect(remote.body).toMatchObject({ error: 'local_management_required' });
  });
});
