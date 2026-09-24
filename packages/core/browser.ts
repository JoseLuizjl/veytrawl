import type { Browser, LaunchOptions } from 'playwright';
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  if (process.versions.bun && process.platform === 'win32')
    throw new Error(
      'The Page-based browser SDK requires Node.js on Windows. Bun users can run veytrawl locate or --browser; the CLI delegates those commands to Node automatically.',
    );
  const { chromium } = await import('playwright');
  return chromium.launch({ chromiumSandbox: true, ...options });
}
