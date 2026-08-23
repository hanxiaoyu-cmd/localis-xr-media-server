import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cloud login UX', () => {
  it('keeps provider credentials out of the default QR-first interface', async () => {
    const source = await readFile(path.join(process.cwd(), 'app', 'components', 'media-library-view.tsx'), 'utf8');
    expect(source).toContain('扫码登录百度网盘');
    expect(source).toContain('显示登录二维码');
    expect(source).toContain('扫码登录夸克网盘');
    expect(source).not.toContain('aria-label="百度 AppKey"');
    expect(source).not.toContain('aria-label="百度 SecretKey"');
    expect(source).not.toContain('百度网盘接入方式');
    expect(source).toContain('高级兼容：我已有本机 OpenList');
  });
});
