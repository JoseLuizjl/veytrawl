import { homedir } from 'node:os';
import { basename } from 'node:path';
export function contentFindings(text) {
  const findings = [];
  const rules = [
    [
      'credential',
      /\b(?:apikey_[a-zA-Z0-9_]{20,}|npm_[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk-[a-zA-Z0-9_-]{20,})\b/,
    ],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    [
      'credential assignment',
      /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][a-zA-Z0-9_\-/+=]{24,}["']/i,
    ],
    ['npm authentication', /(?:_authToken|_auth|_password)\s*=\s*[^\s$]+/],
    [
      'personal filesystem path',
      /(?:[a-z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/(?:home|Users)\/[^/\s"']+)/i,
    ],
    [
      'unredacted email',
      /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b|[^\s@]+\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    ],
  ];
  for (const [category, pattern] of rules) if (pattern.test(text)) findings.push(category);
  const account = basename(homedir());
  if (
    account.length >= 4 &&
    !['user', 'runner', 'root', 'admin', 'administrator', 'default'].includes(account.toLowerCase())
  ) {
    const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) findings.push('local account identifier');
  }
  return findings;
}
export function assertPublicContent(name, content) {
  const findings = contentFindings(content.toString('utf8'));
  if (findings.length)
    throw new Error(`Content audit failed in ${name}: ${findings.join(', ')}. Values suppressed.`);
}
export function assertPackagePath(path) {
  if (/^dist\/packages\/[a-z0-9_/-]+\.(?:js|d\.ts)$/i.test(path)) return;
  if (
    [
      'package.json',
      'README.md',
      'LICENSE',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
    ].includes(path)
  )
    return;
  throw new Error(`Unexpected published file: ${path}`);
}

export function assertSourcePath(path) {
  if (
    [
      '.env.example',
      '.gitattributes',
      '.gitignore',
      '.npmrc',
      '.prettierignore',
      '.prettierrc.json',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'LICENSE',
      'package-lock.json',
      'package.json',
      'README.md',
      'SECURITY.md',
      'tsconfig.json',
    ].includes(path)
  )
    return;
  if (/^\.github\/(?:dependabot\.yml|workflows\/(?:ci|publish)\.yml)$/.test(path)) return;
  if (/^(?:packages|tests|examples|benchmarks)\/[a-z0-9_/-]+(?:\.test)?\.ts$/i.test(path)) return;
  if (/^scripts\/(?:lib\/)?[a-z0-9_-]+\.(?:mjs|sh)$/.test(path)) return;
  throw new Error(`Unexpected source file: ${path}`);
}
