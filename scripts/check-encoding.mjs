import { execFileSync } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.jsx',
  '.md',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bin',
  '.bmp',
  '.db',
  '.dll',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.rar',
  '.sqlite',
  '.tar',
  '.tgz',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

const IGNORED_PATH_PARTS = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const TEXT_FILENAMES = new Set(['.editorconfig', '.gitattributes', 'dockerfile', 'license', 'makefile', 'readme']);

const MOJIBAKE_SECOND_CHARS = String.fromCodePoint(
  0x20ac,
  0x201a,
  0x201e,
  0x2026,
  0x2020,
  0x2021,
  0x02c6,
  0x2030,
  0x0160,
  0x2039,
  0x0152,
  0x017d,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2022,
  0x2013,
  0x2014,
  0x02dc,
  0x2122,
  0x0161,
  0x203a,
  0x0153,
  0x017e,
  0x0178,
);
const MOJIBAKE_PATTERN = new RegExp(
  `(?:${String.fromCodePoint(0x00e2)}[${MOJIBAKE_SECOND_CHARS}]|${String.fromCodePoint(0x00c3)}[\\u0080-\\u00bf]|${String.fromCodePoint(0x00c2)}[\\u0080-\\u00bf]|${String.fromCodePoint(0x00f0)}[\\u0080-\\u00bf]{2})`,
  'gu',
);
const REPLACEMENT_PATTERN = new RegExp(String.fromCodePoint(0xfffd), 'gu');

export function isScannablePath(filePath) {
  if (filePath.split(/[\\/]/).some((part) => IGNORED_PATH_PARTS.has(part.toLowerCase()))) return false;

  const extension = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return false;

  const name = basename(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || TEXT_FILENAMES.has(name);
}

export function findSuspiciousText(text) {
  const issues = [];
  const addMatches = (pattern, message) => {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      issues.push({ line, message });
    }
  };

  addMatches(REPLACEMENT_PATTERN, 'Unicode replacement character');
  addMatches(MOJIBAKE_PATTERN, 'common mojibake signature');
  return issues;
}

export function scanBuffer(buffer, filePath = '') {
  if (!isScannablePath(filePath) || buffer.includes(0)) return [];

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return [{ filePath, line: null, message: 'invalid UTF-8 byte sequence' }];
  }

  return findSuspiciousText(text).map((issue) => ({ ...issue, filePath }));
}

export function getTrackedFiles(cwd = process.cwd()) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'buffer' });
  return output.toString('utf8').split('\0').filter(Boolean);
}

export function scanTrackedFiles(cwd = process.cwd()) {
  return getTrackedFiles(cwd).flatMap((filePath) => {
    const buffer = readFileSync(resolve(cwd, filePath));
    return scanBuffer(buffer, filePath);
  });
}

export function formatIssue(issue) {
  const location = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
  return `${location} — ${issue.message}`;
}

export function formatIssues(issues) {
  return issues.map(formatIssue).join('\n');
}

function main() {
  const issues = scanTrackedFiles();
  if (issues.length === 0) {
    console.log('Encoding check passed: tracked text files are valid UTF-8 with no common mojibake signatures.');
    return;
  }

  console.error(`Encoding check failed with ${issues.length} issue(s):`);
  console.error(formatIssues(issues));
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
