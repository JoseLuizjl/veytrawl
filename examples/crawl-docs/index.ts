import { Veytrawl } from '../../packages/core/index.js';
const web = new Veytrawl();
try {
  console.log(
    await web.discover({
      start: process.argv[2] ?? 'https://www.typescriptlang.org/docs/',
      goal: process.argv[3] ?? 'generics types',
      maxPages: 5,
    }),
  );
} finally {
  web.close();
}
