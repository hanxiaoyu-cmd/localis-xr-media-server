import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingAuth } from '../server/auth';
import type { LocalisConfig } from '../server/types';

const directories: string[] = [];

async function createPairingApp() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localis-auth-'));
  directories.push(dataDir);
  const config: LocalisConfig = {
    projectRoot: process.cwd(), dataDir, cacheDir: path.join(dataDir, 'cache'), mediaDirs: [],
    port: 0, host: '127.0.0.1', authDisabled: false, pairingCode: '246810',
    allowedHosts: ['localhost', '127.0.0.1'], ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', maxTranscodes: 1,
  };
  const auth = new PairingAuth(config);
  await auth.initialize();
  const app = express();
  app.use(express.json());
  app.post('/pair', (req, res) => auth.verify(req, res));
  app.get('/private', auth.middleware, (_req, res) => res.json({ ok: true }));
  return app;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('pairing authentication', () => {
  it('issues a signed HttpOnly SameSite cookie and rejects tampering', async () => {
    const app = await createPairingApp();
    await request(app).post('/pair').send({ code: '000000' }).expect(401);
    const paired = await request(app).post('/pair').send({ code: '246810' }).expect(200);
    const cookie = paired.headers['set-cookie'][0] as string;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    await request(app).get('/private').set('Cookie', cookie).expect(200, { ok: true });
    await request(app).get('/private').set('Cookie', 'localis_session=%').expect(401);
    const [cookiePair] = cookie.split(';');
    const separator = cookiePair.indexOf('=');
    const token = cookiePair.slice(separator + 1);
    const [payload, signature] = token.split('.');
    const replacement = signature.endsWith('x') ? 'y' : 'x';
    const tampered = `${cookiePair.slice(0, separator + 1)}${payload}.${signature.slice(0, -1)}${replacement}`;
    await request(app).get('/private').set('Cookie', tampered).expect(401);
  });

  it('rate limits repeated pairing guesses', async () => {
    const app = await createPairingApp();
    for (let attempt = 0; attempt < 5; attempt += 1) await request(app).post('/pair').send({ code: '111111' }).expect(401);
    const limited = await request(app).post('/pair').send({ code: '111111' }).expect(429);
    expect(limited.body.retryAfter).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  it('refuses to start with an empty or corrupt persisted HMAC secret', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localis-invalid-secret-'));
    directories.push(dataDir);
    await writeFile(path.join(dataDir, 'server-secret'), '');
    const config: LocalisConfig = {
      projectRoot: process.cwd(), dataDir, cacheDir: path.join(dataDir, 'cache'), mediaDirs: [],
      port: 0, host: '127.0.0.1', authDisabled: false, pairingCode: '246810',
      allowedHosts: ['localhost'], ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', maxTranscodes: 1,
    };
    await expect(new PairingAuth(config).initialize()).rejects.toThrow(/会话密钥无效/);
  });
});
