import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import httpProxy from 'http-proxy';
import { createApiApp } from './app';
import { PairingAuth } from './auth';
import { getLanAddresses, loadConfig } from './config';
import { MediaLibrary } from './media-library';
import { ProgressStore } from './progress-store';
import { TranscodeManager } from './transcode-manager';
import { CloudSourceManager } from './cloud-source-manager';

function requestHostname(request: IncomingMessage) {
  try {
    return new URL(`http://${request.headers.host || ''}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

function hostAllowed(request: IncomingMessage, allowedHosts: string[]) {
  const hostname = requestHostname(request);
  return Boolean(hostname && allowedHosts.some((entry) => entry.toLowerCase() === hostname));
}

async function loadTls(config: Awaited<ReturnType<typeof loadConfig>>) {
  const configured = Boolean(config.publicHostname || config.tlsCertPath || config.tlsKeyPath);
  if (!configured) return undefined;
  if (!config.tlsCertPath || !config.tlsKeyPath) throw new Error('已配置可信域名或 TLS 文件，但证书链/私钥不完整；拒绝降级为 HTTP。');
  const [cert, key] = await Promise.all([readFile(config.tlsCertPath), readFile(config.tlsKeyPath)]);
  const certificate = new X509Certificate(cert);
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error('TLS 证书尚未生效或已经过期。');
  if (config.publicHostname && !certificate.checkHost(config.publicHostname)) throw new Error(`TLS 证书不覆盖 ${config.publicHostname}`);
  if (/fake|staging/i.test(certificate.issuer) && process.env.LOCALIS_ALLOW_STAGING_CERT !== '1') {
    throw new Error('检测到 ACME staging 证书；正式启动前请申请生产证书，或仅测试时设置 LOCALIS_ALLOW_STAGING_CERT=1。');
  }
  const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privatePublicKey = createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' });
  if (!certificateKey.equals(privatePublicKey)) throw new Error('TLS 证书与私钥不匹配。');
  return { cert, key };
}

async function main() {
  const config = await loadConfig();
  const clouds = new CloudSourceManager(config);
  const library = new MediaLibrary(config, clouds);
  const auth = new PairingAuth(config);
  const progress = new ProgressStore(config);
  const transcodes = new TranscodeManager(config);
  await Promise.all([auth.initialize(), progress.initialize(), transcodes.initialize(), clouds.initialize()]);
  await library.initialize();

  const api = createApiApp({ config, library, auth, progress, transcodes, clouds });
  const proxy = httpProxy.createProxyServer({ target: config.frontendOrigin, ws: true, changeOrigin: false });
  proxy.on('proxyRes', (proxyResponse) => {
    Object.assign(proxyResponse.headers, {
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
  });
  proxy.on('error', (_error, _req, response) => {
    if ('writeHead' in response && !response.destroyed && !response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
      response.end('Localis 界面正在启动，请稍后刷新。');
    } else if (!response.destroyed) {
      response.destroy();
    }
  });

  const listener: RequestListener = (request, response) => {
    if (!hostAllowed(request, config.allowedHosts)) {
      response.writeHead(421, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{"error":"unrecognized_host"}');
      return;
    }
    if (request.url?.startsWith('/api/')) api(request, response);
    else proxy.web(request, response);
  };

  const tls = await loadTls(config);
  const tlsEnabled = Boolean(tls);
  const server = tls
    ? createHttpsServer(tls, listener)
    : createHttpServer(listener);
  server.on('connection', (socket) => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error.code || '')) console.warn('[Localis] 客户端连接错误', error.message);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (request, socket, head) => {
    const expectedOrigin = `${tlsEnabled ? 'https' : 'http'}://${request.headers.host}`;
    let originMatches = false;
    try { originMatches = Boolean(request.headers.origin && new URL(request.headers.origin).origin === new URL(expectedOrigin).origin); } catch { /* rejected below */ }
    if (!hostAllowed(request, config.allowedHosts) || !originMatches) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    proxy.ws(request, socket, head);
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  server.listen(config.port, config.host, () => {
    const protocol = tlsEnabled ? 'https' : 'http';
    const urls = tlsEnabled
      ? config.publicHostname ? [`https://${config.publicHostname}:${config.port}`] : []
      : getLanAddresses().map((address) => `${protocol}://${address}:${config.port}`);
    console.log('\nLocalis 已启动');
    console.log(`电脑：${protocol}://localhost:${config.port}`);
    for (const url of urls) console.log(`头显：${url}`);
    if (config.publicHostname) console.log(`可信地址：https://${config.publicHostname}:${config.port}`);
    if (tlsEnabled && !config.publicHostname) console.log('提示：TLS 已启用，但未配置证书覆盖的 LOCALIS_PUBLIC_HOSTNAME，因此不显示会产生证书错误的裸 IP 地址。');
    if (!config.authDisabled) console.log(`配对码：${config.pairingCode}（本次启动有效）`);
    if (!tlsEnabled) console.log('提示：局域网 WebXR 需要配置受信任的 HTTPS 证书；localhost 桌面测试可使用 HTTP。');
    console.log(`媒体：${library.items.size} 项；转码器：${transcodes.encoder}\n`);
  });

  const shutdown = () => {
    transcodes.shutdown();
    clouds.shutdown();
    proxy.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[Localis] 启动失败', error);
  process.exitCode = 1;
});
