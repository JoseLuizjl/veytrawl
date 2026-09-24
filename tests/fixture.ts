import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
export function page(body: string, title = 'Veytrawl demo') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:18px system-ui;background:#f5f7fb;color:#182031;max-width:800px;margin:60px auto;padding:30px}h1{font-size:40px}section{padding:24px;border:1px solid #ccd3df;border-radius:16px;margin:20px 0;background:white}button{background:#245bdd;color:white;border:0;padding:15px 25px;border-radius:8px;font:inherit;cursor:pointer}a{display:block;margin:15px 0;color:#245bdd}.price{font-size:32px}.hidden{display:none}</style></head><body>${body}</body></html>`;
}
export async function fixture() {
  let version = 0;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    requests.push(path);
    if (path === '/robots.txt') {
      res.setHeader('content-type', 'text/plain');
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/private' });
      res.end();
      return;
    }
    if (path === '/external-redirect') {
      res.writeHead(302, { location: 'http://example.invalid/' });
      res.end();
      return;
    }
    if (path === '/broken') {
      res.writeHead(500);
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/')
      res.end(
        page(
          '<h1>Developer documentation</h1><nav><a href="/careers">Careers</a><a href="/oauth-authentication.png">OAuth authentication diagram</a><a href="/oauth">OAuth authentication</a><a href="/auth">Authentication guide</a><a href="/oauth#token">OAuth tokens</a><a href="/private">Private OAuth</a><a href="/about">About us</a></nav>',
          'Developer documentation',
        ),
      );
    else if (path === '/oauth')
      res.end(
        page(
          '<h1>OAuth authentication</h1><p>Authorize requests with OAuth tokens.</p><a href="/api">OAuth API reference</a><a href="/auth">Authentication</a>',
          'OAuth authentication',
        ),
      );
    else if (path === '/auth')
      res.end(
        page('<h1>Authentication</h1><p>Authenticate using OAuth.</p>', 'Authentication guide'),
      );
    else if (path === '/api')
      res.end(page('<h1>OAuth API</h1><p>POST /oauth/token</p>', 'OAuth API'));
    else if (path === '/shop')
      res.end(
        page(
          `<h1>Your order</h1><section><h2>Veytrawl Starter</h2><p>One license, ready to use.</p><button ${version ? 'id="purchase-new" class="new-layout"' : 'data-testid="checkout" id="checkout-old"'} onclick="document.querySelector('#status').textContent='Order completed'">Complete purchase</button></section><p id="status" role="status">Ready</p>`,
          'Checkout',
        ),
      );
    else if (path === '/pricing')
      res.end(
        page(
          `<h1>Plans</h1><section class="layout-${version}"><h2>Starter</h2><p class="price">$${version >= 2 ? '15' : '10'} / month</p><button>Buy now</button></section><time>2026-09-22T12:00:0${version}Z</time><script>window.analytics=${version}</script>`,
          'Pricing',
        ),
      );
    else res.end(page(`<h1>${path.slice(1)}</h1>`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setVersion: (value: number) => {
      version = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
