import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import acme from 'acme-client';
import { getDefaultDataDir, getLanAddresses } from '../server/config';

interface CloudflareResult<T> {
  success: boolean;
  errors: Array<{ message: string }>;
  result: T;
}

interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};

const baseDomain = required('LOCALIS_BASE_DOMAIN').toLowerCase();
const zoneId = required('CLOUDFLARE_ZONE_ID');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const email = required('ACME_EMAIL');
if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(baseDomain)) throw new Error('LOCALIS_BASE_DOMAIN 不是有效的公共 DNS 域名');

const dataDir = path.resolve(process.env.LOCALIS_DATA_DIR || getDefaultDataDir());
const tlsDir = path.join(dataDir, 'tls');
const accountKeyPath = path.join(dataDir, 'acme-account.key');
const serverIdPath = path.join(dataDir, 'server-id');
const privateKeyPath = path.join(tlsDir, 'private.key');
const certificatePath = path.join(tlsDir, 'fullchain.pem');
const configPath = path.join(dataDir, 'config.json');
await mkdir(tlsDir, { recursive: true });

async function readOrCreate(filePath: string, create: () => Promise<Buffer> | Buffer) {
  try { return await readFile(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = await create();
    try {
      await writeFile(filePath, value, { mode: 0o600, flag: 'wx' });
      return value;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      return readFile(filePath);
    }
  }
}

async function writeAtomic(filePath: string, value: string | Buffer) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.part`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function cloudflare<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${endpoint}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json() as CloudflareResult<T>;
  if (!response.ok || !body.success) throw new Error(body.errors?.map((error) => error.message).join('; ') || `Cloudflare HTTP ${response.status}`);
  return body.result;
}

async function upsertRecord(type: 'A' | 'TXT', name: string, content: string, ttl = 60) {
  const existing = await cloudflare<DnsRecord[]>(`/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
  const payload = JSON.stringify({ type, name, content, ttl, proxied: false });
  if (existing[0]) {
    return cloudflare<DnsRecord>(`/dns_records/${existing[0].id}`, { method: 'PUT', body: payload });
  }
  return cloudflare<DnsRecord>('/dns_records', { method: 'POST', body: payload });
}

async function deleteRecord(id: string) {
  await cloudflare(`/dns_records/${id}`, { method: 'DELETE' });
}

async function waitForTxt(name: string, content: string) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { Accept: 'application/dns-json' },
      });
      const body = await response.json() as { Answer?: Array<{ data: string }> };
      if (body.Answer?.some((answer) => answer.data.replace(/^"|"$/g, '') === content)) return;
    } catch {
      // DNS propagation is retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`DNS TXT 在 120 秒内未传播：${name}`);
}

const lanIp = process.env.LOCALIS_LAN_IP || getLanAddresses()[0];
if (!lanIp || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lanIp)) throw new Error('没有找到 RFC1918 局域网 IPv4；可通过 LOCALIS_LAN_IP 指定');
const serverId = (await readOrCreate(serverIdPath, () => Buffer.from(randomBytes(16).toString('hex')))).toString('utf8').trim();
if (!/^[a-f0-9]{32}$/.test(serverId)) throw new Error(`server-id 文件损坏：${serverIdPath}`);
const serverBase = `${serverId}.${baseDomain}`;
const publicHostname = `${lanIp.replaceAll('.', '-')}.${serverBase}`;
await upsertRecord('A', publicHostname, lanIp);
console.log(`局域网 DNS：${publicHostname} → ${lanIp}`);

let certificateReusable = false;
const stagingRequested = process.env.LOCALIS_ACME_STAGING === '1';
try {
  const certificate = new X509Certificate(await readFile(certificatePath));
  const privateKey = await readFile(privateKeyPath);
  const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privatePublicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' });
  const stagingCertificate = /fake|staging/i.test(certificate.issuer);
  certificateReusable = Date.parse(certificate.validFrom) <= Date.now()
    && Date.parse(certificate.validTo) - Date.now() > 30 * 24 * 60 * 60_000
    && Boolean(certificate.checkHost(publicHostname))
    && certificateKey.equals(privatePublicKey)
    && stagingCertificate === stagingRequested;
} catch {
  // A new certificate is issued below.
}

if (!certificateReusable) {
  const accountKey = await readOrCreate(accountKeyPath, () => acme.crypto.createPrivateEcdsaKey());
  const certificateKey = await readOrCreate(privateKeyPath, () => acme.crypto.createPrivateEcdsaKey());
  const [, csr] = await acme.crypto.createCsr({ altNames: [`*.${serverBase}`] }, certificateKey);
  const directoryUrl = stagingRequested
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;
  const client = new acme.Client({ directoryUrl, accountKey });
  const challengeRecords = new Map<string, string>();
  console.log(`正在申请 ${stagingRequested ? '测试' : '正式'}通配符证书…`);
  const certificate = await client.auto({
    csr,
    email,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    challengeCreateFn: async (authorization, challenge, keyAuthorization) => {
      if (challenge.type !== 'dns-01') throw new Error(`不支持的 ACME challenge：${challenge.type}`);
      const challengeName = `_acme-challenge.${authorization.identifier.value.replace(/^\*\./, '')}`;
      const record = await upsertRecord('TXT', challengeName, keyAuthorization, 60);
      challengeRecords.set(challenge.url || challenge.token, record.id);
      await waitForTxt(challengeName, keyAuthorization);
    },
    challengeRemoveFn: async (_authorization, challenge) => {
      const id = challengeRecords.get(challenge.url || challenge.token);
      if (id) await deleteRecord(id);
    },
  });
  await writeAtomic(certificatePath, certificate);
  console.log(`证书已保存：${certificatePath}`);
} else {
  console.log('现有证书仍有超过 30 天有效期，仅刷新局域网 DNS。');
}

let stored: Record<string, unknown> = {};
try { stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>; } catch { /* first run */ }
await writeFile(configPath, JSON.stringify({ ...stored, publicHostname }, null, 2));
const localisPort = Number(process.env.LOCALIS_PORT || 8080);
console.log(`\n完成。重启 Localis 后，在 Vision Pro Safari 访问：\nhttps://${publicHostname}:${localisPort}\n`);
console.log('证书私钥仅保存在本机；媒体流直接连接局域网 IP，不经过 Cloudflare 代理。');
