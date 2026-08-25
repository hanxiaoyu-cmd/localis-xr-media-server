import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cloud login UX', () => {
  it('sets up Baidu once on the computer and keeps credentials out of the QR request', async () => {
    const source = await readFile(path.join(process.cwd(), 'app', 'components', 'media-library-view.tsx'), 'utf8');
    expect(source).toContain('扫码登录百度网盘');
    expect(source).toContain('显示登录二维码');
    expect(source).toContain('/api/cloud/baidu/settings');
    expect(source).toContain("method: 'PUT'");
    expect(source).toContain("method: 'DELETE'");
    expect(source).toContain('保存并显示二维码');
    expect(source).toContain('aria-label="百度 AppKey"');
    expect(source).toContain('aria-label="百度 SecretKey"');
    expect(source).toContain('aria-label="百度应用目录"');
    const beginAuthorization = source.slice(source.indexOf('const beginBaiduAuthorization'), source.indexOf('const saveBaiduSettings'));
    expect(beginAuthorization).not.toContain('appKey');
    expect(beginAuthorization).not.toContain('secretKey');
  });

  it('implements the complete computer-side Quark install, authorization, search and download flow', async () => {
    const source = await readFile(path.join(process.cwd(), 'app', 'components', 'media-library-view.tsx'), 'utf8');
    expect(source).toContain('在电脑上登录夸克网盘');
    expect(source).toContain('/api/cloud/quark/install');
    expect(source).toContain('/api/cloud/quark/login');
    expect(source).toContain('/api/cloud/quark/login/token');
    expect(source).toContain('/api/cloud/quark/search');
    expect(source).toContain('/api/cloud/quark/downloads');
    expect(source).toContain('安装夸克官方组件');
    expect(source).toContain('打开电脑浏览器授权');
    expect(source).toContain('下载到电脑并加入资料库');
    expect(source).toContain("accountState !== 'authenticated'");
    expect(source).toContain("['ready', 'failed', 'cancelled']");
    expect(source).toContain('没有找到可下载的媒体');
    expect(source.replaceAll('\r\n', '\n')).toContain("if (status === 404 || status === 410) {\n          setQuarkDownload(undefined);");
  });

  it('keeps management on localhost-only UI while retaining the advanced local bridge', async () => {
    const source = await readFile(path.join(process.cwd(), 'app', 'components', 'media-library-view.tsx'), 'utf8');
    expect(source).toContain('server?.canManageCloud && <button');
    expect(source).toContain('头显看不到任何网盘凭据');
    expect(source).toContain('高级兼容：我已有本机 OpenList');
    expect(source).toContain('aria-label="OpenList WebDAV 地址"');
    expect(source).toContain('aria-label="云盘挂载路径"');
    expect(source).toContain('aria-label="OpenList 只读用户名"');
    expect(source).toContain('aria-label="OpenList 只读密码"');
  });
});
