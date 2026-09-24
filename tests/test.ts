const moduleName = process.versions.bun ? 'bun:test' : 'node:test';
export const { test } = (await import(moduleName)) as typeof import('node:test');
