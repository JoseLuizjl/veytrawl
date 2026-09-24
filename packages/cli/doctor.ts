import { safeError } from '../core/privacy.js';
import { statePath } from '../core/paths.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}
export async function doctor(checkBrowser = false) {
  const checks: Check[] = [];
  const runtimeOK =
    Boolean(process.versions.bun) || Number(process.versions.node.split('.')[0]) >= 24;
  checks.push({
    name: 'runtime',
    status: runtimeOK ? 'pass' : 'fail',
    detail: process.versions.bun
      ? `Bun ${process.versions.bun}; browser CLI uses Node`
      : `Node ${process.version}`,
    ...(!runtimeOK ? { hint: 'Install Node.js 24 or newer.' } : {}),
  });
  try {
    const { openDatabase } = await import('../core/database.js');
    const db = openDatabase();
    try {
      db.exec('CREATE TABLE diagnostic (value TEXT)');
      db.prepare('INSERT INTO diagnostic VALUES (?)').run('ok');
      if (
        (
          db.prepare('SELECT value FROM diagnostic').get() as {
            value: string;
          }
        ).value !== 'ok'
      )
        throw new Error('SQLite readback mismatch');
    } finally {
      db.close();
    }
    checks.push({
      name: 'sqlite',
      status: 'pass',
      detail: 'In-memory write/read succeeded; existing databases were not opened.',
    });
  } catch (error) {
    checks.push({
      name: 'sqlite',
      status: 'fail',
      detail: safeError(error),
      hint: 'Use Node.js 24+ or a supported Bun version.',
    });
  }
  if (existsSync(statePath('browsers')))
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
  try {
    const { chromium } = await import('playwright');
    if (checkBrowser) {
      const { launchBrowser } = await import('../core/browser.js');
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent('<h1>Veytrawl diagnostic</h1>');
        if ((await page.locator('h1').innerText()) !== 'Veytrawl diagnostic')
          throw new Error('Browser readback mismatch');
        checks.push({
          name: 'browser',
          status: 'pass',
          detail: `Chromium ${browser.version()} launched and read a local page.`,
        });
      } finally {
        await browser.close();
      }
    } else {
      const executable = chromium.executablePath();
      checks.push({
        name: 'browser',
        status: existsSync(executable) ? 'pass' : 'warn',
        detail: existsSync(executable)
          ? 'Chromium executable found; launch not tested.'
          : 'Full Chromium executable not found; a headless-shell installation may still work.',
        hint: 'Run veytrawl doctor --browser to verify launch. Install if needed: npx --yes playwright@1.63.0 install chromium',
      });
    }
  } catch (error) {
    checks.push({
      name: 'browser',
      status: checkBrowser ? 'fail' : 'warn',
      detail: safeError(error),
      hint: 'Install Chromium and its system dependencies: npx --yes playwright@1.63.0 install --with-deps chromium',
    });
  }
  const modelDir = resolve(statePath('models'), 'Xenova/all-MiniLM-L6-v2');
  let optionalRuntime = false;
  try {
    createRequire(import.meta.url).resolve('@huggingface/transformers');
    optionalRuntime = true;
  } catch {}
  const cached = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
  ].every((file) => existsSync(resolve(modelDir, file)));
  checks.push({
    name: 'embeddings',
    status: optionalRuntime && cached ? 'pass' : 'warn',
    detail: `Optional runtime ${optionalRuntime ? 'found' : 'missing'}; default model files ${cached ? 'found' : 'missing'}. Inference not tested.`,
    hint: 'Optional: install optional dependencies, then use locate or crawl with --embeddings to cache the model. Add --offline-model for subsequent offline model use.',
  });
  checks.push({
    name: 'jev',
    status: process.env.TYPESAFE_API_KEY ? 'pass' : 'warn',
    detail: process.env.TYPESAFE_API_KEY
      ? 'Environment credential configured; service not contacted.'
      : 'Optional TYPESAFE_API_KEY not configured; core features work without it.',
  });
  return { ready: !checks.some((check) => check.status === 'fail'), checks };
}
export function doctorText(report: Awaited<ReturnType<typeof doctor>>) {
  return (
    [
      `Veytrawl: ${report.ready ? 'ready for the checked capabilities' : 'setup needs attention'}`,
      ...report.checks.map(
        (check) =>
          `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}${check.hint ? `\n  ${check.hint}` : ''}`,
      ),
    ].join('\n\n') + '\n'
  );
}
