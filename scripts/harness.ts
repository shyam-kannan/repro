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

export { identifyStore } from '../demo-store/identify.ts';

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
