import { Veytrawl } from '../../packages/core/index.js';
const url = process.argv[2];
if (!url) throw new Error('Pass a pricing URL');
const web = new Veytrawl({ storage: 'pricing.sqlite' });
try {
  console.log(await web.watch({ url, watchFor: 'pricing changes' }));
  console.log(web.feed({ url, watchFor: 'pricing changes' }));
} finally {
  web.close();
}
