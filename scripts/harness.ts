// Shared code for the live trial and evaluation scripts: starting a demo store,
// confirming which fixture is actually answering on a URL, and producing a URL
// where no store is running. Everything here runs in the harness only; the
// investigator never receives fixture names, probe results or expectations.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createStoreServer } from '../demo-store/server.ts';
import type { Fixture } from '../demo-store/pricing.ts';

export type RunningStore = { url: string; port: number; close: () => void };

// Listens on an OS-assigned port, so it cannot collide with another server.
export async function startStore(fixture: Fixture): Promise<RunningStore> {
  const server = createStoreServer(fixture);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

// Classifies the server at `url` by pricing 2 and then 3 mugs through its API
// (outside any investigator browser). Each fixture gives a distinct pair:
//   correct ($40.00, $60.00), faulty ($20.00, $20.00), faulty-from-3 ($40.00, $40.00).
// Quantity 2 alone cannot tell correct from faulty-from-3. Also checks that the
// cart page is the demo store's. Throws if the server is anything else.
const FIXTURE_PRICES: Record<string, Fixture> = {
  '4000,6000': 'correct',
  '2000,2000': 'faulty',
  '4000,4000': 'faulty-from-3',
};

export async function identifyStore(url: string): Promise<Fixture> {
  const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const html = await page.text();
  if (!page.ok || !html.includes('Increase quantity')) {
    throw new Error(`${url} did not serve the demo cart page (HTTP ${page.status})`);
  }
  const totals: unknown[] = [];
  for (const quantity of [2, 3]) {
    const response = await fetch(new URL('/api/cart/price', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [{ id: 'mug', quantity }] }),
      signal: AbortSignal.timeout(5_000),
    });
    totals.push(((await response.json()) as { totalCents?: unknown }).totalCents);
  }
  const fixture = FIXTURE_PRICES[totals.join(',')];
  if (!fixture) throw new Error(`${url} priced 2 and 3 mugs at ${totals.join(' and ')} cents; not a known demo store`);
  return fixture;
}

// A loopback URL with nothing listening: binds an ephemeral port, releases it,
// then confirms a connection is refused before handing it out.
export async function unavailableStoreUrl(): Promise<string> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  const url = `http://127.0.0.1:${port}/`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === 'ECONNREFUSED') return url;
    throw new Error(`Unexpected probe failure on ${url}: ${code ?? String(error)}`);
  }
  throw new Error(`Something started answering on ${url}; cannot use it as the unavailable store`);
}

// Opaque, so a run ID says nothing about its fixture or expected verdict.
export function opaqueRunId(): string {
  return `run-${randomBytes(4).toString('hex')}`;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
