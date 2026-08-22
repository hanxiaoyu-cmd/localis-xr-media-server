import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { LocalisConfig } from './types';

const COOKIE_NAME = 'localis_session';

function parseCookies(value?: string) {
  const result: Record<string, string> = {};
  for (const part of value?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      try {
        result[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1));
      } catch {
        // A malformed cookie is unauthenticated input, not a server error.
      }
    }
  }
  return result;
}

export class PairingAuth {
  private secret = Buffer.alloc(0);
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private globalAttempts = { count: 0, resetAt: 0 };

  constructor(private readonly config: LocalisConfig) {}

  async initialize() {
    const secretPath = path.join(this.config.dataDir, 'server-secret');
    try {
      const decoded = Buffer.from((await readFile(secretPath, 'utf8')).trim(), 'base64url');
      if (decoded.length !== 32) throw new Error(`Localis 会话密钥无效：${secretPath}`);
      this.secret = decoded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.secret = randomBytes(32);
      try {
        await writeFile(secretPath, this.secret.toString('base64url'), { mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        const decoded = Buffer.from((await readFile(secretPath, 'utf8')).trim(), 'base64url');
        if (decoded.length !== 32) throw new Error(`Localis 会话密钥无效：${secretPath}`);
        this.secret = decoded;
      }
    }
  }

  isAuthenticated(req: Request) {
    if (this.config.authDisabled) return true;
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number };
      return decoded.exp > Date.now();
    } catch {
      return false;
    }
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (this.isAuthenticated(req)) return next();
    res.status(401).json({ error: 'pairing_required' });
  };

  verify(req: Request, res: Response) {
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (this.attempts.size > 256) {
      for (const [key, value] of this.attempts) if (value.resetAt <= now) this.attempts.delete(key);
    }
    if (this.globalAttempts.resetAt <= now) this.globalAttempts = { count: 0, resetAt: now + 5 * 60_000 };
    if (this.globalAttempts.count >= 50) {
      const retryAfter = Math.ceil((this.globalAttempts.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'too_many_attempts', retryAfter });
      return;
    }
    const record = this.attempts.get(address);
    if (record && record.resetAt > now && record.count >= 5) {
      res.set('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
      res.status(429).json({ error: 'too_many_attempts', retryAfter: Math.ceil((record.resetAt - now) / 1000) });
      return;
    }
    const nextRecord = record && record.resetAt > now ? record : { count: 0, resetAt: now + 5 * 60_000 };
    nextRecord.count += 1;
    this.attempts.set(address, nextRecord);

    if (String(req.body?.code || '') !== this.config.pairingCode) {
      this.globalAttempts.count += 1;
      res.status(401).json({ error: 'invalid_pairing_code', attemptsRemaining: Math.max(0, 5 - nextRecord.count) });
      return;
    }

    this.attempts.delete(address);
    const payload = Buffer.from(JSON.stringify({ exp: now + 30 * 24 * 60 * 60_000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    res.cookie(COOKIE_NAME, `${payload}.${signature}`, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60_000,
      path: '/',
    });
    res.json({ paired: true });
  }
}
