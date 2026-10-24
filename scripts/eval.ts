// Small live evaluations with the configured model, prompts and limits; each
// run happens exactly once and is kept as-is.
//   npm run eval                    the original eight cases (CASES)
//   npm run eval -- faulty-from-3   three runs on the faulty-from-3 store plus one correct-store control
// The expected verdicts and store setups live only in this file. The
// investigator receives the complaint and a store URL, nothing else.
// Output (git-ignored): runs/eval-<timestamp>/ with one directory per run,
// summary.json, summary.md, contact-sheet.html and contact-sheet.png.
import { appendFile, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Fixture } from '../demo-store/pricing.ts';
import { loadConfig, type InvestigatorSettings } from '../src/config.ts';
import { investigate, type RunRecord } from '../src/investigator.ts';
import { createAnthropicProvider, type ModelProvider } from '../src/provider.ts';
import { identifyStore, opaqueRunId, startStore, timestamp, unavailableStoreUrl } from './harness.ts';

const CART_COMPLAINT = 'When I increase the quantity in my cart, the total stays the same.';
const SEARCH_COMPLAINT = 'Searching for headphones returns no results.';

type Store = Fixture | 'unavailable';
export type Case = { id: string; store: Store; complaint: string; expected: RunRecord['verdictCode'] };

// Interleaved so correct and faulty runs share similar conditions over time.
export const CASES: Case[] = [
  { id: 'correct-1', store: 'correct', complaint: CART_COMPLAINT, expected: 'not_reproduced' },
  { id: 'faulty-1', store: 'faulty', complaint: CART_COMPLAINT, expected: 'reproduced' },
  { id: 'correct-2', store: 'correct', complaint: CART_COMPLAINT, expected: 'not_reproduced' },
  { id: 'faulty-2', store: 'faulty', complaint: CART_COMPLAINT, expected: 'reproduced' },
  { id: 'correct-3', store: 'correct', complaint: CART_COMPLAINT, expected: 'not_reproduced' },
  { id: 'faulty-3', store: 'faulty', complaint: CART_COMPLAINT, expected: 'reproduced' },
  { id: 'store-unavailable', store: 'unavailable', complaint: CART_COMPLAINT, expected: 'inconclusive' },
  // The store has no search feature; the correct fixture is used so nothing else is broken.
  { id: 'unrelated-complaint', store: 'correct', complaint: SEARCH_COMPLAINT, expected: 'inconclusive' },
];

// The bug only appears from quantity 3, after one click that works correctly.
export const FAULTY_FROM_3_CASES: Case[] = [
  { id: 'faulty-from-3-1', store: 'faulty-from-3', complaint: CART_COMPLAINT, expected: 'reproduced' },
  { id: 'correct-control', store: 'correct', complaint: CART_COMPLAINT, expected: 'not_reproduced' },
  { id: 'faulty-from-3-2', store: 'faulty-from-3', complaint: CART_COMPLAINT, expected: 'reproduced' },
  { id: 'faulty-from-3-3', store: 'faulty-from-3', complaint: CART_COMPLAINT, expected: 'reproduced' },
];

export const SUITES: Record<string, Case[]> = { original: CASES, 'faulty-from-3': FAULTY_FROM_3_CASES };

const VERDICT_LABEL = { reproduced: 'Reproduced', not_reproduced: 'Not reproduced in this run', inconclusive: 'Inconclusive' };

type ScreenshotCheck = {
  observations: number;
  missing: string[];
  invalid: string[];
  citedWithoutScreenshot: string[];
  sizes: Record<string, string>;
};

export type CaseResult = {
  caseId: string;
  store: Store;
  storeCheck: string;
  complaint: string;
  expected: string;
  runId: string;
  runDir: string | null;
  actual: string | null;
  match: boolean;
  endReason: string | null;
  verdictReasons: string[];
  modelProposed: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  modelRequests: number;
  failedModelRequests: number;
  browserToolCalls: number;
  citations: { total: number; matched: number };
  // null when no report was submitted, so there was nothing to check.
  evidenceChecksPassed: boolean | null;
  toolErrors: number;
  blockedRequests: number;
  screenshots: ScreenshotCheck | null;
  exploration: Exploration | null;
  // For a mismatch: why the verdict differs, judged against the run's own recording.
  mismatchAnalysis: string | null;
  harnessError?: string;
};

