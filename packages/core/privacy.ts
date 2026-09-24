import { homedir } from 'node:os';
const sensitiveKey =
  /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|auth(?:orization)?|token|password|passwd|secret|session(?:id)?|signature|sig|code|key|x-amz-.+|x-goog-.+)$/i;
export function redactURL(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()])
      if (sensitiveKey.test(key)) url.searchParams.set(key, '[REDACTED]');
    url.hash = '';
    return url.href;
  } catch {
    return input;
  }
}
export function redactSensitiveText(input: string): string {
  return input
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(?:apikey_[a-zA-Z0-9_]{20,}|npm_[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk-[a-zA-Z0-9_-]{20,})\b/g,
      '[REDACTED TOKEN]',
    )
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;"'<>]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => redactURL(value))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]');
}
export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const home = homedir();
  for (const prefix of [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])
    message = message.split(prefix).join('[HOME]');
  return redactSensitiveText(message);
}
