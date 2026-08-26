import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FolderBrowserLocation,
  FolderBrowserLocationKind,
  FolderBrowserResult,
  LocalisConfig,
} from './types';

const DEFAULT_MAX_FOLDERS = 1_000;
const LOCATION_PROBE_TIMEOUT_MS = 500;
const BROWSE_TIMEOUT_MS = 5_000;

interface FolderBrowserStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface FolderBrowserDirent extends FolderBrowserStats {
  name: string;
}

export interface FolderBrowserFileSystem {
  lstat(target: string): Promise<FolderBrowserStats>;
  readdir(target: string): Promise<FolderBrowserDirent[]>;
}

export interface FolderBrowserOptions {
  fileSystem?: FolderBrowserFileSystem;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  maxFolders?: number;
  locationProbeTimeoutMs?: number;
  browseTimeoutMs?: number;
}

export type FolderBrowserErrorCode =
  | 'invalid_folder_path'
  | 'folder_not_found'
  | 'folder_access_denied'
  | 'not_a_directory'
  | 'symbolic_link_not_allowed'
  | 'folder_browse_timeout'
  | 'folder_unavailable';

export class FolderBrowserError extends Error {
  constructor(
    readonly code: FolderBrowserErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FolderBrowserError';
  }
}

const nodeFileSystem: FolderBrowserFileSystem = {
  lstat,
  readdir: (target) => readdir(target, { withFileTypes: true }),
};

function fileSystemError(error: unknown): FolderBrowserError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new FolderBrowserError('folder_not_found', 404, '找不到这个文件夹。');
  if (code === 'EACCES' || code === 'EPERM') {
    return new FolderBrowserError('folder_access_denied', 403, '没有权限读取这个文件夹。');
  }
  if (code === 'ENOTDIR') return new FolderBrowserError('not_a_directory', 400, '请选择文件夹，而不是单个文件。');
  if (code === 'ELOOP') return new FolderBrowserError('symbolic_link_not_allowed', 400, '不能浏览符号链接文件夹。');
  return new FolderBrowserError('folder_unavailable', 500, '暂时无法读取这个文件夹。');
}

