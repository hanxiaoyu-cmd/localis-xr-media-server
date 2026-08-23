import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import type { LocalisConfig, MediaItem } from './types';

const execFileAsync = promisify(execFile);

export type CloudProvider = 'quark' | 'baidu';
type StoredCloudSource = StoredWebDavSource | StoredBaiduSource;

interface EncryptedSecret {
  iv: string;
  tag: string;
  data: string;
}

interface StoredBaiduConnector {
  appKey: EncryptedSecret;
  secretKey: EncryptedSecret;
  appFolder: string;
  configuredAt: string;
}

interface StoredCloudState {
  version?: number;
  connectors?: {
    baidu?: StoredBaiduConnector;
  };
  sources?: StoredCloudSource[];
}

interface EffectiveBaiduConnector {
  appKey: string;
  secretKey: string;
  appFolder: string;
  managedBy: 'environment' | 'computer';
}

interface StoredSourceBase {
  id: string;
  provider: CloudProvider;
  name: string;
  rootPath: string;
  createdAt: string;
}

interface StoredWebDavSource extends StoredSourceBase {
  kind: 'webdav';
  baseUrl: string;
  username: string;
  password: EncryptedSecret;
}

interface StoredBaiduSource extends StoredSourceBase {
  kind: 'baidu-official';
  appKey: EncryptedSecret | string;
  secretKey: EncryptedSecret;
  accessToken: EncryptedSecret;
  refreshToken: EncryptedSecret;
  expiresAt: number;
}

export interface CloudSourceSummary {
  id: string;
  provider: CloudProvider;
  name: string;
  connection: 'OpenList WebDAV' | '百度官方 API';
  rootPath: string;
  endpoint?: string;
  fileCount: number;
  lastScanAt?: string;
  error?: string;
}

export interface BaiduAuthorizationView {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  qrCodeDataUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CloudConnectorCapabilities {
  baidu: {
    available: boolean;
    configuration: 'ready' | 'missing' | 'invalid';
    setupRequired: boolean;
    managedBy?: 'environment' | 'computer';
    canConfigure: boolean;
    login: 'qr';
    appFolder: string;
    activeAuthorization?: BaiduAuthorizationView;
    unavailableReason?: string;
  };
  quark: {
    available: false;
    login: 'official-api-required';
    advancedWebDavAvailable: true;
    unavailableReason: string;
  };
}

export interface CloudRemoteFile {
  id: string;
  sourceId: string;
  provider: CloudProvider;
  sourceName: string;
  providerFileId?: string;
  fileName: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  contentType?: string;
  etag?: string;
}

export interface CloudCacheJob {
  remoteFileId: string;
  state: 'queued' | 'downloading' | 'ready' | 'failed';
  path: string;
  progressBytes: number;
  totalBytes: number;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  failedAt?: number;
  startedAt: string;
  lastAccessAt: number;
}

interface PendingBaiduAuthorization {
  id: string;
  name: string;
  appFolder: string;
  appKey: string;
  secretKey: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  qrCodeDataUrl: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
}

interface BaiduTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface BaiduListEntry {
  fs_id: string | number;
  path: string;
  server_filename: string;
  size: number;
  server_mtime?: number;
  local_mtime?: number;
  isdir: number;
  category?: number;
}

interface CloudCacheRecord {
  sourceId: string;
  remoteFileId: string;
  fileName: string;
  size: number;
  lastAccessAt: number;
}

interface DownloadRequest {
  file: CloudRemoteFile;
  job: CloudCacheJob;
  controller: AbortController;
}

interface CloudManagerRuntimeOptions {
  streamHeaderTimeoutMs: number;
  streamIdleTimeoutMs: number;
  baiduPageDelayMs: number;
  maxWebDavXmlBytes: number;
}

export class CloudSourceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

const mediaExtensions = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.vob', '.3gp', '.3g2', '.mxf', '.ogv', '.divx', '.f4v', '.asf', '.rm', '.rmvb',
  '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.alac', '.wav', '.ogg', '.opus', '.ape', '.wma',
  '.mka', '.aiff', '.aif', '.ac3', '.eac3', '.dts', '.mp2', '.amr',
]);

function isLoopbackHost(hostname: string) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());
}

function normalizeRootPath(value: string) {
  const cleaned = `/${value || ''}`.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return cleaned === '' ? '/' : cleaned;
}

function encodePath(value: string) {
  return value.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&amp;/g, '&');
}

function xmlTag(block: string, name: string) {
  const match = block.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '').trim()) : undefined;
}

function safeIso(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString();
}

function stableRemoteId(sourceId: string, providerFileId: string) {
  return createHash('sha256').update(`${sourceId}\0${providerFileId}`).digest('hex').slice(0, 32);
}

