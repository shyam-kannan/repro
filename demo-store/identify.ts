// Confirms which fixture a running demo store is serving, from outside any
// investigator browser (used by the evaluation harness and the Repro server
// before each run). The store is stateless, so probing cannot change what an
// investigation later sees.
import type { Fixture } from './pricing.ts';

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
