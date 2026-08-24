import { randomInt } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LocalisConfig } from './types';

interface StoredConfig {
  mediaDirs?: string[];
  publicHostname?: string;
}

const canAccess = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

export function getLanAddresses(): string[] {
  const result = new Set<string>();
  for (const records of Object.values(os.networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.family === 'IPv4' && !record.internal) result.add(record.address);
    }
  }
  return [...result];
}

export function getDefaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Localis');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Localis');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'localis');
}

export async function loadConfig(): Promise<LocalisConfig> {
  const projectRoot = process.cwd();
  const dataDir = path.resolve(process.env.LOCALIS_DATA_DIR || getDefaultDataDir());
  const cacheDir = path.join(dataDir, 'cache');
  const bundledAiRoot = path.join(projectRoot, 'desktop', 'vendor', 'realesrgan');
  const configPath = path.join(dataDir, 'config.json');
  await mkdir(cacheDir, { recursive: true });

  let stored: StoredConfig = {};
  try {
    stored = JSON.parse(await readFile(configPath, 'utf8')) as StoredConfig;
  } catch {
    // First run; a minimal config is persisted below.
  }

  const envDirs = process.env.LOCALIS_MEDIA_DIRS
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const sampleDir = path.join(projectRoot, 'sample-media');
  const mediaDirs = (envDirs?.length ? envDirs : stored.mediaDirs ?? [])
    .map((entry) => path.resolve(entry));
  if (mediaDirs.length === 0 && await canAccess(sampleDir)) mediaDirs.push(sampleDir);

  const publicHostname = process.env.LOCALIS_PUBLIC_HOSTNAME || stored.publicHostname;
  const managedCertPath = path.join(dataDir, 'tls', 'fullchain.pem');
  const managedKeyPath = path.join(dataDir, 'tls', 'private.key');
  const tlsCertPath = process.env.LOCALIS_TLS_CERT || (await canAccess(managedCertPath) ? managedCertPath : undefined);
  const tlsKeyPath = process.env.LOCALIS_TLS_KEY || (await canAccess(managedKeyPath) ? managedKeyPath : undefined);
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...getLanAddresses(),
    ...(process.env.LOCALIS_ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean) ?? []),
    ...(publicHostname ? [publicHostname] : []),
  ]);

  await writeFile(configPath, JSON.stringify({ mediaDirs, publicHostname }, null, 2));

  return {
    projectRoot,
    dataDir,
    cacheDir,
    mediaDirs,
    port: Number(process.env.LOCALIS_PORT || 8080),
    host: process.env.LOCALIS_HOST || '0.0.0.0',
    frontendOrigin: process.env.LOCALIS_FRONTEND_ORIGIN || 'http://127.0.0.1:3210',
    authDisabled: process.env.LOCALIS_AUTH_DISABLED === '1',
    pairingCode: process.env.LOCALIS_PAIR_CODE || String(randomInt(100000, 1000000)),
    tlsCertPath,
    tlsKeyPath,
    publicHostname,
    allowedHosts: [...allowedHosts],
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    aiSuperResolutionPath: process.env.LOCALIS_AI_SR_PATH
      || (process.platform === 'win32' ? path.join(bundledAiRoot, 'realesrgan-ncnn-vulkan.exe') : undefined),
    aiSuperResolutionModelsPath: process.env.LOCALIS_AI_SR_MODELS_PATH
      || (process.platform === 'win32' ? path.join(bundledAiRoot, 'models') : undefined),
    maxTranscodes: Math.max(1, Number(process.env.LOCALIS_MAX_TRANSCODES || 2)),
    maxCacheBytes: Math.max(1, Number(process.env.LOCALIS_CACHE_GB || 20)) * 1024 ** 3,
    cloudCacheBytes: Math.max(1, Number(process.env.LOCALIS_CLOUD_CACHE_GB || 50)) * 1024 ** 3,
    maxCloudDownloads: Math.min(2, Math.max(1, Number(process.env.LOCALIS_MAX_CLOUD_DOWNLOADS || 1))),
    baiduAppKey: process.env.LOCALIS_BAIDU_APP_KEY?.trim() || undefined,
    baiduSecretKey: process.env.LOCALIS_BAIDU_SECRET_KEY?.trim() || undefined,
    baiduAppFolder: process.env.LOCALIS_BAIDU_APP_FOLDER?.trim() || 'Localis',
  };
}

export async function saveMediaDirs(config: LocalisConfig, mediaDirs: string[]) {
  const normalized = [...new Set(mediaDirs.map((entry) => path.resolve(entry)))];
  config.mediaDirs = normalized;
  await writeFile(
    path.join(config.dataDir, 'config.json'),
    JSON.stringify({ mediaDirs: normalized, publicHostname: config.publicHostname }, null, 2),
  );
}