async function fetchWithHeaderTimeout(input: URL | string, init: RequestInit, timeoutMs: number) {
  const headerController = new AbortController();
  const timer = setTimeout(() => headerController.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, headerController.signal])
    : headerController.signal;
  try {
    // The timeout protects connection establishment and response headers only.
    // Once headers arrive, a multi-gigabyte media body may stream for hours and
    // remains cancellable through the caller-provided signal.
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readTextLimited(response: Response, limit: number) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new CloudSourceError('webdav_response_too_large', 'OpenList WebDAV 目录响应过大，请缩小挂载目录范围。', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function baiduJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  // Baidu fs_id is an unsigned 64-bit integer. Quote it before JSON.parse so it
  // never passes through JavaScript's lossy IEEE-754 number representation.
  const lossless = text.replace(/("fs_id"\s*:\s*)(-?\d+)/g, '$1"$2"');
  try { return JSON.parse(lossless) as T; } catch { return {} as T; }
}

export class CloudSourceManager {
  private readonly sources = new Map<string, StoredCloudSource>();
  private readonly remoteFiles = new Map<string, CloudRemoteFile>();
  private readonly scanInfo = new Map<string, { lastScanAt?: string; error?: string }>();
  private readonly cacheJobs = new Map<string, CloudCacheJob>();
  private readonly cacheControllers = new Map<string, AbortController>();
  private readonly localizedMetadata = new Map<string, Promise<Partial<MediaItem>>>();
  private readonly pendingBaidu = new Map<string, PendingBaiduAuthorization>();
  private readonly baiduDlinks = new Map<string, { url: string; expiresAt: number }>();
  private baiduConnector?: StoredBaiduConnector;
  private baiduConnectorInvalid = false;
  private readonly refreshPromises = new Map<string, Promise<string>>();
  private readonly persistenceRequired = new Set<string>();
  private readonly cacheRecords = new Map<string, CloudCacheRecord>();
  private readonly cacheLeases = new Map<string, number>();
  private readonly downloadQueue: DownloadRequest[] = [];
  private activeDownloads = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private cacheManifestSaveQueue: Promise<void> = Promise.resolve();
  private cachePruneQueue: Promise<void> = Promise.resolve();
  private encryptionKey = Buffer.alloc(0);
  private readonly storePath: string;
  private readonly keyPath: string;
  private readonly cacheRoot: string;
  private readonly cacheManifestPath: string;
  private readonly runtime: CloudManagerRuntimeOptions;

  constructor(
    private readonly config: LocalisConfig,
    private readonly endpoints = {
      baiduOAuth: 'https://openapi.baidu.com',
      baiduPan: 'https://pan.baidu.com',
    },
    runtime: Partial<CloudManagerRuntimeOptions> = {},
  ) {
    this.storePath = path.join(config.dataDir, 'cloud-sources.json');
    this.keyPath = path.join(config.dataDir, 'cloud-secrets.key');
    this.cacheRoot = path.join(config.cacheDir, 'cloud');
    this.cacheManifestPath = path.join(this.cacheRoot, 'manifest.json');
    this.runtime = {
      streamHeaderTimeoutMs: runtime.streamHeaderTimeoutMs ?? 60_000,
      streamIdleTimeoutMs: runtime.streamIdleTimeoutMs ?? 60_000,
      baiduPageDelayMs: runtime.baiduPageDelayMs ?? 6_500,
      maxWebDavXmlBytes: runtime.maxWebDavXmlBytes ?? 32 * 1024 * 1024,
    };
  }

  async initialize() {
    await mkdir(this.cacheRoot, { recursive: true });
    this.encryptionKey = await this.loadEncryptionKey();
    let migratedPlaintextAppKey = false;
    try {
      const stored = JSON.parse(await readFile(this.storePath, 'utf8')) as StoredCloudState;
      for (const source of stored.sources ?? []) {
        if (source.kind === 'baidu-official' && typeof source.appKey === 'string') {
          source.appKey = this.encrypt(this.validateBaiduAppKey(source.appKey));
          migratedPlaintextAppKey = true;
        }
        this.sources.set(source.id, source);
      }
      if (stored.connectors?.baidu) {
        this.baiduConnector = stored.connectors.baidu;
        try {
          this.decrypt(this.baiduConnector.appKey);
          this.decrypt(this.baiduConnector.secretKey);
          this.validateBaiduCredentials({
            appKey: this.decrypt(this.baiduConnector.appKey),
            secretKey: this.decrypt(this.baiduConnector.secretKey),
            appFolder: this.baiduConnector.appFolder,
          });
        } catch {
          this.baiduConnectorInvalid = true;
        }
      }
    } catch {
      // Cloud sources are optional on first run.
    }
    if (migratedPlaintextAppKey) await this.save();
    await this.loadCacheManifest();
  }

  private cachePathFor(fileName: string) {
    const target = path.resolve(this.cacheRoot, fileName);
    const relative = path.relative(this.cacheRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(relative) !== relative) return undefined;
    return target;
  }

  private async loadCacheManifest() {
    let stored: { records?: CloudCacheRecord[] } = {};
    try { stored = JSON.parse(await readFile(this.cacheManifestPath, 'utf8')) as { records?: CloudCacheRecord[] }; } catch { /* first run */ }
    const entries = await readdir(this.cacheRoot, { withFileTypes: true });
    const declared = new Set<string>();
    // A .part cannot belong to this fresh process. Removing it on startup makes
    // crash recovery deterministic and ensures temporary bytes count cannot grow
    // forever outside the configured cache budget.
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.part')).map((entry) => rm(path.join(this.cacheRoot, entry.name), { force: true })));
    for (const record of stored.records ?? []) {
      const target = this.cachePathFor(record.fileName);
      if (!target || !this.sources.has(record.sourceId)) continue;
      try {
        const info = await stat(target);
        if (!info.isFile() || (record.size > 0 && info.size !== record.size)) continue;
        const normalized = { ...record, size: info.size, lastAccessAt: Number(record.lastAccessAt) || info.mtimeMs };
        declared.add(record.fileName);
        this.cacheRecords.set(target, normalized);
        this.cacheJobs.set(record.remoteFileId, {
          remoteFileId: record.remoteFileId,
          state: 'ready',
          path: target,
          progressBytes: info.size,
          totalBytes: info.size,
          startedAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString(),
          lastAccessAt: normalized.lastAccessAt,
        });
      } catch { /* stale manifest entry */ }
    }
    // Final cache objects without ownership metadata predate the manifest and
    // cannot be safely tied to a removed cloud account, so discard them once.
    await Promise.all(entries.filter((entry) => entry.isFile()
      && entry.name !== path.basename(this.cacheManifestPath)
      && !entry.name.endsWith('.part')
      && !declared.has(entry.name))
      .map((entry) => rm(path.join(this.cacheRoot, entry.name), { force: true })));
    await this.saveCacheManifest();
  }

  private async loadEncryptionKey() {
    const readPersisted = async () => {
      let encoded: string;
      try {
        encoded = (await readFile(this.keyPath, 'utf8')).trim();
      } catch (error) {
        throw error;
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) {
        throw new CloudSourceError(
          'cloud_encryption_key_invalid',
          '云盘加密密钥文件已损坏。请先备份数据目录并恢复 cloud-secrets.key，Localis 不会用临时密钥覆盖现有数据。',
          500,
        );
      }
      return key;
    };
    try {
      return await readPersisted();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = randomBytes(32);
    try {
      await writeFile(this.keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
      await chmod(this.keyPath, 0o600).catch(() => undefined);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return readPersisted();
    }
  }

  private encrypt(value: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private decrypt(value: EncryptedSecret) {
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
  }

  private validateBaiduCredentials(input: { appKey: unknown; secretKey: unknown; appFolder: unknown }) {
    if (typeof input.appKey !== 'string' || typeof input.secretKey !== 'string' || typeof input.appFolder !== 'string') {
      throw new CloudSourceError('invalid_baidu_app', '请填写有效的百度 AppKey、SecretKey 和单层应用目录名称。');
    }
    const appKey = this.validateBaiduAppKey(input.appKey);
    const secretKey = input.secretKey.trim();
    const appFolder = input.appFolder.trim().replace(/^\/+|\/+$/g, '');
    if (!secretKey || secretKey.length > 512 || /[\0-\x1f\x7f]/.test(secretKey)
      || !appFolder || appFolder.length > 100 || appFolder.includes('..') || /[\\/\0-\x1f\x7f]/.test(appFolder)) {
      throw new CloudSourceError('invalid_baidu_app', '请填写有效的百度 AppKey、SecretKey 和单层应用目录名称。');
    }
    return { appKey, secretKey, appFolder };
  }

  private validateBaiduAppKey(value: unknown) {
    if (typeof value !== 'string') throw new CloudSourceError('invalid_baidu_app', '百度 AppKey 格式无效。');
    const appKey = value.trim();
    if (!appKey || appKey.length > 256 || /[\0-\x1f\x7f]/.test(appKey)) {
      throw new CloudSourceError('invalid_baidu_app', '百度 AppKey 格式无效。');
    }
    return appKey;
  }

  private baiduSourceAppKey(source: StoredBaiduSource) {
    return this.validateBaiduAppKey(typeof source.appKey === 'string' ? source.appKey : this.decrypt(source.appKey));
  }

  private hasEnvironmentBaiduConfiguration() {
    return Boolean(this.config.baiduAppKey?.trim() || this.config.baiduSecretKey?.trim());
  }

  private effectiveBaiduConnector(): EffectiveBaiduConnector | undefined {
    if (this.hasEnvironmentBaiduConfiguration()) {
      try {
        return {
          ...this.validateBaiduCredentials({
            appKey: this.config.baiduAppKey,
            secretKey: this.config.baiduSecretKey,
            appFolder: this.config.baiduAppFolder || 'Localis',
          }),
          managedBy: 'environment',
        };
      } catch {
        throw new CloudSourceError(
          'baidu_connector_invalid',
          '电脑环境变量中的百度应用配置不完整或无效，请同时检查 LOCALIS_BAIDU_APP_KEY 和 LOCALIS_BAIDU_SECRET_KEY。',
          503,
        );
      }
    }
    if (!this.baiduConnector) return undefined;
    if (this.baiduConnectorInvalid) {
      throw new CloudSourceError('baidu_connector_invalid', '电脑上保存的百度应用配置无法解密，请重新配置。', 503);
    }
    try {
      return {
        ...this.validateBaiduCredentials({
          appKey: this.decrypt(this.baiduConnector.appKey),
          secretKey: this.decrypt(this.baiduConnector.secretKey),
          appFolder: this.baiduConnector.appFolder,
        }),
        managedBy: 'computer',
      };
    } catch {
      this.baiduConnectorInvalid = true;
      throw new CloudSourceError('baidu_connector_invalid', '电脑上保存的百度应用配置无法解密，请重新配置。', 503);
    }
  }

  async configureBaiduConnector(input: { appKey: unknown; secretKey: unknown; appFolder?: unknown }) {
    if (this.hasEnvironmentBaiduConfiguration()) {
      throw new CloudSourceError(
        'baidu_connector_managed_by_environment',
        '百度应用由电脑环境变量管理，请修改环境变量并重启 Localis。',
        409,
      );
    }
    const normalized = this.validateBaiduCredentials({ ...input, appFolder: input.appFolder ?? 'Localis' });
    const previous = this.baiduConnector;
    const previousInvalid = this.baiduConnectorInvalid;
    this.baiduConnector = {
      appKey: this.encrypt(normalized.appKey),
      secretKey: this.encrypt(normalized.secretKey),
      appFolder: normalized.appFolder,
      configuredAt: new Date().toISOString(),
    };
    this.baiduConnectorInvalid = false;
    try {
      await this.save();
    } catch (error) {
      this.baiduConnector = previous;
      this.baiduConnectorInvalid = previousInvalid;
      throw error;
    }
    this.pendingBaidu.clear();
  }

  async removeBaiduConnector() {
    if (this.hasEnvironmentBaiduConfiguration()) {
      throw new CloudSourceError(
        'baidu_connector_managed_by_environment',
        '百度应用由电脑环境变量管理，请修改环境变量并重启 Localis。',
        409,
      );
    }
    const previous = this.baiduConnector;
    const previousInvalid = this.baiduConnectorInvalid;
    this.baiduConnector = undefined;
    this.baiduConnectorInvalid = false;
    try {
      await this.save();
    } catch (error) {
      this.baiduConnector = previous;
      this.baiduConnectorInvalid = previousInvalid;
      throw error;
    }
    this.pendingBaidu.clear();
  }

  private async save() {
    const operation = this.saveQueue.then(async () => {
      const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({
          version: 2,
          connectors: this.baiduConnector ? { baidu: this.baiduConnector } : {},
          sources: [...this.sources.values()],
        }, null, 2), { mode: 0o600 });
        await rename(temporary, this.storePath);
        await chmod(this.storePath, 0o600).catch(() => undefined);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }

  private async saveCacheManifest() {
    const operation = this.cacheManifestSaveQueue.then(async () => {
      const temporary = `${this.cacheManifestPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, records: [...this.cacheRecords.values()] }, null, 2), { mode: 0o600 });
        await rename(temporary, this.cacheManifestPath);
        await chmod(this.cacheManifestPath, 0o600).catch(() => undefined);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.cacheManifestSaveQueue = operation.catch(() => undefined);
    return operation;
  }

  summaries(): CloudSourceSummary[] {
    return [...this.sources.values()].map((source) => {
      const info = this.scanInfo.get(source.id);
      return {
        id: source.id,
        provider: source.provider,
        name: source.name,
        connection: source.kind === 'webdav' ? 'OpenList WebDAV' : '百度官方 API',
        rootPath: source.rootPath,
        endpoint: source.kind === 'webdav' ? new URL(source.baseUrl).origin : undefined,
        fileCount: [...this.remoteFiles.values()].filter((file) => file.sourceId === source.id).length,
        lastScanAt: info?.lastScanAt,
        error: info?.error,
      };
    });
  }

  files() {
    return [...this.remoteFiles.values()];
  }

  private pruneBaiduAuthorizations() {
    for (const [id, pending] of this.pendingBaidu) {
      if (pending.expiresAt <= Date.now()) this.pendingBaidu.delete(id);
    }
  }

  private baiduAuthorizationView(pending: PendingBaiduAuthorization): BaiduAuthorizationView {
    return {
      sessionId: pending.id,
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
      qrCodeDataUrl: pending.qrCodeDataUrl,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      intervalSeconds: pending.intervalMs / 1000,
    };
  }

  connectorCapabilities(): CloudConnectorCapabilities {
    this.pruneBaiduAuthorizations();
    let baiduConnector: EffectiveBaiduConnector | undefined;
    let configuration: 'ready' | 'missing' | 'invalid' = 'missing';
    try {
      baiduConnector = this.effectiveBaiduConnector();
      if (baiduConnector) configuration = 'ready';
    } catch {
      configuration = 'invalid';
    }
    const activeAuthorization = baiduConnector
      ? [...this.pendingBaidu.values()].find((pending) => pending.appKey === baiduConnector.appKey && pending.appFolder === baiduConnector.appFolder)
      : undefined;
    return {
      baidu: {
        available: configuration === 'ready',
        configuration,
        setupRequired: configuration !== 'ready',
        managedBy: this.hasEnvironmentBaiduConfiguration()
          ? 'environment'
          : this.baiduConnector ? 'computer' : undefined,
        canConfigure: !this.hasEnvironmentBaiduConfiguration(),
        login: 'qr',
        appFolder: baiduConnector?.appFolder || this.baiduConnector?.appFolder || this.config.baiduAppFolder?.trim() || 'Localis',
        activeAuthorization: activeAuthorization ? this.baiduAuthorizationView(activeAuthorization) : undefined,
        unavailableReason: configuration === 'ready'
          ? undefined
          : configuration === 'invalid'
            ? '电脑上的百度应用配置不完整或无法解密，请重新配置。'
            : '请先在这台电脑上完成一次百度开放平台应用配置；之后用户只需扫码登录。',
      },
      quark: {
        available: false,
        login: 'official-api-required',
        advancedWebDavAvailable: true,
        unavailableReason: '夸克尚未向 Localis 开放可嵌入的扫码、目录浏览与 Range 播放接口；为保护账号，Localis 不调用私有 Cookie 接口或明文第三方换票服务。',
      },
    };
  }

  file(id: string) {
    return this.remoteFiles.get(id);
  }

  private webDavUrl(source: StoredWebDavSource, relativePath = '') {
    const url = new URL(source.baseUrl);
    const joined = [url.pathname, encodePath(source.rootPath), encodePath(relativePath)]
      .join('/')
      .replace(/\/{2,}/g, '/');
    url.pathname = joined.endsWith('/') ? joined : `${joined}/`;
    url.search = '';
    url.hash = '';
    return url;
  }

  private webDavHeaders(source: StoredWebDavSource) {
    return {
      Authorization: `Basic ${Buffer.from(`${source.username}:${this.decrypt(source.password)}`, 'utf8').toString('base64')}`,
      'User-Agent': 'Localis/0.2 WebDAV Reader',
    };
  }

  private async propfind(source: StoredWebDavSource, relativeDirectory: string) {
    const directoryUrl = this.webDavUrl(source, relativeDirectory);
    const response = await fetch(directoryUrl, {
      method: 'PROPFIND',
      redirect: 'manual',
      headers: {
        ...this.webDavHeaders(source),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 207) {
      await response.body?.cancel();
      throw new CloudSourceError('webdav_connection_failed', `OpenList WebDAV 返回 HTTP ${response.status}，请检查只读账号、路径和“本地代理”设置。`, 502);
    }
    const xml = await readTextLimited(response, this.runtime.maxWebDavXmlBytes);
    const rootUrl = this.webDavUrl(source);
    const rootPathname = decodeURIComponent(rootUrl.pathname).replace(/\/+$/, '');
    const currentPathname = decodeURIComponent(directoryUrl.pathname).replace(/\/+$/, '');
    const result: Array<CloudRemoteFile & { collection: boolean }> = [];
    const blocks = xml.match(/<(?:[\w.-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) ?? [];
    for (const block of blocks) {
      const href = xmlTag(block, 'href');
      if (!href) continue;
      const propstats = block.match(/<(?:[\w.-]+:)?propstat\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?propstat>/gi) ?? [];
      const successfulPropstats = propstats.filter((propstat) => {
        const status = xmlTag(propstat, 'status');
        return !status || /\s200(?:\s|$)/.test(status);
      });
      if (propstats.length > 0 && successfulPropstats.length === 0) continue;
      const propertyBlock = successfulPropstats.length > 0 ? successfulPropstats.join('') : block;
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(href, directoryUrl).pathname).replace(/\/+$/, ''); } catch { continue; }
      if (pathname !== rootPathname && !pathname.startsWith(`${rootPathname}/`)) continue;
      // A Depth: 1 response includes the requested collection itself. Skipping it
      // prevents a subdirectory from being queued recursively forever.
      if (pathname === currentPathname) continue;
      const relativePath = pathname.slice(rootPathname.length).replace(/^\/+/, '');
      if (!relativePath) continue;
      const fileName = xmlTag(propertyBlock, 'displayname') || relativePath.split('/').pop() || relativePath;
      const collection = /<(?:[\w.-]+:)?collection(?:\s*\/|\b[^>]*>)/i.test(propertyBlock);
      const providerFileId = `/${relativePath}`;
      result.push({
        id: stableRemoteId(source.id, providerFileId),
        sourceId: source.id,
        provider: source.provider,
        sourceName: source.name,
        providerFileId,
        fileName,
        relativePath,
        size: Number(xmlTag(propertyBlock, 'getcontentlength') || 0),
        modifiedAt: safeIso(xmlTag(propertyBlock, 'getlastmodified')),
        contentType: xmlTag(propertyBlock, 'getcontenttype'),
        etag: xmlTag(propertyBlock, 'getetag'),
        collection,
      });
    }
    return result;
  }

  private async scanWebDav(source: StoredWebDavSource) {
    const queue = [''];
    const visited = new Set<string>();
    const files: CloudRemoteFile[] = [];
    while (queue.length && files.length < 10_000 && visited.size < 10_000) {
      const directory = queue.shift()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      if (directory.split('/').filter(Boolean).length > 32) continue;
      for (const entry of await this.propfind(source, directory)) {
        if (entry.collection && !visited.has(entry.relativePath)) queue.push(entry.relativePath);
        else if (mediaExtensions.has(path.extname(entry.fileName).toLowerCase())) {
          const { collection: _collection, ...file } = entry;
          files.push(file);
        }
      }
    }
    return files;
  }

  async connectWebDav(input: { provider: CloudProvider; name?: string; baseUrl: string; rootPath?: string; username: string; password: string }) {
    if (!['quark', 'baidu'].includes(input.provider)) throw new CloudSourceError('invalid_cloud_provider', '仅支持夸克或百度网盘。');
    let baseUrl: URL;
    try { baseUrl = new URL(input.baseUrl); } catch { throw new CloudSourceError('invalid_webdav_url', '请输入有效的 OpenList WebDAV 地址。'); }
    if (!['http:', 'https:'].includes(baseUrl.protocol) || !isLoopbackHost(baseUrl.hostname) || baseUrl.username || baseUrl.password) {
      throw new CloudSourceError('unsafe_webdav_url', '为防止凭据泄漏，OpenList 必须运行在本机 localhost/127.0.0.1，账号密码请使用独立输入框。');
    }
    if (!input.username.trim() || !input.password) throw new CloudSourceError('missing_webdav_credentials', '请输入 OpenList 只读用户名和密码。');
    const rootPath = normalizeRootPath(input.rootPath || (input.provider === 'quark' ? '/Quark' : '/Baidu'));
    if (rootPath.split('/').some((part) => part === '.' || part === '..')) {
      throw new CloudSourceError('invalid_webdav_root', '云盘挂载路径不能包含 . 或 .. 路径段。');
    }
    const source: StoredWebDavSource = {
      id: randomUUID(),
      kind: 'webdav',
      provider: input.provider,
      name: input.name?.trim().slice(0, 80) || (input.provider === 'quark' ? '夸克网盘' : '百度网盘'),
      baseUrl: `${baseUrl.origin}${baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`}`,
      rootPath,
      username: input.username.trim(),
      password: this.encrypt(input.password),
      createdAt: new Date().toISOString(),
    };
    const files = await this.scanWebDav(source);
    this.sources.set(source.id, source);
    for (const file of files) this.remoteFiles.set(file.id, file);
    this.scanInfo.set(source.id, { lastScanAt: new Date().toISOString() });
    await this.save();
    return this.summaries().find((candidate) => candidate.id === source.id)!;
  }

  async startBaiduAuthorization(input: { name?: string } = {}) {
    this.pruneBaiduAuthorizations();
    const connector = this.effectiveBaiduConnector();
    if (!connector) {
      throw new CloudSourceError(
        'baidu_connector_unconfigured',
        '请先在这台电脑上完成一次百度应用配置；之后用户即可只扫码登录。',
        503,
      );
    }
    const { appKey, secretKey, appFolder } = connector;
    const reusable = [...this.pendingBaidu.values()].find((pending) => pending.appKey === appKey && pending.appFolder === appFolder);
    if (reusable) return this.baiduAuthorizationView(reusable);
    if (this.pendingBaidu.size >= 10) throw new CloudSourceError('too_many_baidu_sessions', '等待授权的百度会话过多，请稍后再试。', 429);
    const url = new URL('/oauth/2.0/device/code', this.endpoints.baiduOAuth);
    url.search = new URLSearchParams({ response_type: 'device_code', client_id: appKey, scope: 'basic,netdisk' }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof body.device_code !== 'string') {
      throw new CloudSourceError('baidu_device_code_failed', String(body.error_description || body.error || `百度授权服务返回 HTTP ${response.status}`), 502);
    }
    const verificationUrl = String(body.verification_url || body.qrcode_url || 'https://openapi.baidu.com/device');
    const qrTarget = String(body.qrcode_url || verificationUrl);
    const pending: PendingBaiduAuthorization = {
      id: randomUUID(),
      name: input.name?.trim().slice(0, 80) || '百度网盘',
      appFolder,
      appKey,
      secretKey,
      deviceCode: String(body.device_code),
      userCode: String(body.user_code || ''),
      verificationUrl,
      qrCodeDataUrl: await QRCode.toDataURL(qrTarget, { width: 320, margin: 2 }),
      expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 300)) * 1000,
      intervalMs: Math.max(5, Number(body.interval || 5)) * 1000,
      nextPollAt: Date.now(),
    };
    this.pendingBaidu.set(pending.id, pending);
    return this.baiduAuthorizationView(pending);
  }

  async pollBaiduAuthorization(sessionId: string) {
    const pending = this.pendingBaidu.get(sessionId);
    if (!pending) throw new CloudSourceError('baidu_session_not_found', '百度授权会话不存在或已经过期。', 404);
    if (Date.now() >= pending.expiresAt) {
      this.pendingBaidu.delete(sessionId);
      throw new CloudSourceError('baidu_authorization_expired', '百度授权二维码已经过期，请重新开始。', 410);
    }
    if (Date.now() < pending.nextPollAt) return { state: 'pending', retryAfterSeconds: Math.ceil((pending.nextPollAt - Date.now()) / 1000) };
    pending.nextPollAt = Date.now() + pending.intervalMs;
    const url = new URL('/oauth/2.0/token', this.endpoints.baiduOAuth);
    url.search = new URLSearchParams({
      grant_type: 'device_token',
      code: pending.deviceCode,
      client_id: pending.appKey,
      client_secret: pending.secretKey,
    }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({})) as BaiduTokenResponse;
    if (body.error === 'authorization_pending' || body.error === 'slow_down') {
      if (body.error === 'slow_down') pending.intervalMs += 5_000;
      pending.nextPollAt = Date.now() + pending.intervalMs;
      return { state: 'pending', retryAfterSeconds: pending.intervalMs / 1000 };
    }
    if (body.error === 'expired_token' || body.error === 'access_denied' || body.error === 'authorization_declined') {
      this.pendingBaidu.delete(sessionId);
      throw new CloudSourceError(
        body.error === 'expired_token' ? 'baidu_authorization_expired' : 'baidu_authorization_denied',
        body.error_description || (body.error === 'expired_token' ? '百度授权二维码已经过期，请重新获取。' : '百度授权已被拒绝，请重新发起授权。'),
        body.error === 'expired_token' ? 410 : 403,
      );
    }
    if (!response.ok || !body.access_token || !body.refresh_token) {
      throw new CloudSourceError('baidu_authorization_failed', body.error_description || body.error || `百度授权返回 HTTP ${response.status}`, 502);
    }
    const source: StoredBaiduSource = {
      id: randomUUID(),
      kind: 'baidu-official',
      provider: 'baidu',
      name: pending.name,
      rootPath: `/apps/${pending.appFolder}`,
      appKey: this.encrypt(pending.appKey),
      secretKey: this.encrypt(pending.secretKey),
      accessToken: this.encrypt(body.access_token),
      refreshToken: this.encrypt(body.refresh_token),
      expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 2_592_000)) * 1000,
      createdAt: new Date().toISOString(),
    };
    this.sources.set(source.id, source);
    this.pendingBaidu.delete(sessionId);
    await this.save();
    // Authorization has succeeded even when the first list call is temporarily
    // rate-limited or offline. Keep the source and expose its scan error so the
    // user can refresh later without scanning the QR code again.
    try { await this.refreshSource(source.id); } catch { /* summary carries the scan error */ }
    return { state: 'authorized', source: this.summaries().find((candidate) => candidate.id === source.id) };
  }

  private async baiduAccessToken(source: StoredBaiduSource) {
    if (this.persistenceRequired.has(source.id)) {
      await this.save();
      this.persistenceRequired.delete(source.id);
    }
    if (source.expiresAt > Date.now() + 5 * 60_000) return this.decrypt(source.accessToken);
    const known = this.refreshPromises.get(source.id);
    if (known) return known;
    const operation = (async () => {
      const url = new URL('/oauth/2.0/token', this.endpoints.baiduOAuth);
      url.search = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.decrypt(source.refreshToken),
        client_id: this.baiduSourceAppKey(source),
        client_secret: this.decrypt(source.secretKey),
      }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await response.json().catch(() => ({})) as BaiduTokenResponse;
      if (!response.ok || !body.access_token || !body.refresh_token) {
        throw new CloudSourceError('baidu_refresh_failed', body.error_description || body.error || '百度授权已失效，请重新连接。', 502);
      }
      source.accessToken = this.encrypt(body.access_token);
      source.refreshToken = this.encrypt(body.refresh_token);
      source.expiresAt = Date.now() + Math.max(60, Number(body.expires_in || 2_592_000)) * 1000;
      this.persistenceRequired.add(source.id);
      await this.save();
      this.persistenceRequired.delete(source.id);
      return body.access_token;
    })().finally(() => this.refreshPromises.delete(source.id));
    this.refreshPromises.set(source.id, operation);
    return operation;
  }

  private async scanBaidu(source: StoredBaiduSource) {
    const token = await this.baiduAccessToken(source);
    const files: CloudRemoteFile[] = [];
    let cursor = '0';
    for (let page = 0; page < 10 && files.length < 10_000; page += 1) {
      const url = new URL('/rest/2.0/xpan/multimedia', this.endpoints.baiduPan);
      url.search = new URLSearchParams({
        method: 'listall', access_token: token, path: source.rootPath, recursion: '1',
        order: 'time', desc: '1', start: cursor, limit: '1000', web: '1',
      }).toString();
      const response = await fetch(url, { headers: { 'User-Agent': 'pan.baidu.com' }, signal: AbortSignal.timeout(30_000) });
      const body = await baiduJson<{ errno?: number; list?: BaiduListEntry[]; has_more?: number; cursor?: number | string; errmsg?: string }>(response);
      if (!response.ok || (body.errno !== undefined && body.errno !== 0)) {
        throw new CloudSourceError('baidu_list_failed', body.errmsg || `百度文件列表返回 errno ${body.errno ?? response.status}`, 502);
      }
      for (const entry of body.list ?? []) {
        if (entry.isdir || !mediaExtensions.has(path.extname(entry.server_filename).toLowerCase())) continue;
        const providerFileId = String(entry.fs_id);
        files.push({
          id: stableRemoteId(source.id, providerFileId),
          sourceId: source.id,
          provider: 'baidu',
          sourceName: source.name,
          providerFileId,
          fileName: entry.server_filename,
          relativePath: entry.path.startsWith(source.rootPath) ? entry.path.slice(source.rootPath.length).replace(/^\/+/, '') : entry.server_filename,
          size: Number(entry.size || 0),
          modifiedAt: new Date(Math.max(0, Number(entry.server_mtime || entry.local_mtime || 0)) * 1000).toISOString(),
        });
      }
      if (!body.has_more) break;
      const nextCursor = String(body.cursor ?? '');
      if (!nextCursor || nextCursor === cursor) {
        throw new CloudSourceError('baidu_cursor_stalled', '百度文件列表分页游标没有前进，已停止扫描以避免重复请求。', 502);
      }
      if (page === 9 || files.length >= 10_000) {
        throw new CloudSourceError('baidu_list_too_large', '百度应用目录超过 10000 个媒体文件，请拆分应用目录后重新扫描。', 413);
      }
      cursor = nextCursor;
      if (this.runtime.baiduPageDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.runtime.baiduPageDelayMs));
    }
    return files;
  }

  async refreshSource(id: string) {
    const source = this.sources.get(id);
    if (!source) throw new CloudSourceError('cloud_source_not_found', '云盘连接不存在。', 404);
    try {
      const files = source.kind === 'webdav' ? await this.scanWebDav(source) : await this.scanBaidu(source);
      for (const [fileId, file] of this.remoteFiles) if (file.sourceId === id) this.remoteFiles.delete(fileId);
      for (const file of files) this.remoteFiles.set(file.id, file);
      this.scanInfo.set(id, { lastScanAt: new Date().toISOString() });
      return files;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.scanInfo.set(id, { ...this.scanInfo.get(id), error: message });
      throw error;
    }
  }

  async refreshAll() {
    for (const source of this.sources.values()) {
      try { await this.refreshSource(source.id); } catch (error) {
        console.warn(`[Localis] 云盘 ${source.name} 暂时无法刷新：`, error instanceof Error ? error.message : error);
      }
    }
    return this.files();
  }

  async removeSource(id: string) {
    if (!this.sources.delete(id)) throw new CloudSourceError('cloud_source_not_found', '云盘连接不存在。', 404);
    const removedFileIds = new Set<string>();
    for (const [fileId, file] of this.remoteFiles) {
      if (file.sourceId !== id) continue;
      removedFileIds.add(fileId);
      this.remoteFiles.delete(fileId);
    }
    for (const record of this.cacheRecords.values()) if (record.sourceId === id) removedFileIds.add(record.remoteFileId);
    for (const fileId of removedFileIds) {
      this.cacheControllers.get(fileId)?.abort();
      this.cacheControllers.delete(fileId);
      const job = this.cacheJobs.get(fileId);
      this.cacheJobs.delete(fileId);
      if (job) {
        this.localizedMetadata.delete(job.path);
        await rm(job.path, { force: true }).catch(() => undefined);
      }
      this.baiduDlinks.delete(fileId);
    }
    const entries = await readdir(this.cacheRoot, { withFileTypes: true });
    for (const [target, record] of [...this.cacheRecords]) {
      if (record.sourceId !== id) continue;
      this.cacheRecords.delete(target);
      this.localizedMetadata.delete(target);
      await rm(target, { force: true }).catch(() => undefined);
      const prefix = `${path.basename(target)}.`;
      await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.part'))
        .map((entry) => rm(path.join(this.cacheRoot, entry.name), { force: true }))).catch(() => undefined);
    }
    this.scanInfo.delete(id);
    await this.save();
    await this.saveCacheManifest();
  }

  cancelBaiduAuthorization(sessionId: string) {
    if (!this.pendingBaidu.delete(sessionId)) throw new CloudSourceError('baidu_session_not_found', '百度授权会话不存在或已经过期。', 404);
  }

  private async baiduDlink(source: StoredBaiduSource, file: CloudRemoteFile) {
    const cached = this.baiduDlinks.get(file.id);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const token = await this.baiduAccessToken(source);
    const url = new URL('/rest/2.0/xpan/multimedia', this.endpoints.baiduPan);
    url.search = new URLSearchParams({
      method: 'filemetas', access_token: token, fsids: `[${this.baiduFsId(file.providerFileId)}]`,
      dlink: '1', needmedia: '1', detail: '1',
    }).toString();
    const response = await fetch(url, { headers: { 'User-Agent': 'pan.baidu.com' }, signal: AbortSignal.timeout(20_000) });
    const body = await baiduJson<{ errno?: number; list?: Array<{ dlink?: string }>; errmsg?: string }>(response);
    const dlink = body.list?.[0]?.dlink;
    if (!response.ok || body.errno !== 0 || !dlink) throw new CloudSourceError('baidu_download_link_failed', body.errmsg || '无法取得百度网盘下载地址。', 502);
    let download: URL;
    try { download = new URL(dlink); } catch {
      throw new CloudSourceError('baidu_download_link_invalid', '百度网盘返回了无效的下载地址。', 502);
    }
    this.validateBaiduDownloadUrl(download);
    if (!download.searchParams.has('access_token')) download.searchParams.set('access_token', token);
    const value = { url: download.toString(), expiresAt: Date.now() + 7 * 60 * 60_000 };
    this.baiduDlinks.set(file.id, value);
    return value.url;
  }

  private baiduFsId(value: string | undefined) {
    if (!value || !/^\d+$/.test(value)) throw new CloudSourceError('baidu_file_id_invalid', '百度文件 ID 无效，请刷新云盘目录。', 502);
    return value;
  }

  private validateBaiduDownloadUrl(url: URL) {
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      throw new CloudSourceError('baidu_download_link_invalid', '百度网盘返回了不安全的下载地址。', 502);
    }
    const testEndpoint = new URL(this.endpoints.baiduPan);
    if (url.protocol !== 'https:' && !(isLoopbackHost(url.hostname) && isLoopbackHost(testEndpoint.hostname))) {
      throw new CloudSourceError('baidu_download_link_insecure', '百度网盘下载地址不是 HTTPS，已拒绝代理。', 502);
    }
  }

  private async openBaidu(source: StoredBaiduSource, file: CloudRemoteFile, headers: { range?: string; ifRange?: string; signal?: AbortSignal }, retried = false): Promise<Response> {
    let target = await this.baiduDlink(source, file);
    for (let redirects = 0; redirects < 5; redirects += 1) {
      const targetUrl = new URL(target);
      this.validateBaiduDownloadUrl(targetUrl);
      const requestHeaders: Record<string, string> = { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'identity' };
      if (headers.range) requestHeaders.Range = headers.range;
      if (headers.ifRange) requestHeaders['If-Range'] = headers.ifRange;
      const response = await fetchWithHeaderTimeout(targetUrl, { redirect: 'manual', headers: requestHeaders, signal: headers.signal }, this.runtime.streamHeaderTimeoutMs);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new CloudSourceError('baidu_redirect_failed', '百度下载跳转缺少地址。', 502);
        try {
          const redirected = new URL(location, target);
          this.validateBaiduDownloadUrl(redirected);
          target = redirected.toString();
        } catch (error) {
          if (error instanceof CloudSourceError) throw error;
          throw new CloudSourceError('baidu_redirect_invalid', '百度下载跳转地址无效。', 502);
        }
        continue;
      }
      if ((response.status === 403 || response.status === 401) && !retried) {
        await response.body?.cancel();
        this.baiduDlinks.delete(file.id);
        return this.openBaidu(source, file, headers, true);
      }
      return response;
    }
    throw new CloudSourceError('baidu_redirect_limit', '百度下载跳转次数过多。', 502);
  }

  async openFile(id: string, headers: { range?: string; ifRange?: string; signal?: AbortSignal } = {}) {
    const file = this.remoteFiles.get(id);
    if (!file) throw new CloudSourceError('cloud_file_not_found', '云盘文件不存在，请刷新媒体库。', 404);
    const source = this.sources.get(file.sourceId);
    if (!source) throw new CloudSourceError('cloud_source_not_found', '云盘连接已被移除。', 404);
    if (source.kind === 'baidu-official') return this.openBaidu(source, file, headers);
    const relativeUrl = this.webDavUrl(source, file.relativePath);
    relativeUrl.pathname = relativeUrl.pathname.replace(/\/$/, '');
    const requestHeaders: Record<string, string> = this.webDavHeaders(source);
    requestHeaders['Accept-Encoding'] = 'identity';
    if (headers.range) requestHeaders.Range = headers.range;
    if (headers.ifRange) requestHeaders['If-Range'] = headers.ifRange;
    const response = await fetchWithHeaderTimeout(relativeUrl, { redirect: 'manual', headers: requestHeaders, signal: headers.signal }, this.runtime.streamHeaderTimeoutMs);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CloudSourceError('webdav_proxy_required', 'OpenList 返回了 302；请把该存储的 WebDAV 策略改为“本地代理/Native Proxy”。', 502);
    }
    return response;
  }

  ensureCached(item: MediaItem) {
    if (item.sourceType === 'local' || !item.remoteFileId) throw new CloudSourceError('cloud_file_required', '这不是云盘文件。');
    const file = this.remoteFiles.get(item.remoteFileId);
    if (!file) throw new CloudSourceError('cloud_file_not_found', '云盘文件不存在，请刷新媒体库。', 404);
    const limit = this.config.cloudCacheBytes ?? 50 * 1024 ** 3;
    if (file.size > limit) {
      throw new CloudSourceError('cloud_file_exceeds_cache_limit', `该云盘文件为 ${file.size} 字节，超过电脑端云缓存上限 ${limit} 字节。`, 507);
    }
    const version = createHash('sha256').update([file.sourceId, file.id, file.size, file.modifiedAt, file.etag || ''].join('|')).digest('hex').slice(0, 32);
    const cachePath = path.join(this.cacheRoot, `${version}${path.extname(file.fileName).toLowerCase()}`);
    let known = this.cacheJobs.get(item.remoteFileId);
    if (known && known.path !== cachePath) {
      if (known.state === 'queued' || known.state === 'downloading') this.cacheControllers.get(item.remoteFileId)?.abort();
      this.cacheJobs.delete(item.remoteFileId);
      known = undefined;
    }
    if (known?.state === 'ready' && !existsSync(known.path)) {
      this.cacheJobs.delete(item.remoteFileId);
      this.cacheRecords.delete(known.path);
      void this.saveCacheManifest();
      known = undefined;
    }
    if (known && known.state !== 'failed') {
      known.lastAccessAt = Date.now();
      const record = this.cacheRecords.get(known.path);
      if (record) record.lastAccessAt = known.lastAccessAt;
      return known;
    }
    if (known?.state === 'failed' && Date.now() - (known.failedAt ?? Date.now()) < 5_000) return known;
    const job: CloudCacheJob = {
      remoteFileId: file.id,
      state: 'queued',
      path: cachePath,
      progressBytes: 0,
      totalBytes: file.size,
      startedAt: new Date().toISOString(),
      lastAccessAt: Date.now(),
    };
    this.cacheJobs.set(file.id, job);
    const controller = new AbortController();
    this.cacheControllers.set(file.id, controller);
    this.downloadQueue.push({ file, job, controller });
    this.pumpDownloadQueue();
    return job;
  }

  private pumpDownloadQueue() {
    const maximum = Math.min(2, Math.max(1, this.config.maxCloudDownloads ?? 1));
    while (this.activeDownloads < maximum && this.downloadQueue.length > 0) {
      const request = this.downloadQueue.shift()!;
      if (request.controller.signal.aborted || this.cacheJobs.get(request.file.id) !== request.job) continue;
      this.activeDownloads += 1;
      request.job.state = 'downloading';
      void this.downloadToCache(request.file, request.job, request.controller.signal).finally(() => {
        this.activeDownloads -= 1;
        if (this.cacheControllers.get(request.file.id) === request.controller) this.cacheControllers.delete(request.file.id);
        this.pumpDownloadQueue();
      });
    }
  }

  private cacheMediaEntries() {
    return readdir(this.cacheRoot, { withFileTypes: true }).then(async (entries) => Promise.all(entries
      .filter((entry) => entry.isFile()
        && entry.name !== path.basename(this.cacheManifestPath)
        && !entry.name.includes('.tmp'))
      .map(async (entry) => {
        const target = path.join(this.cacheRoot, entry.name);
        const info = await stat(target);
        return { target, size: info.size, modifiedAt: info.mtimeMs, part: entry.name.endsWith('.part') };
      })));
  }

  private async prepareCacheCapacity(file: CloudRemoteFile, job: CloudCacheJob) {
    const limit = this.config.cloudCacheBytes ?? 50 * 1024 ** 3;
    const required = file.size || limit;
    const otherRemaining = [...this.cacheJobs.values()]
      .filter((candidate) => candidate !== job && candidate.state === 'downloading')
      .reduce((sum, candidate) => sum + Math.max(0, (candidate.totalBytes || limit) - candidate.progressBytes), 0);
    const targetExistingBytes = limit - required - otherRemaining;
    if (targetExistingBytes < 0) throw new CloudSourceError('cloud_cache_capacity', '电脑端云缓存空间已被正在进行的下载预留，请稍后重试。', 507);
    await this.pruneCloudCache(undefined, targetExistingBytes);
    const current = (await this.cacheMediaEntries()).reduce((sum, entry) => sum + entry.size, 0);
    if (current > targetExistingBytes) {
      throw new CloudSourceError('cloud_cache_capacity', '电脑端云缓存中有正在使用的文件，剩余配额不足。', 507);
    }
    try {
      const disk = await statfs(this.cacheRoot);
      const available = Number(disk.bavail) * Number(disk.bsize);
      if (Number.isFinite(available) && available < required + 64 * 1024 * 1024) {
        throw new CloudSourceError('cloud_cache_disk_full', '电脑磁盘可用空间不足，无法安全缓存该云盘文件。', 507);
      }
    } catch (error) {
      if (error instanceof CloudSourceError) throw error;
      // statfs is not available on every supported filesystem; the byte quota
      // and streaming guard below still enforce the configured hard limit.
    }
  }

  private async downloadToCache(file: CloudRemoteFile, job: CloudCacheJob, signal: AbortSignal) {
    const temporary = `${job.path}.${process.pid}.part`;
    const idleController = new AbortController();
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        idleController.abort();
      }, this.runtime.streamIdleTimeoutMs);
      idleTimer.unref();
    };
    try {
      try {
        const existing = await stat(job.path);
        if (!file.size || existing.size === file.size) {
          job.progressBytes = existing.size;
          job.totalBytes = existing.size;
          job.state = 'ready';
          job.lastAccessAt = Date.now();
          this.cacheRecords.set(job.path, {
            sourceId: file.sourceId,
            remoteFileId: file.id,
            fileName: path.basename(job.path),
            size: existing.size,
            lastAccessAt: job.lastAccessAt,
          });
          await this.saveCacheManifest();
          return;
        }
      } catch { /* download below */ }
      await this.prepareCacheCapacity(file, job);
      if (signal.aborted) throw signal.reason ?? new Error('云盘缓存已取消');
      resetIdleTimer();
      const response = await this.openFile(file.id, { signal: AbortSignal.any([signal, idleController.signal]) });
      if (!response.ok || !response.body) throw new CloudSourceError('cloud_download_failed', `云盘下载返回 HTTP ${response.status}`, 502);
      const maximumBytes = file.size || (this.config.cloudCacheBytes ?? 50 * 1024 ** 3);
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          const next = job.progressBytes + chunk.length;
          if (next > maximumBytes) {
            callback(new CloudSourceError('cloud_download_exceeds_reservation', '云盘实际下载大小超过预留空间，已停止缓存。', 507));
            return;
          }
          job.progressBytes = next;
          resetIdleTimer();
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(temporary, { flags: 'w', mode: 0o600 }));
      const downloaded = await stat(temporary);
      if (file.size && downloaded.size !== file.size) throw new Error(`云盘文件大小不一致：预期 ${file.size}，实际 ${downloaded.size}`);
      await rename(temporary, job.path);
      job.progressBytes = downloaded.size;
      job.totalBytes = downloaded.size;
      job.state = 'ready';
      job.lastAccessAt = Date.now();
      this.cacheRecords.set(job.path, {
        sourceId: file.sourceId,
        remoteFileId: file.id,
        fileName: path.basename(job.path),
        size: downloaded.size,
        lastAccessAt: job.lastAccessAt,
      });
      await this.saveCacheManifest();
      await this.pruneCloudCache(job.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (idleTimedOut) error = new CloudSourceError('cloud_download_stalled', '云盘下载连续一分钟没有收到新数据，已停止本次缓存。', 504);
      job.state = 'failed';
      job.failedAt = Date.now();
      job.error = error instanceof Error ? error.message : String(error);
      if (error instanceof CloudSourceError) {
        job.errorCode = error.code;
        job.errorStatus = error.status;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  private pruneCloudCache(exclude?: string, targetBytes = this.config.cloudCacheBytes ?? 50 * 1024 ** 3) {
    const operation = this.cachePruneQueue.then(async () => {
      const files = await this.cacheMediaEntries();
      let total = files.reduce((sum, file) => sum + file.size, 0);
      const ordered = files.filter((file) => !file.part).sort((a, b) => {
        const aAccess = this.cacheRecords.get(a.target)?.lastAccessAt ?? a.modifiedAt;
        const bAccess = this.cacheRecords.get(b.target)?.lastAccessAt ?? b.modifiedAt;
        return aAccess - bAccess;
      });
      for (const file of ordered) {
        if (total <= targetBytes) break;
        const job = [...this.cacheJobs.values()].find((candidate) => candidate.path === file.target);
        const recentlyRequested = Boolean(job?.state === 'ready' && Date.now() - job.lastAccessAt < 30_000);
        if (file.target === exclude || (this.cacheLeases.get(file.target) ?? 0) > 0 || recentlyRequested
          || job?.state === 'queued' || job?.state === 'downloading') continue;
        await rm(file.target, { force: true });
        this.localizedMetadata.delete(file.target);
        this.cacheRecords.delete(file.target);
        if (job) this.cacheJobs.delete(job.remoteFileId);
        total -= file.size;
      }
      await this.saveCacheManifest();
    });
    this.cachePruneQueue = operation.catch(() => undefined);
    return operation;
  }

  acquireCacheLease(filePath: string) {
    const target = path.resolve(filePath);
    if (!this.cachePathFor(path.basename(target)) || path.dirname(target) !== path.resolve(this.cacheRoot)) {
      throw new CloudSourceError('cloud_cache_path_invalid', '云缓存路径无效。', 500);
    }
    this.cacheLeases.set(target, (this.cacheLeases.get(target) ?? 0) + 1);
    const job = [...this.cacheJobs.values()].find((candidate) => candidate.path === target);
    if (job) job.lastAccessAt = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.cacheLeases.get(target) ?? 1) - 1;
      if (remaining > 0) this.cacheLeases.set(target, remaining);
      else this.cacheLeases.delete(target);
    };
  }

  private probeLocalizedMedia(filePath: string) {
    const known = this.localizedMetadata.get(filePath);
    if (known) return known;
    const operation = (async (): Promise<Partial<MediaItem>> => {
      const { stdout } = await execFileAsync(this.config.ffprobePath, [
        '-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath,
      ], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const probe = JSON.parse(stdout) as {
        format?: { duration?: string; format_name?: string };
        streams?: Array<{
          codec_type?: string; codec_name?: string; profile?: string; level?: number; pix_fmt?: string;
          sample_aspect_ratio?: string; width?: number; height?: number; avg_frame_rate?: string;
        }>;
      };
      const video = probe.streams?.find((stream) => stream.codec_type === 'video');
      const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
      const [numerator, denominator = 1] = (video?.avg_frame_rate || '').split('/').map(Number);
      const frameRate = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
        ? Math.round(numerator / denominator * 1000) / 1000
        : undefined;
      return {
        duration: Number(probe.format?.duration || 0),
        width: video?.width,
        height: video?.height,
        frameRate,
        videoCodec: video?.codec_name,
        videoProfile: video?.profile,
        videoLevel: video?.level,
        pixelFormat: video?.pix_fmt,
        sampleAspectRatio: video?.sample_aspect_ratio,
        audioCodec: audio?.codec_name,
        container: probe.format?.format_name,
      };
    })();
    this.localizedMetadata.set(filePath, operation);
    return operation;
  }

  async localizedItem(item: MediaItem, job: CloudCacheJob): Promise<MediaItem> {
    if (job.state !== 'ready') throw new CloudSourceError('cloud_cache_not_ready', job.error || '云盘文件仍在缓存。', 202);
    job.lastAccessAt = Date.now();
    const record = this.cacheRecords.get(job.path);
    if (record) {
      record.lastAccessAt = job.lastAccessAt;
      void this.saveCacheManifest();
    }
    try {
      // Mutate only probed media metadata on the library item. Its public path
      // remains opaque, while later HLS segment requests compute the same cache
      // key as the index request that started FFmpeg.
      Object.assign(item, await this.probeLocalizedMedia(job.path));
    } catch {
      // FFmpeg will report a precise compatibility error if the cached object is
      // not actually probeable media. Basic Range playback can still be useful.
    }
    return { ...item, path: job.path };
  }

  shutdown() {
    this.pendingBaidu.clear();
    for (const controller of this.cacheControllers.values()) controller.abort();
    this.cacheControllers.clear();
    this.downloadQueue.length = 0;
    this.cacheLeases.clear();
    this.localizedMetadata.clear();
  }
}
