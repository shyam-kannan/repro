// Runs one investigation against a store URL.
//   npm run investigate -- --url http://127.0.0.1:4173/ [--expected "..."] "complaint text"
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { investigate } from '../src/investigator.ts';
import { createAnthropicProvider } from '../src/provider.ts';
import { formatRunSummary } from '../src/summary.ts';

const repoRoot = new URL('..', import.meta.url).pathname;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string' }, expected: { type: 'string' } },
});
const complaint = positionals.join(' ').trim();
if (!values.url || !complaint) {
  console.error('Usage: npm run investigate -- --url <store URL> [--expected "<expected behavior>"] "<complaint>"');
  process.exit(2);
}

const loaded = loadConfig();
if (!loaded.ok) {
  console.error(`Cannot run the investigator: ${loaded.problems.join('; ')}. See .env.example.`);
  process.exit(2);
}

const record = await investigate(
  { complaint, expectedBehavior: values.expected, storeUrl: values.url },
  {
    provider: createAnthropicProvider(loaded.config.apiKey),
    settings: loaded.config.settings,
    runsDir: join(repoRoot, 'runs'),
  },
);
console.log(formatRunSummary(record, repoRoot));
