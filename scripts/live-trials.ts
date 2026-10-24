// The two initial live trials: one cart complaint against each store fixture.
// Each run is saved separately under an opaque run ID. The fixture-to-run
// mapping and the expected verdicts live only in this harness and in the
// manifest written after both runs; the investigator never receives them.
// Failures are reported as they are, with no retries.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Fixture } from '../demo-store/pricing.ts';
import { loadConfig } from '../src/config.ts';
import { investigate, type RunRecord } from '../src/investigator.ts';
import { createAnthropicProvider } from '../src/provider.ts';
import { formatRunSummary } from '../src/summary.ts';
import { identifyStore, opaqueRunId, startStore, timestamp } from './harness.ts';

const COMPLAINT = 'When I increase the quantity in my cart, the total stays the same.';
const TRIALS: { fixture: Fixture; expectedVerdict: RunRecord['verdictCode'] }[] = [
  { fixture: 'correct', expectedVerdict: 'not_reproduced' },
  { fixture: 'faulty', expectedVerdict: 'reproduced' },
];

const repoRoot = new URL('..', import.meta.url).pathname;
const loaded = loadConfig();
if (!loaded.ok) {
  console.error(`Live verification blocked: ${loaded.problems.join('; ')}. See .env.example.`);
  process.exit(2);
}
const { apiKey, settings } = loaded.config;
console.log(`Model: ${settings.model}; max output tokens per response: ${settings.maxOutputTokens}`);

const trialDir = join(repoRoot, 'runs', `trials-${timestamp()}`);
await mkdir(trialDir, { recursive: true });
const provider = createAnthropicProvider(apiKey);
const manifest: object[] = [];
let matched = 0;

for (const { fixture, expectedVerdict } of TRIALS) {
  const store = await startStore(fixture);
  const storeUrl = store.url;
  const runId = opaqueRunId();
  try {
    const answering = await identifyStore(storeUrl);
    if (answering !== fixture) throw new Error(`Expected the ${fixture} store at ${storeUrl}, found ${answering}`);
    const record = await investigate({ complaint: COMPLAINT, storeUrl }, { provider, settings, runsDir: trialDir, runId });
    const asExpected = record.verdictCode === expectedVerdict;
    if (asExpected) matched++;
    manifest.push({ runId, fixture, expectedVerdict, verdict: record.verdictCode, asExpected, runDir: relative(repoRoot, record.runDir) });
    console.log(`\n[${fixture} fixture] expected ${expectedVerdict}, got ${record.verdictCode}`);
    console.log(formatRunSummary(record, repoRoot));
  } finally {
    store.close();
  }
}

await writeFile(join(trialDir, 'manifest.json'), JSON.stringify({ complaint: COMPLAINT, runs: manifest }, null, 2));
console.log(`\n${matched}/${TRIALS.length} trials matched the expected verdict. Manifest: ${relative(repoRoot, trialDir)}/manifest.json`);
process.exitCode = matched === TRIALS.length ? 0 : 1;
