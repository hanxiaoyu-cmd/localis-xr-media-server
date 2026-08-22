import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let activePicker: Promise<string | undefined> | undefined;

export class FolderPickerBusyError extends Error {}
export class FolderPickerUnsupportedError extends Error {}

export function isLoopbackAddress(remoteAddress: string | undefined) {
  const normalized = (remoteAddress || '')
    .replace(/^::ffff:/i, '')
    .replace(/%.+$/, '')
    .toLowerCase();
  return normalized === '::1' || normalized.startsWith('127.');
}

export function parseFolderPickerOutput(stdout: string | Buffer | undefined) {
  const value = String(stdout || '').trim();
  if (!value || value === 'CANCELLED') return undefined;
  if (!value.startsWith('SELECTED:')) throw new Error('原生文件夹选择器返回了无法识别的结果。');
  const encoded = value.slice('SELECTED:'.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('原生文件夹选择器返回的路径编码无效。');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.length || decoded.toString('base64') !== encoded || decoded.toString('utf8').includes('\uFFFD')) {
    throw new Error('原生文件夹选择器返回的路径编码无效。');
  }
  return decoded.toString('utf8');
}

async function runPicker(initialPath?: string): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const initialPathBase64 = Buffer.from(initialPath || '', 'utf8').toString('base64');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择 Localis 媒体文件夹'",
      '$dialog.ShowNewFolderButton = $true',
      `$initial = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${initialPathBase64}'))`,
      'if ([System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }',
      '$result = $dialog.ShowDialog()',
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath); [Console]::Write('SELECTED:' + [Convert]::ToBase64String($bytes)) } else { [Console]::Write('CANCELLED') }",
      '$dialog.Dispose()',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
    );
    return parseFolderPickerOutput(result.stdout);
  }

  if (process.platform === 'darwin') {
    const result = await execFileAsync(
      'osascript',
      ['-e', 'try', '-e', 'POSIX path of (choose folder with prompt "选择 Localis 媒体文件夹")', '-e', 'on error number -128', '-e', 'return ""', '-e', 'end try'],
      { timeout: 10 * 60_000, maxBuffer: 64 * 1024 },
    );
    const value = String(result.stdout || '').trim();
    return value ? value.replace(/\/$/, '') : undefined;
  }

  try {
    const result = await execFileAsync(
      'zenity',
      ['--file-selection', '--directory', '--title=选择 Localis 媒体文件夹', ...(initialPath ? [`--filename=${initialPath}/`] : [])],
      { timeout: 10 * 60_000, maxBuffer: 64 * 1024 },
    );
    const value = String(result.stdout || '').trim();
    return value || undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
    if (String(code) === '1') return undefined;
    throw new FolderPickerUnsupportedError('当前 Linux 桌面缺少 zenity，无法打开原生文件夹选择器。');
  }
}

export async function pickLocalDirectory(initialPath?: string): Promise<string | undefined> {
  if (activePicker) throw new FolderPickerBusyError('文件夹选择窗口已经打开。');
  const operation = runPicker(initialPath);
  activePicker = operation;
  try {
    return await operation;
  } finally {
    if (activePicker === operation) activePicker = undefined;
  }
}
