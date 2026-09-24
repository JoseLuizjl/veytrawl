import { Veytrawl, launchBrowser } from '../../packages/core/index.js';
const browser = await launchBrowser(),
  web = new Veytrawl();
try {
  const page = await browser.newPage();
  await page.setContent('<button onclick="this.textContent=\'Done\'">Complete purchase</button>');
  const checkout = await web.locate(page, 'checkout button');
  await checkout.click();
  console.log(await checkout.locator.innerText());
} finally {
  web.close();
  await browser.close();
}
