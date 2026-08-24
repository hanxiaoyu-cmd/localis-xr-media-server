/* eslint-disable @typescript-eslint/no-require-imports -- Electron loads the main process from CommonJS. */
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

process.env.ELECTRON_ENABLE_SECURITY_WARNINGS = 'true';
app.setName('Localis');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow;
let quitting = false;
const children = [];
const frontendPort = Number(process.env.LOCALIS_FRONTEND_PORT || 3210);
const localisPort = Number(process.env.LOCALIS_PORT || 8080);
const localUrl = `http://localhost:${localisPort}`;

function rootDir() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function executablePath(value) {
  return value.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function logPath() {
  const directory = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'localis-desktop.log');
}

function appendLog(source, chunk) {
  const value = String(chunk).trimEnd();
  if (!value) return;
  const lines = value.split(/\r?\n/).map((line) => `${new Date().toISOString()} [${source}] ${line}\n`).join('');
  fs.appendFileSync(logPath(), lines, 'utf8');
}

function spawnNode(name, entry, environment = {}) {
  const aiRoot = path.join(rootDir(), 'desktop', 'vendor', 'realesrgan');
  const child = spawn(process.execPath, [entry], {
    cwd: rootDir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LOCALIS_DESKTOP: '1',
      LOCALIS_FRONTEND_PORT: String(frontendPort),
      LOCALIS_FRONTEND_ORIGIN: `http://127.0.0.1:${frontendPort}`,
      LOCALIS_PORT: String(localisPort),
      FFMPEG_PATH: executablePath(ffmpegStatic),
      FFPROBE_PATH: executablePath(ffprobeStatic.path),
      LOCALIS_AI_SR_PATH: path.join(aiRoot, 'realesrgan-ncnn-vulkan.exe'),
      LOCALIS_AI_SR_MODELS_PATH: path.join(aiRoot, 'models'),
      ...environment,
    },
  });
  child.stdout.on('data', (chunk) => appendLog(name, chunk));
  child.stderr.on('data', (chunk) => appendLog(name, chunk));
  child.on('exit', (code, signal) => appendLog(name, `进程退出：code=${code ?? 'null'} signal=${signal ?? 'none'}`));
  child.on('error', (error) => appendLog(name, `无法启动：${error.message}`));
  children.push({ name, child });
  return child;
}

function stopChildren() {
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}

function loadingHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Localis</title><style>
    :root{color-scheme:dark;font-family:"Segoe UI Variable",Segoe UI,sans-serif;background:#080a0b;color:#f4f2ee}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,#1b2418 0,#0c0f0d 30%,#080a0b 70%)}
    main{text-align:center;width:min(520px,86vw)}.mark{width:78px;height:78px;margin:auto;border:1px solid #65705e;border-radius:25px;display:grid;place-items:center;box-shadow:0 22px 90px #a8ff4d28,inset 0 0 30px #ffffff0a;background:linear-gradient(145deg,#1d211e,#0a0c0b)}
    .mark:after{content:"";width:28px;height:28px;border:8px solid #b8ff5c;border-radius:50%;box-shadow:0 0 28px #b8ff5c88}
    h1{font-size:42px;letter-spacing:-1.8px;margin:24px 0 8px}p{color:#969c96;margin:0}.line{height:2px;margin:34px auto 0;width:220px;overflow:hidden;background:#252b27;border-radius:4px}
    .line:after{content:"";display:block;width:44%;height:100%;background:#b8ff5c;box-shadow:0 0 14px #b8ff5c;animation:move 1.35s ease-in-out infinite}@keyframes move{0%{transform:translateX(-110%)}100%{transform:translateX(340%)}}
  </style><main><div class="mark"></div><h1>Localis</h1><p>正在准备你的私人媒体空间…</p><div class="line"></div></main>`;
}

function errorHtml(message) {
  const safe = String(message).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return `<!doctype html><meta charset="utf-8"><title>Localis 启动失败</title><style>body{color-scheme:dark;margin:0;background:#080a0b;color:#f4f2ee;font-family:"Segoe UI Variable",Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:620px;padding:48px}i{display:block;width:12px;height:12px;border-radius:50%;background:#ff695f;box-shadow:0 0 18px #ff695f;margin-bottom:22px}h1{font-size:36px;margin:0 0 12px}p{color:#aeb4ae;line-height:1.7}code{display:block;background:#111512;border:1px solid #293029;border-radius:14px;padding:16px;color:#d8ddd8;word-break:break-word}</style><main><i></i><h1>Localis 没能启动</h1><p>请确认 8080 和 3210 端口没有被其他程序占用。详细日志保存在：</p><code>${safe}</code></main>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#080a0b',
    title: 'Localis — 私人空间媒体库',
    icon: path.join(rootDir(), 'desktop', 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      if (target.origin !== new URL(localUrl).origin && target.protocol !== 'data:') {
        event.preventDefault();
        if (/^https?:$/i.test(target.protocol)) void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

async function waitForReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '服务尚未响应';
  while (Date.now() < deadline) {
    const failed = children.find(({ child }) => child.exitCode !== null);
    if (failed) throw new Error(`${failed.name} 进程提前退出（${failed.child.exitCode}）`);
    try {
      const health = await fetch(`${localUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const page = await fetch(localUrl, { signal: AbortSignal.timeout(4_000) });
      if (health.ok && page.ok && page.status !== 502) return await health.json();
      lastError = `服务状态 ${health.status}/${page.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(lastError);
}

async function startLocalis() {
  const root = rootDir();
  spawnNode('web', path.join(root, 'desktop', 'frontend-server.mjs'));
  spawnNode('server', path.join(root, 'desktop', 'build', 'server.mjs'));
  const health = await waitForReady();
  appendLog('desktop', `Localis 就绪：${JSON.stringify(health)}`);
  process.stdout.write(`LOCALIS_DESKTOP_READY ${localUrl}\n`);
  if (process.env.LOCALIS_HEADLESS !== '1') await mainWindow.loadURL(localUrl);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
});

app.on('before-quit', () => {
  quitting = true;
  stopChildren();
});

app.on('window-all-closed', () => {
  if (!quitting && process.env.LOCALIS_HEADLESS !== '1') app.quit();
});

app.whenReady().then(async () => {
  if (process.env.LOCALIS_HEADLESS !== '1') createWindow();
  try {
    await startLocalis();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog('desktop', `启动失败：${message}`);
    if (mainWindow) await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml(logPath()))}`);
    else {
      process.stderr.write(`LOCALIS_DESKTOP_ERROR ${message}\n`);
      app.exit(1);
    }
  }
}).catch((error) => {
  void dialog.showErrorBox('Localis 启动失败', error instanceof Error ? error.message : String(error));
  app.exit(1);
});
