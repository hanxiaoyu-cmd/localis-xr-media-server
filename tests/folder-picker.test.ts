import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, parseFolderPickerOutput } from '../server/folder-picker';

describe('native folder picker protocol', () => {
  it('recognizes IPv4, IPv6 and mapped loopback addresses only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.88.1.2')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::1%12')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.31.20')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.31.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('round-trips Unicode paths and handles cancellation', () => {
    const directory = 'D:\\影片 资料\\VR 测试';
    const encoded = Buffer.from(directory, 'utf8').toString('base64');
    expect(parseFolderPickerOutput(` SELECTED:${encoded}\r\n`)).toBe(directory);
    expect(parseFolderPickerOutput('CANCELLED')).toBeUndefined();
    expect(parseFolderPickerOutput('')).toBeUndefined();
  });

  it('rejects malformed or non-canonical output', () => {
    expect(() => parseFolderPickerOutput('something else')).toThrow(/无法识别/);
    expect(() => parseFolderPickerOutput('SELECTED:!!!!')).toThrow(/编码无效/);
    expect(() => parseFolderPickerOutput('SELECTED:')).toThrow(/编码无效/);
    expect(() => parseFolderPickerOutput('SELECTED:/w==')).toThrow(/编码无效/);
  });
});