// How far a run went, from its recorded actions and observations.
type Exploration = {
  clicks: number;
  quantities: string[];
  maxQuantity: number | null;
  // Observations whose Total differs from Unit price × Quantity.
  wrongTotals: { observation: string; quantity: string; total: string; expectedTotal: string }[];
};

const repoRoot = new URL('..', import.meta.url).pathname;

export type EvaluationDeps = {
  provider: ModelProvider;
  settings: InvestigatorSettings;
  evalDir: string;
  cases?: Case[];
  suite?: string;
  log?: (line: string) => void;
};

export async function runEvaluation(deps: EvaluationDeps) {
  const { provider, settings, evalDir } = deps;
  const log = deps.log ?? ((line) => console.log(line));
  await mkdir(evalDir, { recursive: true });
  log(`Model: ${settings.model}; max output tokens ${settings.maxOutputTokens}; ` +
    `limits ${settings.maxBrowserToolCalls} browser tool calls, ${settings.deadlineMs / 1000} s`);
  log(`Provider: ${provider.name}`);
  log(`Output: ${relative(repoRoot, evalDir)}/`);

  const results: CaseResult[] = [];
  for (const testCase of deps.cases ?? CASES) {
    const runId = opaqueRunId();
    const result = await runCase(testCase, runId, deps);
    results.push(result);
    // Saved as each run finishes, so a later failure cannot lose it.
    await appendFile(join(evalDir, 'results.jsonl'), `${JSON.stringify(result)}\n`);
    log(
      `${testCase.id.padEnd(20)} ${runId}  ` +
        (result.harnessError
          ? `HARNESS ERROR: ${result.harnessError}`
          : `${result.actual} (${result.match ? 'as expected' : `expected ${result.expected}`})`),
    );
  }

  return writeSummary(results, evalDir, { suite: deps.suite ?? 'original', provider: provider.name, settings }, log);
}

