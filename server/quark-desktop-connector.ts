import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { LocalisConfig } from './types';

const OFFICIAL_REPOSITORY = 'https://github.com/quark-clouddrive/quarkclouddrive_offical.git';
const SEARCH_RESULT_TTL_MS = 30 * 60_000;
const MINIMUM_CLI_VERSION = [1, 0, 14] as const;
const SEARCH_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const SEARCH_ARTIFACT_MAX_LINES = 3_000;
const DOWNLOAD_DISK_RESERVE_BYTES = 512 * 1024 ** 2;
const mediaExtensions = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.vob', '.3gp', '.3g2', '.mxf', '.ogv', '.divx', '.f4v', '.asf', '.rm', '.rmvb',
  '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.alac', '.wav', '.ogg', '.opus', '.ape', '.wma',
  '.mka', '.aiff', '.aif', '.ac3', '.eac3', '.dts', '.mp2', '.amr',
]);
const audioExtensions = new Set([
  '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.alac', '.wav', '.ogg', '.opus', '.ape', '.wma',
  '.mka', '.aiff', '.aif', '.ac3', '.eac3', '.dts', '.mp2', '.amr',
]);

type QuarkAccountState = 'unknown' | 'authorizing' | 'authenticated' | 'unauthenticated' | 'error';
type OperationKind = 'install' | 'login';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
  onStdoutLine?: (line: string) => void;
}

interface RunCliOptions {
  env?: Partial<NodeJS.ProcessEnv>;
  onMessage?: (message: OfficialMessage) => void;
}

export type QuarkCommandExecutor = (file: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

interface QuarkDesktopConnectorOptions {
  execute?: QuarkCommandExecutor;
  repositoryUrl?: string;
  companionRoot?: string;
  bashPath?: string;
  onImported?: () => Promise<void>;
}

interface OfficialMessage {
  code?: number;
  msg?: string;
  action?: string;
  type?: string;
  data?: Record<string, unknown>;
}

interface PrivateSearchResult {
  id: string;
  fid: string;
  fileName: string;
  size: number;
  modifiedAt: string;
  type: 'video' | 'audio';
  expiresAt: number;
}

export interface QuarkSearchResultView {
  id: string;
  fileName: string;
  size: number;
  modifiedAt: string;
  type: 'video' | 'audio';
}

export interface QuarkSearchResponse {
  total: number;
  results: QuarkSearchResultView[];
  checkAllUrl?: string;
}

export interface QuarkDownloadJobView {
  id: string;
  resultId: string;
  fileName: string;
  state: 'queued' | 'downloading' | 'importing' | 'ready' | 'failed' | 'cancelled';
  progressBytes: number;
  totalBytes: number;
  message?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

interface MutableDownloadJob extends QuarkDownloadJobView {
  controller: AbortController;
}

export interface QuarkConnectorStatus {
  official: true;
  installed: boolean;
  version?: string;
  runtime: 'native' | 'native-compatibility';
  officiallySupportedRuntime: boolean;
  runtimeNotice?: string;
  operation?: {
    kind: OperationKind;
    state: 'running' | 'succeeded' | 'failed';
    message?: string;
    startedAt: string;
    finishedAt?: string;
  };
  accountState: QuarkAccountState;
  accountMessage?: string;
  authorizationUrl?: string;
  needsManualToken?: boolean;
}

export class QuarkConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly authorizationUrl?: string,
  ) {
    super(message);
  }
}

function defaultExecutor(file: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captureLimit = Math.max(64 * 1024, options.maxBuffer ?? 16 * 1024 * 1024);
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let settled = false;
    let timedOut = false;
    const appendTail = (current: string, chunk: string) => {
      const combined = current + chunk;
      return combined.length > captureLimit ? combined.slice(-captureLimit) : combined;
    };
    const emitLines = (chunk: string, flush = false) => {
      if (!options.onStdoutLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = flush ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (line.length <= 2 * 1024 * 1024) options.onStdoutLine(line);
      }
      if (lineBuffer.length > 2 * 1024 * 1024) lineBuffer = '';
      if (flush && lineBuffer) options.onStdoutLine(lineBuffer);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendTail(stdout, chunk);
      emitLines(chunk);
    });
    child.stderr.on('data', (chunk: string) => { stderr = appendTail(stderr, chunk); });
    const abort = () => { if (!child.killed) child.kill(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs)
      : undefined;
    timer?.unref();
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      emitLines('', true);
      resolve({
        stdout,
        stderr: timedOut ? appendTail(stderr, '\n命令执行超时。') : stderr,
        exitCode,
      });
    };
    child.once('error', (error) => finish(typeof (error as NodeJS.ErrnoException).code === 'number'
      ? Number((error as unknown as { code: number }).code)
      : 1));
    child.once('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

function parseOfficialLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || trimmed.length > 2 * 1024 * 1024) return undefined;
  try {
    const value = JSON.parse(trimmed) as OfficialMessage;
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseNdjson(output: string) {
  return output.split(/\r?\n/).map(parseOfficialLine).filter((value): value is OfficialMessage => Boolean(value));
}

function finalResult(messages: OfficialMessage[]) {
  return [...messages].reverse().find((entry) => entry.type === 'result' && typeof entry.code === 'number');
}

function cleanMessage(value: unknown, fallback: string) {
  const text = typeof value === 'string'
    ? value
      .replace(/[\0-\x1f\x7f]/g, ' ')
      .replace(/((?:(?:access|refresh)[_-]?token|cookie|secret|authorization)\s*[:=]\s*)\S+/gi, '$1[redacted]')
      .trim()
    : '';
  return (text || fallback).slice(0, 300);
}

function connectorErrorMessage(error: unknown, fallback: string) {
  return error instanceof QuarkConnectorError ? cleanMessage(error.message, fallback) : fallback;
}

function officialUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'quark.cn' || host.endsWith('.quark.cn'))) return undefined;
    if ([...url.searchParams.keys()].some((key) => /access[_-]?token|refresh[_-]?token|cookie|secret/i.test(key))) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function firstOfficialUrl(text: string) {
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const safe = officialUrl(match[0]);
    if (safe) return safe;
  }
  return undefined;
}