function normalizedKey(value: string, pathApi: typeof path.win32, platform: NodeJS.Platform) {
  const normalized = pathApi.normalize(value);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function locationName(target: string, pathApi: typeof path.win32) {
  return pathApi.basename(target) || pathApi.parse(target).root.replace(/[\\/]$/, '') || target;
}

export class FolderBrowser {
  private readonly fileSystem: FolderBrowserFileSystem;
  private readonly platform: NodeJS.Platform;
  private readonly pathApi: typeof path.win32;
  private readonly homeDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxFolders: number;
  private readonly locationProbeTimeoutMs: number;
  private readonly browseTimeoutMs: number;
  private driveLocationsPromise?: Promise<FolderBrowserLocation[]>;

  constructor(private readonly config: Pick<LocalisConfig, 'mediaDirs'>, options: FolderBrowserOptions = {}) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.platform = options.platform ?? process.platform;
    this.pathApi = this.platform === 'win32' ? path.win32 : path.posix;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.environment = options.environment ?? process.env;
    this.maxFolders = Math.max(1, Math.trunc(options.maxFolders ?? DEFAULT_MAX_FOLDERS));
    this.locationProbeTimeoutMs = Math.max(1, Math.trunc(options.locationProbeTimeoutMs ?? LOCATION_PROBE_TIMEOUT_MS));
    this.browseTimeoutMs = Math.max(1, Math.trunc(options.browseTimeoutMs ?? BROWSE_TIMEOUT_MS));
  }

  async browse(requestedPath?: unknown): Promise<FolderBrowserResult> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.performBrowse(requestedPath),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new FolderBrowserError(
            'folder_browse_timeout',
            504,
            '读取这个位置超时，请检查磁盘或网络连接。',
          )), this.browseTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async performBrowse(requestedPath?: unknown): Promise<FolderBrowserResult> {
    let currentPath: string;
    if (requestedPath === undefined || requestedPath === '') currentPath = await this.defaultPath();
    else currentPath = this.parseAbsolutePath(requestedPath);

    await this.assertRealDirectory(currentPath);

    let entries: FolderBrowserDirent[];
    try {
      entries = await this.fileSystem.readdir(currentPath);
    } catch (error) {
      throw fileSystemError(error);
    }

    const allFolders = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, path: this.pathApi.join(currentPath, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    const root = this.pathApi.parse(currentPath).root;
    const configuredKeys = new Set(this.config.mediaDirs.map((entry) => normalizedKey(entry, this.pathApi, this.platform)));

    return {
      currentPath,
      parentPath: normalizedKey(currentPath, this.pathApi, this.platform) === normalizedKey(root, this.pathApi, this.platform)
        ? undefined
        : this.pathApi.dirname(currentPath),
      folders: allFolders.slice(0, this.maxFolders),
      locations: await this.locations(),
      alreadyAdded: configuredKeys.has(normalizedKey(currentPath, this.pathApi, this.platform)),
      ...(allFolders.length > this.maxFolders ? { truncated: true } : {}),
    };
  }

  private parseAbsolutePath(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new FolderBrowserError('invalid_folder_path', 400, '请提供有效的绝对文件夹路径。');
    }
    const candidate = value.trim();
    const validWindowsPath = this.platform !== 'win32'
      || /^[a-z]:[\\/]/i.test(candidate)
      || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(candidate);
    if (!this.pathApi.isAbsolute(candidate) || !validWindowsPath || (this.platform === 'win32' && /^\\\\[?.]\\/.test(candidate))) {
      throw new FolderBrowserError('invalid_folder_path', 400, '请提供有效的绝对文件夹路径。');
    }
    return this.pathApi.normalize(candidate);
  }

  private async defaultPath() {
    const candidates = [this.homeDirectory, ...this.config.mediaDirs];
    for (const candidate of candidates) {
      try {
        const resolved = this.parseAbsolutePath(candidate);
        await this.assertRealDirectory(resolved);
        return resolved;
      } catch {
        // Stale configured folders should not prevent opening the browser.
      }
    }
    throw new FolderBrowserError('folder_unavailable', 500, '找不到可用的起始文件夹。');
  }

  private async assertRealDirectory(target: string) {
    const root = this.pathApi.parse(target).root;
    const relative = target.slice(root.length);
    const components = relative.split(/[\\/]+/).filter(Boolean);
    let current = root;
    const paths = [root, ...components.map((component) => (current = this.pathApi.join(current, component)))];

    for (const componentPath of paths) {
      let info: FolderBrowserStats;
      try {
        info = await this.fileSystem.lstat(componentPath);
      } catch (error) {
        throw fileSystemError(error);
      }
      if (info.isSymbolicLink()) {
        throw new FolderBrowserError('symbolic_link_not_allowed', 400, '不能浏览符号链接文件夹。');
      }
      if (!info.isDirectory()) {
        throw new FolderBrowserError('not_a_directory', 400, '请选择文件夹，而不是单个文件。');
      }
    }
  }

  private async isLocationAvailable(target: string) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.assertRealDirectory(target),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('location_probe_timeout')), this.locationProbeTimeoutMs);
          timeout.unref();
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async locations() {
    const candidates: FolderBrowserLocation[] = [];
    const add = (target: string | undefined, name: string, kind: FolderBrowserLocationKind) => {
      if (!target) return;
      try {
        candidates.push({ name, path: this.parseAbsolutePath(target), kind });
      } catch {
        // Environment/config entries are untrusted persisted input. Ignore invalid shortcuts.
      }
    };

    for (const mediaDir of this.config.mediaDirs) {
      add(mediaDir, `媒体库 · ${locationName(mediaDir, this.pathApi)}`, 'media');
    }

    const home = this.platform === 'win32' ? this.environment.USERPROFILE || this.homeDirectory : this.homeDirectory;
    add(home, '主目录', 'home');
    add(home && this.pathApi.join(home, 'Desktop'), '桌面', 'desktop');
    add(home && this.pathApi.join(home, 'Documents'), '文档', 'documents');
    add(home && this.pathApi.join(home, 'Downloads'), '下载', 'downloads');

    const unique = new Map<string, FolderBrowserLocation>();
    for (const candidate of candidates) {
      const key = normalizedKey(candidate.path, this.pathApi, this.platform);
      if (!unique.has(key)) unique.set(key, candidate);
    }
    const checked = await Promise.all([...unique.values()].map(async (candidate) => (
      await this.isLocationAvailable(candidate.path) ? candidate : undefined
    )));
    return [
      ...checked.filter((candidate): candidate is FolderBrowserLocation => Boolean(candidate)),
      ...await this.windowsDriveLocations(),
    ];
  }

  private windowsDriveLocations(): Promise<FolderBrowserLocation[]> {
    if (this.platform !== 'win32') return Promise.resolve([]);
    if (!this.driveLocationsPromise) {
      this.driveLocationsPromise = Promise.all(Array.from({ length: 26 }, async (_, index) => {
        const letter = String.fromCharCode('A'.charCodeAt(0) + index);
        const drive = `${letter}:\\`;
        return await this.isLocationAvailable(drive) ? { name: `${letter}:`, path: drive, kind: 'drive' as const } : undefined;
      })).then((locations): FolderBrowserLocation[] => locations.filter(
        (candidate): candidate is Exclude<typeof candidate, undefined> => candidate !== undefined,
      ));
    }
    return this.driveLocationsPromise;
  }
}
