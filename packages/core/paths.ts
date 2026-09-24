import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export function statePath(resource: string, cwd = process.cwd()): string {
  const current = resolve(cwd, '.veytrawl', resource),
    legacy = resolve(cwd, '.semweb', resource);
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