function field(record: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (record[name] !== undefined && record[name] !== null) return record[name];
  return undefined;
}

function isoDate(value: unknown) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(milliseconds).toISOString();
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(parsed) ? parsed : 0).toISOString();
}

function boundedNonNegativeNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(numeric)));
}

function supportedCliVersion(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  return parts.some((part, index) => part > MINIMUM_CLI_VERSION[index]
    && parts.slice(0, index).every((previous, previousIndex) => previous === MINIMUM_CLI_VERSION[previousIndex]))
    || parts.every((part, index) => part === MINIMUM_CLI_VERSION[index]);
}

function safeFileName(value: string) {
  let result = path.basename(value).replace(/[<>:"/\\|?*\0-\x1f]/g, '_').trim().replace(/[. ]+$/g, '');
  if (!result) result = `quark-${Date.now()}.mp4`;
  const stem = path.basename(result, path.extname(result));
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) result = `_${result}`;
  if (result.length > 180) {
    const extension = path.extname(result).slice(0, 16);
    result = `${path.basename(result, path.extname(result)).slice(0, 160)}${extension}`;
  }
  return result;
}

function isManagedChild(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class QuarkDesktopConnector {
  private readonly execute: QuarkCommandExecutor;
  private readonly repositoryUrl: string;
  private readonly companionRoot: string;
  private readonly repositoryRoot: string;
  private readonly skillRoot: string;
  private readonly cliPath: string;
  private readonly runtimeRoot: string;
  private readonly stagingRoot: string;
  readonly importsRoot: string;
  private readonly bashPath?: string;
  private onImported?: () => Promise<void>;
  private installed = false;
  private cliVersion?: string;
  private cliCompatible = false;
  private accountState: QuarkAccountState = 'unknown';
  private accountMessage?: string;
  private authorizationUrl?: string;
  private needsManualToken = false;
  private operation?: QuarkConnectorStatus['operation'];
  private operationController?: AbortController;
  private readonly searchControllers = new Set<AbortController>();
  private readonly searchResults = new Map<string, PrivateSearchResult>();
  private readonly downloads = new Map<string, MutableDownloadJob>();

  constructor(private readonly config: LocalisConfig, options: QuarkDesktopConnectorOptions = {}) {
    this.execute = options.execute ?? defaultExecutor;
    this.repositoryUrl = options.repositoryUrl ?? OFFICIAL_REPOSITORY;
    this.companionRoot = path.resolve(options.companionRoot ?? path.join(config.dataDir, 'quark-official'));
    this.repositoryRoot = path.join(this.companionRoot, 'repository');
    this.skillRoot = path.join(this.repositoryRoot, 'skills', 'quarkclouddrive');
    this.cliPath = path.join(this.skillRoot, 'scripts', 'quark-drive.cjs');
    this.runtimeRoot = path.join(this.companionRoot, 'runtime');
    this.stagingRoot = path.join(this.companionRoot, 'staging');
    this.importsRoot = path.join(this.companionRoot, 'media');
    this.bashPath = options.bashPath ?? (process.env.LOCALIS_QUARK_BASH?.trim() || undefined);
    this.onImported = options.onImported;
  }

  async initialize() {
    await Promise.all([
      mkdir(this.runtimeRoot, { recursive: true }),
      mkdir(this.stagingRoot, { recursive: true }),
      mkdir(this.importsRoot, { recursive: true }),
    ]);
    if (!this.config.mediaDirs.includes(this.importsRoot)) this.config.mediaDirs.push(this.importsRoot);
    const cliExists = await access(this.cliPath).then(() => true, () => false);
    if (cliExists) {
      try {
        await this.inspectCli();
      } catch (error) {
        this.installed = false;
        this.cliCompatible = false;
        this.accountState = 'error';
        this.accountMessage = error instanceof QuarkConnectorError ? error.message : '夸克官方组件无法验证，请重新安装。';
      }
    } else {
      this.accountState = 'unauthenticated';
    }
    // Only incomplete, job-scoped directories live here. Final media is always
    // atomically moved into importsRoot first.
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      await rm(path.join(this.stagingRoot, entry.name), { recursive: true, force: true });
    }
    for (const entry of await readdir(this.importsRoot, { withFileTypes: true })) {
      if (entry.isFile() && /\.[0-9a-f-]{36}\.part$/i.test(entry.name)) {
        await rm(path.join(this.importsRoot, entry.name), { force: true });
      }
    }
  }

  setOnImported(callback: () => Promise<void>) {
    this.onImported = callback;
  }

  private hasActiveDownload() {
    return [...this.downloads.values()].some((job) => ['queued', 'downloading', 'importing'].includes(job.state));
  }

  private isBusy() {
    return this.operation?.state === 'running' || this.searchControllers.size > 0 || this.hasActiveDownload();
  }

  status(): QuarkConnectorStatus {
    return {
      official: true,
      installed: this.installed,
      version: this.cliVersion,
      runtime: process.platform === 'win32' ? 'native-compatibility' : 'native',
      officiallySupportedRuntime: process.platform !== 'win32',
      runtimeNotice: process.platform === 'win32'
        ? '夸克官方组件仅正式支持 Windows WSL；当前使用 Windows 本机兼容模式，Localis 会在电脑端完成全部操作。'
        : undefined,
      operation: this.operation ? { ...this.operation } : undefined,
      accountState: this.accountState,
      accountMessage: this.accountMessage,
      authorizationUrl: this.authorizationUrl,
      needsManualToken: this.needsManualToken || undefined,
    };
  }

  private async findBash() {
    const candidates = this.bashPath
      ? [this.bashPath]
      : process.platform === 'win32'
        ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'bash.exe']
        : ['bash'];
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) return candidate;
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
    throw new QuarkConnectorError(
      'quark_bash_unavailable',
      process.platform === 'win32'
        ? '未找到 Git for Windows 的 Bash，无法运行夸克官方安装器。请先安装 Git for Windows。'
        : '未找到 Bash，无法运行夸克官方安装器。',
      503,
    );
  }

  private async inspectCli(signal?: AbortSignal) {
    this.installed = false;
    this.cliCompatible = false;
    const result = await this.execute(process.execPath, [this.cliPath, '--version'], {
      cwd: this.skillRoot,
      env: this.cliEnvironment(),
      signal,
      timeoutMs: 15_000,
      maxBuffer: 256 * 1024,
    });
    const version = result.stdout.split(/\s+/).find((value) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value));
    this.cliVersion = version;
    if (result.exitCode !== 0 || !version || !supportedCliVersion(version)) {
      throw new QuarkConnectorError(
        'quark_cli_version_unsupported',
        `夸克官方组件版本不兼容，需要 1.0.14 或更高版本${version ? `（当前 ${version}）` : ''}。`,
        409,
      );
    }
    this.cliCompatible = true;
    this.installed = true;
  }

  private async runChecked(file: string, args: string[], options: CommandOptions, fallback: string) {
    const result = await this.execute(file, args, options);
    if (result.exitCode !== 0) {
      const messages = parseNdjson(result.stdout);
      const terminal = finalResult(messages);
      throw new QuarkConnectorError('quark_command_failed', cleanMessage(terminal?.msg || result.stderr, fallback), 502);
    }
    return result;
  }

  private async installOfficial(signal: AbortSignal, updateRepository: boolean) {
    await mkdir(this.companionRoot, { recursive: true });
    const hasRepository = await access(path.join(this.repositoryRoot, '.git')).then(() => true, () => false);
    if (!hasRepository) {
      const existing = await readdir(this.repositoryRoot).then((entries) => entries.length > 0, () => false);
      if (existing) throw new QuarkConnectorError('quark_companion_directory_invalid', '夸克官方组件目录不完整，请在 Localis 数据目录中移走该目录后重试。', 409);
      await this.runChecked(
        process.env.LOCALIS_QUARK_GIT?.trim() || 'git',
        ['clone', '--depth', '1', '--branch', 'main', this.repositoryUrl, this.repositoryRoot],
        { signal, timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 },
        '无法从夸克官方 GitHub 仓库下载安装组件。',
      );
    } else if (updateRepository) {
      await this.runChecked(
        process.env.LOCALIS_QUARK_GIT?.trim() || 'git',
        ['-C', this.repositoryRoot, 'pull', '--ff-only'],
        { signal, timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 },
        '无法更新夸克官方组件仓库。',
      );
    }
    const installerCandidates = [path.join(this.skillRoot, 'scripts', 'install.sh'), path.join(this.skillRoot, 'install.sh')];
    const installer = (await Promise.all(installerCandidates.map(async (candidate) => ({
      candidate, exists: await access(candidate).then(() => true, () => false),
    })))).find((candidate) => candidate.exists)?.candidate;
    if (!installer) {
      throw new QuarkConnectorError('quark_installer_missing', '夸克官方仓库中没有找到安装器。', 502);
    }
    const bash = await this.findBash();
    await this.runChecked(
      bash,
      [installer.replace(/\\/g, '/')],
      { cwd: this.skillRoot, signal, timeoutMs: 300_000, maxBuffer: 32 * 1024 * 1024 },
      '夸克官方组件安装失败。',
    );
    if (!await access(this.cliPath).then(() => true, () => false)) {
      throw new QuarkConnectorError('quark_cli_missing', '安装器执行完成，但没有找到夸克官方 CLI。', 502);
    }
    await this.inspectCli(signal);
  }

  startInstall() {
    if (this.isBusy()) throw new QuarkConnectorError('quark_operation_busy', '夸克官方组件正在执行另一项操作。', 409);
    const controller = new AbortController();
    this.operationController = controller;
    this.operation = { kind: 'install', state: 'running', message: '正在从夸克官方仓库安装电脑端组件…', startedAt: new Date().toISOString() };
    void this.installOfficial(controller.signal, true).then(() => {
      this.operation = { ...this.operation!, state: 'succeeded', message: '夸克官方组件已安装。', finishedAt: new Date().toISOString() };
      this.accountState = 'unknown';
      this.accountMessage = '请在这台电脑上完成一次浏览器授权。';
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        if (this.operation?.state === 'running') {
          this.operation = { ...this.operation, state: 'failed', message: '官方组件安装已停止。', finishedAt: new Date().toISOString() };
        }
        return;
      }
      this.operation = {
        ...this.operation!, state: 'failed', message: connectorErrorMessage(error, '夸克官方组件安装失败。'), finishedAt: new Date().toISOString(),
      };
    }).finally(() => {
      if (this.operationController === controller) this.operationController = undefined;
    });
    return this.status();
  }

  private async prepareCli(signal: AbortSignal) {
    if (!this.installed || !this.cliCompatible) throw new QuarkConnectorError('quark_companion_not_installed', '请先在电脑上安装或更新夸克官方组件。', 409);
    if (!await access(this.cliPath).then(() => true, () => false)) {
      this.installed = false;
      this.cliCompatible = false;
      throw new QuarkConnectorError('quark_cli_missing', '夸克官方组件文件已丢失，请在电脑端重新安装。', 409);
    }
    if (signal.aborted) throw new QuarkConnectorError('quark_operation_cancelled', '夸克操作已取消。', 499);
  }

  private sessionArgs(input: string) {
    return ['--session-input', input.slice(0, 200), '--session-id', `${Date.now()}-${randomUUID().slice(0, 6)}`];
  }

  private cliEnvironment(extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...extra,
      OPENCLAW_CLI: '1',
      OPENCLAW_RUNTIME_DIR: this.runtimeRoot,
    };
  }

  private async runCli(
    command: string,
    args: string[],
    input: string,
    signal: AbortSignal,
    timeoutMs: number,
    options: RunCliOptions = {},
  ) {
    await this.prepareCli(signal);
    const streamedMessages: OfficialMessage[] = [];
    let streamedAuthorizationUrl: string | undefined;
    const handleLine = (line: string) => {
      const message = parseOfficialLine(line);
      if (message) {
        options.onMessage?.(message);
        if (message.type !== 'progress') {
          streamedMessages.push(message);
          if (streamedMessages.length > 128) streamedMessages.shift();
        }
      }
      if (command === 'login') {
        const authorizationUrl = firstOfficialUrl(line);
        if (authorizationUrl) {
          streamedAuthorizationUrl = authorizationUrl;
          this.authorizationUrl = authorizationUrl;
          this.accountMessage = '请在这台电脑的浏览器完成夸克授权；如浏览器未自动继续，可打开官方授权页面。';
        }
      }
    };
    const result = await this.execute(process.execPath, [this.cliPath, command, ...args, ...this.sessionArgs(input)], {
      cwd: this.skillRoot,
      env: this.cliEnvironment(options.env),
      signal,
      timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      onStdoutLine: handleLine,
    });
    const messages = streamedMessages.length > 0 ? streamedMessages : parseNdjson(result.stdout);
    const terminal = finalResult(messages);
    const alreadyAuthorized = command === 'login' && terminal?.code === -118;
    if ((result.exitCode !== 0 && !alreadyAuthorized) || !terminal || (terminal.code !== 0 && !alreadyAuthorized)) {
      const message = cleanMessage(terminal?.msg || result.stderr, '夸克官方组件执行失败。');
      if (/未授权|认证|token|登录/i.test(message)) this.accountState = 'unauthenticated';
      const authorizationUrl = command === 'login'
        ? streamedAuthorizationUrl ?? firstOfficialUrl(`${result.stdout}\n${result.stderr}`)
        : undefined;
      throw new QuarkConnectorError('quark_official_error', message, /未授权|认证|token|登录/i.test(message) ? 401 : 502, authorizationUrl);
    }
    return { result, messages, terminal };
  }

  startLogin(token?: string) {
    if (!this.installed) throw new QuarkConnectorError('quark_companion_not_installed', '请先在电脑上安装夸克官方组件。', 409);
    if (this.isBusy()) throw new QuarkConnectorError('quark_operation_busy', '夸克官方组件正在执行另一项操作。', 409);
    const normalizedToken = token?.trim();
    if (token !== undefined && !normalizedToken) {
      throw new QuarkConnectorError('invalid_quark_authorization_code', '请输入夸克官方授权流程返回的授权码。');
    }
    if (normalizedToken && (normalizedToken.length > 2_048 || /[\0-\x1f\x7f]/.test(normalizedToken))) {
      throw new QuarkConnectorError('invalid_quark_authorization_code', '夸克授权码格式无效。');
    }
    const controller = new AbortController();
    this.operationController = controller;
    this.accountState = 'authorizing';
    this.accountMessage = normalizedToken ? '正在提交浏览器授权码…' : '已打开这台电脑的浏览器，正在等待夸克授权…';
    this.authorizationUrl = undefined;
    this.needsManualToken = false;
    this.operation = { kind: 'login', state: 'running', message: this.accountMessage, startedAt: new Date().toISOString() };
    const args = normalizedToken ? ['--token', normalizedToken] : [];
    void this.runCli('login', args, '在电脑端登录夸克网盘', controller.signal, 10 * 60_000).then(({ result, terminal }) => {
      this.accountState = 'authenticated';
      this.accountMessage = cleanMessage(terminal.msg, '夸克网盘授权成功。');
      this.operation = { ...this.operation!, state: 'succeeded', message: this.accountMessage, finishedAt: new Date().toISOString() };
      this.authorizationUrl = undefined;
      this.needsManualToken = false;
      void result;
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        if (this.operation?.state === 'running') {
          this.operation = { ...this.operation, state: 'failed', message: '夸克授权已停止。', finishedAt: new Date().toISOString() };
        }
        return;
      }
      const message = connectorErrorMessage(error, '夸克授权失败。');
      this.accountState = 'error';
      this.accountMessage = message;
      this.operation = { ...this.operation!, state: 'failed', message, finishedAt: new Date().toISOString() };
      this.authorizationUrl = error instanceof QuarkConnectorError ? error.authorizationUrl : undefined;
      this.needsManualToken = Boolean(this.authorizationUrl);
    }).finally(() => {
      if (this.operationController === controller) this.operationController = undefined;
    });
    return this.status();
  }

  private pruneSearchResults() {
    for (const [id, result] of this.searchResults) if (result.expiresAt <= Date.now()) this.searchResults.delete(id);
  }

  private async searchArtifactRecords(messages: OfficialMessage[]) {
    const artifact = [...messages].reverse().find((entry) => entry.type === 'artifact' && entry.action === 'search');
    if (!artifact) return undefined;
    const data = artifact.data ?? {};
    const filePath = typeof data.file_path === 'string' ? data.file_path : '';
    const count = Number(data.count);
    if (artifact.code !== 0 || data.format !== 'jsonl' || !path.isAbsolute(filePath)
      || !Number.isInteger(count) || count < 0 || count > SEARCH_ARTIFACT_MAX_LINES) {
      throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果文件格式无效。', 502);
    }
    const artifactRoot = this.skillRoot;
    let rootReal: string;
    let fileReal: string;
    try {
      [rootReal, fileReal] = await Promise.all([realpath(artifactRoot), realpath(filePath)]);
      const [linkInfo, fileInfo] = await Promise.all([lstat(filePath), stat(fileReal)]);
      const relative = path.relative(rootReal, fileReal).replace(/\\/g, '/');
      const artifactName = 'search-\\d{8}-\\d{6}-[0-9a-f]{6}\\.jsonl';
      const expectedLocation = new RegExp(`^(?:[^/]+/search/[^/]+|\\.quarkclouddrive/search/[^/]+)/${artifactName}$`, 'i');
      if (linkInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size > SEARCH_ARTIFACT_MAX_BYTES
        || !isManagedChild(rootReal, fileReal) || !expectedLocation.test(relative)) {
        throw new Error('unsafe artifact');
      }
    } catch {
      throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果文件不在受管目录中。', 502);
    }
    const artifactBytes = await readFile(fileReal);
    if (artifactBytes.byteLength > SEARCH_ARTIFACT_MAX_BYTES) {
      throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果文件过大。', 502);
    }
    const lines = artifactBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== count || lines.length > SEARCH_ARTIFACT_MAX_LINES) {
      throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果文件条数不一致。', 502);
    }
    const records = new Map<string, Record<string, unknown>>();
    for (const line of lines) {
      if (line.length > 256 * 1024) throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果单条记录过大。', 502);
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果无法解析。', 502); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果记录无效。', 502);
      }
      const record = value as Record<string, unknown>;
      const fid = String(field(record, 'fid', 'file_id', 'fileId') ?? '').trim();
      if (!fid || fid.length > 256 || /[\0-\x1f\x7f]/.test(fid) || records.has(fid)) {
        throw new QuarkConnectorError('quark_search_artifact_invalid', '夸克官方搜索结果包含无效文件标识。', 502);
      }
      records.set(fid, record);
    }
    return records;
  }

  async search(keyword: string): Promise<QuarkSearchResponse> {
    const normalized = keyword.trim();
    if (!normalized || [...normalized].length > 50 || /[\0-\x1f\x7f]/.test(normalized)) {
      throw new QuarkConnectorError('invalid_quark_search', '搜索词需为 1 至 50 个字符。');
    }
    if (this.isBusy()) throw new QuarkConnectorError('quark_operation_busy', '请先完成当前夸克操作。', 409);
    this.pruneSearchResults();
    const controller = new AbortController();
    this.searchControllers.add(controller);
    let terminal: OfficialMessage;
    let messages: OfficialMessage[];
    try {
      ({ terminal, messages } = await this.runCli('search', ['--keyword', normalized, '--size', '50'], `在夸克网盘搜索：${normalized}`, controller.signal, 120_000));
    } finally {
      this.searchControllers.delete(controller);
    }
    this.accountState = 'authenticated';
    this.accountMessage = '夸克网盘已授权。';
    const data = terminal.data ?? {};
    const artifactRecords = await this.searchArtifactRecords(messages);
    const previewList = Array.isArray(data.file_list) ? data.file_list : Array.isArray(data.files) ? data.files : [];
    const rawList = artifactRecords ? [...artifactRecords.values()].slice(0, 50) : previewList;
    const results: QuarkSearchResultView[] = [];
    for (const candidate of rawList.slice(0, 100)) {
      if (!candidate || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      const fid = String(field(record, 'fid', 'file_id', 'fileId') ?? '').trim();
      const fileName = String(field(record, 'file_name', 'fileName', 'filename', 'name') ?? '').trim();
      const extension = path.extname(fileName).toLowerCase();
      if (!fid || fid.length > 256 || /[\0-\x1f\x7f]/.test(fid) || !fileName || !mediaExtensions.has(extension)) continue;
      const artifactRecord = artifactRecords?.get(fid);
      if (artifactRecords && !artifactRecord) {
        throw new QuarkConnectorError('quark_search_artifact_mismatch', '夸克官方搜索预览与完整结果不一致。', 502);
      }
      const trustedRecord = artifactRecord ?? record;
      const trustedFileName = String(field(trustedRecord, 'file_name', 'fileName', 'filename', 'name') ?? '').trim();
      const trustedExtension = path.extname(trustedFileName).toLowerCase();
      if (!trustedFileName || !mediaExtensions.has(trustedExtension)) {
        throw new QuarkConnectorError('quark_search_artifact_mismatch', '夸克官方搜索结果中的媒体信息不一致。', 502);
      }
      const privateResult: PrivateSearchResult = {
        id: randomUUID(),
        fid,
        fileName: path.basename(trustedFileName),
        size: boundedNonNegativeNumber(field(trustedRecord, 'size', 'file_size', 'fileSize')),
        modifiedAt: isoDate(field(trustedRecord, 'updated_at', 'update_time', 'modified_at', 'mtime')),
        type: audioExtensions.has(trustedExtension) ? 'audio' : 'video',
        expiresAt: Date.now() + SEARCH_RESULT_TTL_MS,
      };
      this.searchResults.set(privateResult.id, privateResult);
      const { fid: _fid, expiresAt: _expiresAt, ...view } = privateResult;
      results.push(view);
    }
    return {
      total: boundedNonNegativeNumber(data.total, results.length),
      results,
      checkAllUrl: officialUrl(data.check_all_link),
    };
  }

  private async availableTarget(fileName: string) {
    const safe = safeFileName(fileName);
    const extension = path.extname(safe);
    const stem = path.basename(safe, extension);
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const candidate = path.join(this.importsRoot, attempt === 0 ? safe : `${stem} (${attempt})${extension}`);
      if (!await access(candidate).then(() => true, () => false)) return candidate;
    }
    throw new QuarkConnectorError('quark_import_name_exhausted', '电脑资料库中存在过多同名文件。', 409);
  }

  private async stagedMediaFiles(root: string, current = root, depth = 0): Promise<string[]> {
    if (depth > 8) return [];
    const result: string[] = [];
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) result.push(...await this.stagedMediaFiles(root, target, depth + 1));
      else if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) result.push(target);
      if (result.length > 10) break;
    }
    return result;
  }

  private async managedDirectoryBytes(current: string, stopAfter: number, ignoreParts: boolean, depth = 0): Promise<number> {
    if (depth > 8) throw new QuarkConnectorError('quark_managed_tree_too_deep', '电脑端夸克受管目录层级过深。', 507);
    let total = 0;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) total += await this.managedDirectoryBytes(target, Math.max(0, stopAfter - total), ignoreParts, depth + 1);
      else if (entry.isFile() && !(ignoreParts && entry.name.endsWith('.part'))) total += (await stat(target)).size;
      if (!Number.isSafeInteger(total)) throw new QuarkConnectorError('quark_import_quota_exceeded', '电脑端夸克资料库已经超过可统计的容量。', 507);
      if (total > stopAfter) return total;
    }
    return total;
  }

  private importedBytes() {
    return this.managedDirectoryBytes(this.importsRoot, Number.MAX_SAFE_INTEGER, true);
  }

  private async probeMedia(filePath: string, signal: AbortSignal) {
    const result = await this.execute(this.config.ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-show_streams', '-of', 'json', filePath,
    ], { signal, timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024 });
    let streams: unknown[] = [];
    try {
      const probe = JSON.parse(result.stdout) as { streams?: unknown[] };
      streams = Array.isArray(probe.streams) ? probe.streams : [];
    } catch {
      // Handled by the shared invalid-media error below.
    }
    if (result.exitCode !== 0 || !streams.some((stream) => stream && typeof stream === 'object'
      && ['video', 'audio'].includes(String((stream as { codec_type?: unknown }).codec_type)))) {
      throw new QuarkConnectorError('quark_download_not_media', '下载完成的文件不是可读取的音视频，未加入资料库。', 422);
    }
  }

  startDownload(resultId: string) {
    this.pruneSearchResults();
    const selected = this.searchResults.get(resultId);
    if (!selected) throw new QuarkConnectorError('quark_search_result_expired', '搜索结果已过期，请重新搜索。', 404);
    if (this.operation?.state === 'running' || this.searchControllers.size > 0 || this.hasActiveDownload()) {
      throw new QuarkConnectorError('quark_download_busy', '已有一个夸克文件正在下载，请完成后再添加下一个。', 429);
    }
    const limit = this.config.cloudCacheBytes ?? 50 * 1024 ** 3;
    if (selected.size > limit) throw new QuarkConnectorError('quark_file_exceeds_limit', '该文件超过电脑端云盘下载上限。', 507);
    const controller = new AbortController();
    const job: MutableDownloadJob = {
      id: randomUUID(),
      resultId,
      fileName: selected.fileName,
      state: 'queued',
      progressBytes: 0,
      totalBytes: selected.size,
      message: '等待电脑端下载…',
      startedAt: new Date().toISOString(),
      controller,
    };
    this.downloads.set(job.id, job);
    void this.downloadAndImport(selected, job).catch((error: unknown) => {
      const monitoredFailure = error instanceof QuarkConnectorError && [
        'quark_import_quota_exceeded',
        'quark_disk_full',
        'quark_download_size_mismatch',
        'quark_download_monitor_failed',
      ].includes(error.code);
      if (controller.signal.aborted && !monitoredFailure) {
        job.state = 'cancelled';
        job.message = '下载已取消。';
      } else {
        job.state = 'failed';
        job.error = connectorErrorMessage(error, '夸克文件下载失败，请检查电脑磁盘和官方组件状态。');
        job.message = job.error;
      }
      job.finishedAt = new Date().toISOString();
    });
    return this.downloadView(job);
  }

  private async downloadAndImport(selected: PrivateSearchResult, job: MutableDownloadJob) {
    const stage = path.join(this.stagingRoot, job.id);
    const taskTemp = path.join(stage, '.tmp');
    if (!isManagedChild(this.stagingRoot, stage)) throw new QuarkConnectorError('quark_stage_path_invalid', '下载暂存路径无效。', 500);
    if (!isManagedChild(stage, taskTemp)) throw new QuarkConnectorError('quark_stage_path_invalid', '下载临时路径无效。', 500);
    await mkdir(taskTemp, { recursive: true });
    try {
      const limit = this.config.cloudCacheBytes ?? 50 * 1024 ** 3;
      const importedBefore = await this.importedBytes();
      const remainingQuota = limit - importedBefore;
      if (remainingQuota <= 0 || (selected.size > 0 && selected.size > remainingQuota)) {
        throw new QuarkConnectorError('quark_import_quota_exceeded', '电脑端夸克资料库已达到云盘容量上限，请先移走不再需要的文件。', 507);
      }
      const initialDisk = await statfs(stage);
      const initialAvailable = Number(initialDisk.bavail) * Number(initialDisk.bsize);
      if (Number.isFinite(initialAvailable)
        && initialAvailable < (selected.size > 0 ? selected.size : 0) + DOWNLOAD_DISK_RESERVE_BYTES) {
        throw new QuarkConnectorError('quark_disk_full', '电脑磁盘空间不足，无法下载该文件。', 507);
      }
      job.state = 'downloading';
      job.message = '夸克官方组件正在下载到这台电脑…';
      let monitorError: QuarkConnectorError | undefined;
      let activeMonitor: Promise<void> | undefined;
      const stopFor = (error: QuarkConnectorError) => {
        if (monitorError) return;
        monitorError = error;
        job.controller.abort();
      };
      const monitor = () => {
        if (activeMonitor || job.controller.signal.aborted) return activeMonitor;
        activeMonitor = (async () => {
          try {
            const written = await this.managedDirectoryBytes(stage, remainingQuota, false);
            if (written > remainingQuota) {
              stopFor(new QuarkConnectorError('quark_import_quota_exceeded', '夸克下载超过电脑端云盘容量上限，已停止任务。', 507));
              return;
            }
            if (job.totalBytes > 0) job.progressBytes = Math.max(job.progressBytes, Math.min(written, job.totalBytes));
            const disk = await statfs(stage);
            const available = Number(disk.bavail) * Number(disk.bsize);
            if (Number.isFinite(available) && available < DOWNLOAD_DISK_RESERVE_BYTES) {
              stopFor(new QuarkConnectorError('quark_disk_full', '电脑磁盘可用空间低于 512 MiB，已停止下载。', 507));
            }
          } catch (error) {
            stopFor(error instanceof QuarkConnectorError
              ? error
              : new QuarkConnectorError('quark_download_monitor_failed', '无法安全监控夸克下载空间，已停止任务。', 507));
          }
        })().finally(() => { activeMonitor = undefined; });
        return activeMonitor;
      };
      await monitor();
      if (monitorError) throw monitorError;
      const monitorTimer = setInterval(() => { void monitor(); }, 250);
      monitorTimer.unref();
      try {
        await this.runCli(
          'download',
          ['--fid', selected.fid, '--output-dir', stage, '--overwrite'],
          `下载夸克网盘文件：${selected.fileName}`,
          job.controller.signal,
          24 * 60 * 60_000,
          {
            env: { TEMP: taskTemp, TMP: taskTemp, TMPDIR: taskTemp },
            onMessage: (message) => {
              if (message.type !== 'progress') return;
              const current = boundedNonNegativeNumber(message.data?.current);
              const total = boundedNonNegativeNumber(message.data?.total);
              if (total > remainingQuota || (selected.size > 0 && total > 0 && total !== selected.size)) {
                stopFor(new QuarkConnectorError('quark_download_size_mismatch', '夸克返回的下载大小与搜索结果不一致，已停止任务。', 502));
                return;
              }
              if (total > 0) job.totalBytes = total;
              job.progressBytes = Math.min(current, job.totalBytes || remainingQuota);
            },
          },
        );
      } catch (error) {
        if (monitorError) throw monitorError;
        throw error;
      } finally {
        clearInterval(monitorTimer);
        await activeMonitor?.catch(() => undefined);
      }
      if (monitorError) throw monitorError;
      const files = await this.stagedMediaFiles(stage);
      if (files.length !== 1) throw new QuarkConnectorError('quark_download_output_invalid', '夸克官方组件没有返回唯一的音视频文件。', 502);
      const downloaded = files[0];
      const [stageReal, fileReal] = await Promise.all([realpath(stage), realpath(downloaded)]);
      if (!isManagedChild(stageReal, fileReal)) throw new QuarkConnectorError('quark_download_path_invalid', '夸克下载结果超出受管暂存目录。', 502);
      const info = await stat(fileReal);
      if (!info.isFile()) throw new QuarkConnectorError('quark_download_output_invalid', '夸克下载结果不是普通文件。', 502);
      if (info.size > limit) throw new QuarkConnectorError('quark_file_exceeds_limit', '下载文件超过电脑端云盘下载上限，已停止导入。', 507);
      if (selected.size > 0 && info.size !== selected.size) {
        throw new QuarkConnectorError('quark_download_size_mismatch', '下载文件大小与夸克搜索结果不一致，未加入资料库。', 502);
      }
      if (await this.importedBytes() + info.size > limit) {
        throw new QuarkConnectorError('quark_import_quota_exceeded', '电脑端夸克资料库已达到云盘容量上限，未导入该文件。', 507);
      }
      job.progressBytes = info.size;
      job.totalBytes = info.size;
      job.state = 'importing';
      job.message = '正在校验媒体并加入电脑资料库…';
      await this.probeMedia(fileReal, job.controller.signal);
      const target = await this.availableTarget(path.basename(fileReal) || selected.fileName);
      const part = `${target}.${job.id}.part`;
      if (!isManagedChild(this.importsRoot, part)) throw new QuarkConnectorError('quark_import_path_invalid', '资料库导入路径无效。', 500);
      try {
        try {
          await rename(fileReal, part);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          await copyFile(fileReal, part);
          await rm(fileReal, { force: true });
        }
        await link(part, target);
        await rm(part, { force: true });
      } catch (error) {
        await rm(part, { force: true }).catch(() => undefined);
        throw error;
      }
      let refreshFailed = false;
      try {
        await this.onImported?.();
      } catch {
        // The verified file is already atomically committed. A transient library
        // rescan failure must not report the durable download itself as lost.
        refreshFailed = true;
      }
      job.state = 'ready';
      job.message = refreshFailed
        ? '已下载到电脑；资料库刷新暂时失败，请点击刷新媒体。'
        : '已下载到电脑并加入资料库。';
      job.finishedAt = new Date().toISOString();
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private downloadView(job: MutableDownloadJob): QuarkDownloadJobView {
    const { controller: _controller, ...view } = job;
    return { ...view };
  }

  download(id: string) {
    const job = this.downloads.get(id);
    if (!job) throw new QuarkConnectorError('quark_download_not_found', '下载任务不存在或已失效。', 404);
    return this.downloadView(job);
  }

  cancelDownload(id: string) {
    const job = this.downloads.get(id);
    if (!job) throw new QuarkConnectorError('quark_download_not_found', '下载任务不存在或已失效。', 404);
    if (!['ready', 'failed', 'cancelled'].includes(job.state)) job.controller.abort();
    return this.downloadView(job);
  }

  async waitForIdle(timeoutMs = 10_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const operationRunning = this.operation?.state === 'running';
      const downloadRunning = [...this.downloads.values()].some((job) => ['queued', 'downloading', 'importing'].includes(job.state));
      if (!operationRunning && !downloadRunning) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Quark connector did not become idle');
  }

  shutdown() {
    this.operationController?.abort();
    if (this.operation?.state === 'running') {
      this.operation = { ...this.operation, state: 'failed', message: '操作已随 Localis 停止。', finishedAt: new Date().toISOString() };
    }
    for (const controller of this.searchControllers) controller.abort();
    this.searchControllers.clear();
    for (const job of this.downloads.values()) job.controller.abort();
  }
}
