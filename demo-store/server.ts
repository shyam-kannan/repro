import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { priceCart, PricingError, type Fixture } from './pricing.ts';

const PUBLIC_DIR = new URL('./public/', import.meta.url);

const STATIC_ROUTES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/cart.js': { file: 'cart.js', type: 'text/javascript; charset=utf-8' },
};

const MAX_BODY_BYTES = 10_000;

// Responses carry no fixture-specific headers or fields, so the page cannot
// tell which fixture it is talking to except through the cart's behavior.
export function createStoreServer(fixture: Fixture): Server {
  const assets = new Map(
    Object.entries(STATIC_ROUTES).map(([route, { file, type }]) => [
      route,
      { body: readFileSync(new URL(file, PUBLIC_DIR)), type },
    ]),
  );

  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');

    const asset = assets.get(path);
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'Content-Type': asset.type }).end(asset.body);
      return;
    }

    if (req.method === 'POST' && path === '/api/cart/price') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) req.destroy();
      });
      req.on('end', () => {
        try {
          const cart = priceCart(JSON.parse(body).lines, fixture);
          sendJson(res, 200, cart);
        } catch (error) {
          const message = error instanceof PricingError ? error.message : 'Bad request.';
          sendJson(res, 400, { error: message });
        }
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}
