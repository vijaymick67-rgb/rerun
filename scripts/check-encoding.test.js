import { describe, expect, it } from 'vitest';
import {
  findSuspiciousText,
  formatIssue,
  isScannablePath,
  scanBuffer,
} from './check-encoding.mjs';

const mojibake = (...codePoints) => String.fromCodePoint(...codePoints);

describe('encoding checker', () => {
  it('accepts valid UTF-8 source', () => {
    expect(scanBuffer(Buffer.from('const answer = 42;\n', 'utf8'), 'src/example.js')).toEqual([]);
  });

  it('accepts ordinary Unicode punctuation and symbols', () => {
    const source = 'const text = "… — ✓ ✕";\n';
    expect(scanBuffer(Buffer.from(source, 'utf8'), 'src/example.js')).toEqual([]);
  });

  it('rejects common ellipsis mojibake', () => {
    expect(findSuspiciousText(mojibake(0x00e2, 0x20ac, 0x2026))).toHaveLength(1);
  });

  it('rejects common em dash mojibake', () => {
    expect(findSuspiciousText(mojibake(0x00e2, 0x20ac, 0x201d))).toHaveLength(1);
  });

  it('rejects common check mark mojibake', () => {
    expect(findSuspiciousText(mojibake(0x00e2, 0x0153, 0x201c))).toHaveLength(1);
  });

  it('rejects the Unicode replacement character', () => {
    expect(findSuspiciousText(String.fromCodePoint(0xfffd))).toHaveLength(1);
  });

  it('ignores known binary files', () => {
    expect(scanBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), 'public/icon.png')).toEqual([]);
    expect(scanBuffer(Buffer.from([0x00, 0x01, 0x02]), 'fixtures/data.txt')).toEqual([]);
  });

  it('reports the affected file and line', () => {
    const [issue] = scanBuffer(Buffer.from(`ok\n${mojibake(0x00e2, 0x20ac, 0x2026)}\n`, 'utf8'), 'src/corrupt.js');
    expect(formatIssue(issue)).toContain('src/corrupt.js:2');
  });

  it('accepts ordinary ASCII source', () => {
    expect(scanBuffer(Buffer.from('export default true;\n', 'utf8'), 'src/example.js')).toEqual([]);
  });

  it('accepts legitimate non-English UTF-8 text', () => {
    expect(scanBuffer(Buffer.from('const greeting = "नमस्ते мир";\n', 'utf8'), 'src/example.js')).toEqual([]);
  });

  it('only scans relevant text paths', () => {
    expect(isScannablePath('src/example.jsx')).toBe(true);
    expect(isScannablePath('public/poster.webp')).toBe(false);
    expect(isScannablePath('node_modules/package/index.js')).toBe(false);
    expect(isScannablePath('dist/index.js')).toBe(false);
  });
});
