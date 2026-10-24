// Starts the demo store and the Repro UI on localhost.
//   [REPRO_STORE_FIXTURE=correct|faulty] [REPRO_PORT=4300] [STORE_PORT=4173] npm start
// The fixture is chosen here, once, and printed only to this terminal. Neither
// the UI nor the investigator is told which fixture is running.
import { once } from 'node:events';
import { join } from 'node:path';
import { createStoreServer } from '../demo-store/server.ts';
import { FIXTURES, isFixture } from '../demo-store/pricing.ts';
import { createReproServer } from '../app/server.ts';
import { loadConfig } from '../src/config.ts';
import { createAnthropicProvider } from '../src/provider.ts';

const repoRoot = new URL('..', import.meta.url).pathname;
const fixture = process.env.REPRO_STORE_FIXTURE ?? 'faulty';
if (!isFixture(fixture)) {
  console.error(`REPRO_STORE_FIXTURE must be one of: ${FIXTURES.join(', ')}`);
  process.exit(2);
}
const reproPort = port(process.env.REPRO_PORT, 4300);
const storePort = port(process.env.STORE_PORT, 4173);

const loaded = loadConfig();
const store = createStoreServer(fixture);
store.listen(storePort, '127.0.0.1');
await listening(store, 'demo store', storePort);
const storeUrl = `http://127.0.0.1:${storePort}/`;

const repro = await createReproServer({
  provider: loaded.ok ? createAnthropicProvider(loaded.config.apiKey) : null,
  configProblems: loaded.ok ? [] : loaded.problems,
  settings: loaded.ok ? loaded.config.settings : null,
  storeUrl,
  runsDir: join(repoRoot, 'runs', 'ui'),
});
repro.server.listen(reproPort, '127.0.0.1');
await listening(repro.server, 'Repro UI', reproPort);

console.log(`Demo store:  ${storeUrl}  (fixture: ${fixture})`);
console.log(`Repro:       http://127.0.0.1:${reproPort}/`);
if (loaded.ok) {
  console.log(`Model:       ${loaded.config.settings.model}, max output tokens ${loaded.config.settings.maxOutputTokens}`);
} else {
  console.log(`Not configured: ${loaded.problems.join('; ')}. The UI loads but cannot investigate. See README.md.`);
}
console.log('Runs are saved under runs/ui/. Press Ctrl+C to stop.');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    repro.interruptActive('The Repro server was stopped while this investigation was running.');
    repro.server.close();
    repro.server.closeAllConnections();
    store.close();
    store.closeAllConnections();
    // Give the investigator a moment to close its browser.
    void Promise.race([repro.idle(), new Promise((r) => setTimeout(r, 5_000))]).then(() => process.exit(0));
  });
}

function port(raw: string | undefined, fallback: number): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    console.error(`Invalid port: ${raw}`);
    process.exit(2);
  }
  return value;
}

async function listening(server: import('node:http').Server, name: string, portNumber: number) {
  const failed = once(server, 'error').then(([error]) => {
    throw error;
  });
  try {
    await Promise.race([once(server, 'listening'), failed]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE' ? `Port ${portNumber} for the ${name} is already in use.` : `Could not start the ${name}: ${error}`);
    process.exit(1);
  }
}