async function writeSummary(
  results: CaseResult[],
  evalDir: string,
  meta: { suite: string; provider: string; settings: InvestigatorSettings; note?: string },
  log: (line: string) => void,
) {
  const { settings } = meta;
  const summary = {
    createdAt: new Date().toISOString(),
    suite: meta.suite,
    ...(meta.note ? { note: meta.note } : {}),
    provider: meta.provider,
    model: settings.model,
    settings,
    matched: results.filter((r) => r.match).length,
    total: results.length,
    results,
  };
  await writeFile(join(evalDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const table = markdownTable(results);
  await writeFile(
    join(evalDir, 'summary.md'),
    `# Evaluation ${relative(repoRoot, evalDir)} (suite: ${meta.suite})\n\n${meta.note ? `${meta.note}\n\n` : ''}` +
      `Provider ${meta.provider}, model \`${settings.model}\`, ` +
      `max output tokens ${settings.maxOutputTokens}, ${settings.maxBrowserToolCalls} browser tool calls, ` +
      `${settings.deadlineMs / 1000} s deadline.\n\n${summary.matched}/${summary.total} verdicts matched the expected verdict.\n\n${table}\n`,
  );
  await writeContactSheet(results, evalDir);
  log(`\n${table}\n`);
  log(`${summary.matched}/${summary.total} matched. Summary: ${relative(repoRoot, evalDir)}/summary.md`);
  return summary;
}

// Rebuilds the summary of an earlier evaluation from its results.jsonl (case,
// run ID and store check, written before analysis) and the saved run records.
// Runs no investigations and makes no model requests.
export async function summarizeExisting(evalDir: string, log: (line: string) => void = (line) => console.log(line)) {
  const lines = (await readFile(join(evalDir, 'results.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as CaseResult);
  const allCases = Object.values(SUITES).flat();
  const suite = Object.entries(SUITES).find(([, cases]) => lines.every((l) => cases.some((c) => c.id === l.caseId)))?.[0] ?? 'unknown';
  const results: CaseResult[] = [];
  let settings: InvestigatorSettings | null = null;
  let provider = 'unknown';
  for (const line of lines) {
    const testCase = allCases.find((c) => c.id === line.caseId);
    const record = await readFile(join(evalDir, line.runId, 'run.json'), 'utf8').then(
      (text) => JSON.parse(text) as RunRecord,
      () => null,
    );
    if (!testCase || !record) {
      results.push(line);
      continue;
    }
    // Saved records hold the absolute run directory of the machine that wrote them.
    record.runDir = join(evalDir, line.runId);
    settings ??= record.settings;
    provider = record.provider;
    results.push(await resultFromRecord(line, line.storeCheck, record, testCase.expected));
  }
  if (!settings) throw new Error(`No saved run records in ${evalDir}`);
  return writeSummary(
    results,
    evalDir,
    { suite, provider, settings, note: 'Rebuilt from saved run records with `--summarize`; no investigations were run for this summary.' },
    log,
  );
}

async function runCase(testCase: Case, runId: string, { provider, settings, evalDir }: EvaluationDeps): Promise<CaseResult> {
  const base = {
    caseId: testCase.id,
    store: testCase.store,
    complaint: testCase.complaint,
    expected: VERDICT_LABEL[testCase.expected],
    runId,
  };
  let store: { url: string; close: () => void } | null = null;
  let storeCheck: string;
  try {
    // Confirm what is (or is not) answering on the URL before investigating.
    if (testCase.store === 'unavailable') {
      const url = await unavailableStoreUrl();
      store = { url, close: () => {} };
      storeCheck = `connection refused at ${url}`;
    } else {
      store = await startStore(testCase.store);
      const answering = await identifyStore(store.url);
      if (answering !== testCase.store) throw new Error(`expected the ${testCase.store} store, found ${answering}`);
      storeCheck = `${answering} store confirmed at ${store.url}`;
    }
  } catch (error) {
    store?.close();
    return emptyResult(base, `store check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let record: RunRecord;
  try {
    // investigate() launches a new browser process and context for every run.
    record = await investigate({ complaint: testCase.complaint, storeUrl: store.url }, { provider, settings, runsDir: evalDir, runId });
  } catch (error) {
    return emptyResult({ ...base }, `investigation threw: ${error instanceof Error ? error.message : String(error)}`, storeCheck);
  } finally {
    store.close();
  }
  return resultFromRecord(base, storeCheck, record, testCase.expected);
}

async function resultFromRecord(
  base: Pick<CaseResult, 'caseId' | 'store' | 'complaint' | 'expected' | 'runId'>,
  storeCheck: string,
  record: RunRecord,
  expected: RunRecord['verdictCode'],
): Promise<CaseResult> {
  return {
      caseId: base.caseId,
      store: base.store,
      complaint: base.complaint,
      expected: base.expected,
      runId: base.runId,
      storeCheck,
      runDir: relative(repoRoot, record.runDir),
      actual: record.verdict,
      match: record.verdictCode === expected,
      endReason: record.endReason,
      verdictReasons: record.verdictReasons,
      modelProposed: record.modelReport?.verdict ?? null,
      durationMs: record.durationMs,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      modelRequests: record.providerCalls.length,
      failedModelRequests: record.providerCalls.filter((c) => !c.ok).length,
      browserToolCalls: record.browserToolCalls,
      citations: { total: record.evidence.length, matched: record.evidence.filter((c) => c.ok).length },
      evidenceChecksPassed: record.modelReport
        ? record.evidence.every((c) => c.ok) && record.verdictCode === record.modelReport.verdict
        : null,
      toolErrors: record.toolErrors.length,
      blockedRequests: record.blockedRequests.length,
      screenshots: await checkScreenshots(record),
      exploration: explore(record),
      mismatchAnalysis: record.verdictCode === expected ? null : analyseMismatch(record, expected),
  };
}

function emptyResult(base: Pick<CaseResult, 'caseId' | 'store' | 'complaint' | 'expected' | 'runId'>, harnessError: string, storeCheck = 'failed'): CaseResult {
  return {
    ...base,
    storeCheck,
    runDir: null,
    actual: null,
    match: false,
    endReason: null,
    verdictReasons: [],
    modelProposed: null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    modelRequests: 0,
    failedModelRequests: 0,
    browserToolCalls: 0,
    citations: { total: 0, matched: 0 },
    evidenceChecksPassed: null,
    toolErrors: 0,
    blockedRequests: 0,
    screenshots: null,
    exploration: null,
    mismatchAnalysis: null,
    harnessError,
  };
}

const cents = (money: string | undefined) => {
  const match = /^\$(\d+)\.(\d{2})$/.exec(money ?? '');
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
};
const dollars = (value: number) => `$${(value / 100).toFixed(2)}`;

function explore(record: RunRecord): Exploration {
  const field = (o: RunRecord['observations'][number], label: string) => o.fields.find((f) => f.label === label)?.value;
  const quantities = record.observations.map((o) => field(o, 'Quantity') ?? '?');
  const numeric = quantities.map(Number).filter(Number.isFinite);
  const wrongTotals: Exploration['wrongTotals'] = [];
  for (const o of record.observations) {
    const unit = cents(field(o, 'Unit price'));
    const quantity = Number(field(o, 'Quantity'));
    const total = cents(field(o, 'Total'));
    if (unit === null || total === null || !Number.isInteger(quantity)) continue;
    if (total !== unit * quantity) {
      wrongTotals.push({ observation: o.id, quantity: String(quantity), total: dollars(total), expectedTotal: dollars(unit * quantity) });
    }
  }
  return {
    clicks: record.actions.filter((a) => a.kind === 'click' && a.ok).length,
    quantities,
    maxQuantity: numeric.length ? Math.max(...numeric) : null,
    wrongTotals,
  };
}

// Separates "never reached the bug" from "saw the bug and reported otherwise".
function analyseMismatch(record: RunRecord, expected: RunRecord['verdictCode']): string {
  const { maxQuantity, wrongTotals, clicks } = explore(record);
  if (expected === 'reproduced' && record.verdictCode === 'not_reproduced') {
    if (wrongTotals.length === 0) {
      return (
        `Bug not discovered: the run stopped after ${clicks} click(s) at quantity ${maxQuantity}, and every recorded ` +
        `total equals unit price × quantity. The claim matches what it observed; its exploration did not reach the bug.`
      );
    }
    return (
      `Claim contradicts its own evidence: ${wrongTotals.map((w) => `${w.observation} shows quantity ${w.quantity} with total ${w.total} (expected ${w.expectedTotal})`).join('; ')}, ` +
      `yet the run reported Not reproduced.`
    );
  }
  return `Expected ${expected}, got ${record.verdictCode} (end reason ${record.endReason}); see the run record.`;
}

// Every recorded observation must have a readable PNG, and every cited
// observation must be one of them. Whether the image shows the cited values is
// checked by eye on contact-sheet.png.
async function checkScreenshots(record: RunRecord): Promise<ScreenshotCheck> {
  const check: ScreenshotCheck = { observations: record.observations.length, missing: [], invalid: [], citedWithoutScreenshot: [], sizes: {} };
  for (const o of record.observations) {
    try {
      const png = await readFile(join(record.runDir, o.screenshot));
      if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG') {
        check.invalid.push(o.screenshot);
        continue;
      }
      check.sizes[o.screenshot] = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
    } catch {
      check.missing.push(o.screenshot);
    }
  }
  const usable = new Set(record.observations.map((o) => o.id).filter((id) => check.sizes[`${id}.png`]));
  for (const c of record.evidence) if (!usable.has(c.observation_id)) check.citedWithoutScreenshot.push(c.observation_id);
  return check;
}

function markdownTable(rows: CaseResult[]): string {
  const lines = [
    '| Case | Run | Expected | Actual | Match | End reason | Clicks | Quantities seen | Wrong totals recorded | Duration | Tokens in / out | Requests | Evidence checks | Screenshots |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const evidence =
      r.evidenceChecksPassed === null
        ? 'n/a (no report)'
        : `${r.evidenceChecksPassed ? 'passed' : 'FAILED'} (${r.citations.matched}/${r.citations.total} citations)`;
    const shots = r.screenshots
      ? r.screenshots.missing.length || r.screenshots.invalid.length || r.screenshots.citedWithoutScreenshot.length
        ? `PROBLEM: missing ${r.screenshots.missing.join(',') || '-'}, invalid ${r.screenshots.invalid.join(',') || '-'}`
        : `${r.screenshots.observations} ok`
      : 'n/a';
    lines.push(
      `| ${r.caseId} | ${r.runId} | ${r.expected} | ${r.actual ?? `harness error: ${r.harnessError}`} | ${r.match ? 'yes' : 'NO'} | ` +
        `${r.endReason ?? '-'} | ${r.exploration?.clicks ?? '-'} | ${r.exploration?.quantities.join(' → ') || '-'} | ` +
        `${r.exploration ? (r.exploration.wrongTotals.map((w) => `${w.observation}: qty ${w.quantity}, ${w.total}`).join('; ') || 'none') : '-'} | ` +
        `${r.durationMs === null ? '-' : `${(r.durationMs / 1000).toFixed(1)} s`} | ` +
        `${r.inputTokens.toLocaleString('en-US')} / ${r.outputTokens.toLocaleString('en-US')} | ` +
        `${r.modelRequests}${r.failedModelRequests ? ` (${r.failedModelRequests} failed)` : ''} | ${evidence} | ${shots} |`,
    );
  }
  const analyses = rows.filter((r) => r.mismatchAnalysis);
  if (analyses.length) {
    lines.push('', '**Mismatches**', '', ...analyses.map((r) => `- ${r.caseId} (${r.runId}): ${r.mismatchAnalysis}`));
  }
  return lines.join('\n');
}

// One page showing each run's cited observations next to their screenshots,
// rendered to a PNG for review.
async function writeContactSheet(rows: CaseResult[], evalDir: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const sections: string[] = [];
  for (const r of rows) {
    if (!r.runDir) continue;
    const record = JSON.parse(await readFile(join(repoRoot, r.runDir, 'run.json'), 'utf8')) as RunRecord;
    const cited = new Set(record.evidence.map((c) => c.observation_id));
    const shown = record.observations.filter((o) => cited.has(o.id) || cited.size === 0);
    const cells = await Promise.all(
      shown.map(async (o) => {
        const file = join(r.runDir!, o.screenshot);
        const exists = await stat(join(repoRoot, file)).then(() => true, () => false);
        const citations = record.evidence.filter((c) => c.observation_id === o.id);
        return `<figure><img src="${esc(`${r.runId}/${o.screenshot}`)}" alt="">${exists ? '' : '<b>MISSING</b>'}
          <figcaption><b>${esc(o.id)}</b> after ${esc(o.trigger)}<br>
          recorded: ${esc(o.fields.map((f) => `${f.label}: ${f.value}`).join(' | '))}<br>
          cited: ${esc(citations.map((c) => `${c.label}: ${c.value}${c.ok ? '' : ' (MISMATCH)'}`).join(' | ') || 'none')}</figcaption></figure>`;
      }),
    );
    sections.push(`<section><h2>${esc(r.caseId)} · ${esc(r.runId)} · expected ${esc(r.expected)} · actual ${esc(r.actual ?? '-')}</h2>
      <p>${esc(r.complaint)}</p><div class="row">${cells.join('')}</div></section>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Evaluation contact sheet</title><style>
    body{font:13px system-ui,sans-serif;margin:16px;background:#fff;color:#111}
    section{border-top:1px solid #ccc;padding:8px 0} h2{font-size:14px;margin:4px 0} p{margin:2px 0 6px;color:#555}
    .row{display:flex;gap:12px;flex-wrap:wrap} figure{margin:0;width:300px} img{width:300px;border:1px solid #999;display:block}
    figcaption{font-size:11px;margin-top:3px}</style>${sections.join('')}`;
  const htmlPath = join(evalDir, 'contact-sheet.html');
  await writeFile(htmlPath, html);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(`file://${htmlPath}`);
    await page.screenshot({ path: join(evalDir, 'contact-sheet.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}

// Command line entry point. Kept at the end of the module so every helper above
// is initialized before it runs.
if (import.meta.main && process.argv[2] === '--summarize') {
  if (!process.argv[3]) {
    console.error('Usage: npm run eval -- --summarize runs/eval-<...>');
    process.exit(2);
  }
  await summarizeExisting(resolve(process.argv[3]));
} else if (import.meta.main) {
  const suiteName = process.argv[2] ?? 'original';
  const cases = SUITES[suiteName];
  if (!cases) {
    console.error(`Unknown suite "${suiteName}". Available: ${Object.keys(SUITES).join(', ')}`);
    process.exit(2);
  }
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(`Evaluation blocked: ${loaded.problems.join('; ')}. See .env.example.`);
    process.exit(2);
  }
  const summary = await runEvaluation({
    provider: createAnthropicProvider(loaded.config.apiKey),
    settings: loaded.config.settings,
    evalDir: join(repoRoot, 'runs', `eval-${suiteName === 'original' ? '' : `${suiteName}-`}${timestamp()}`),
    cases,
    suite: suiteName,
  });
  process.exitCode = summary.matched === summary.total ? 0 : 1;
}
