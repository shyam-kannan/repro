// Offline tests for the Repro web UI and its server. Every model response
// comes from a scripted TEST DOUBLE (see helpers.ts), and every run page it
// produces carries the test-double banner. Nothing here calls a real model.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser, type Page } from 'playwright';
import { createReproServer, type ReproServer } from '../app/server.ts';
import { SCENARIOS, type Scenario } from '../app/scenarios.ts';
import type { ModelProvider } from '../src/provider.ts';
import {
  cartInvestigatorDouble,
  elementNamed,
  latestObservation,
  reply,
  toolUse,
  valueOf,
  type ModelObservation,
  twoClickNotReproducedDouble,
  scriptedProvider,
  startStore,
  tempRunsDir,
  TEST_DOUBLE_NAME,
  testSettings,
} from './helpers.ts';

const COMPLAINT = 'When I increase the quantity in my cart, the total stays the same.';
// "Before: <step label>" / "After: <step label>" for the two compared screenshots.
const pairLabels = (page: Page) =>
  page.locator('figure.shot').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.role}: ${(e as HTMLElement).dataset.label}`));
// The finding sentence and its inferred-expectation note, read separately.
const findingText = (page: Page) => page.locator('.verdict .finding .finding-text').innerText();
const inferredNote = (page: Page) => page.locator('.verdict .finding .inferred-note').innerText();
const coverageText = (page: Page) => page.locator('.verdict .coverage .coverage-text').innerText();
// Screenshots of the UI for manual review; outside the repository.
const SHOT_DIR = process.env.REPRO_UI_SHOT_DIR;

// One store per demo scenario, shared by every test server.
let stores: { scenario: Scenario; url: string; close: () => void }[];
let browser: Browser;
// Most tests use this scenario (the "faulty" fixture).
const DEFAULT_SCENARIO = 'total-never-updates';

before(async () => {
  stores = await Promise.all(SCENARIOS.map(async (scenario) => ({ scenario, ...(await startStore(scenario.fixture)) })));
  browser = await chromium.launch();
});
after(async () => {
  for (const s of stores) s.close();
  await browser.close();
});

type Harness = { base: string; repro: ReproServer; runsDir: string; close: () => Promise<void> };

async function startRepro(
  provider: ModelProvider | null,
  options: { runsDir?: string; deadlineMs?: number; watchdogGraceMs?: number; defaultScenario?: string } = {},
): Promise<Harness> {
  const runsDir = options.runsDir ?? (await tempRunsDir());
  const repro = await createReproServer({
    provider,
    configProblems: provider ? [] : ['REPRO_ANTHROPIC_API_KEY is not set'],
    settings: provider ? testSettings(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) : null,
    stores: stores.map(({ scenario, url }) => ({ scenario, url })),
    defaultScenario: options.defaultScenario ?? DEFAULT_SCENARIO,
    runsDir,
    watchdogGraceMs: options.watchdogGraceMs,
  });
  repro.server.listen(0, '127.0.0.1');
  await once(repro.server, 'listening');
  const base = `http://127.0.0.1:${(repro.server.address() as AddressInfo).port}`;
  return {
    base,
    repro,
    runsDir,
    close: async () => {
      await repro.idle();
      repro.server.close();
      repro.server.closeAllConnections();
    },
  };
}

const post = (base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify({ scenario: DEFAULT_SCENARIO, ...body }),
  });

async function waitForState(base: string, runId: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const data = await (await fetch(`${base}/api/runs/${runId}`)).json();
    if (data.status.state !== 'running') return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('run did not finish');
}

// A test double that waits for `release()` before its first reply.
function gatedDouble() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = cartInvestigatorDouble();
  const provider: ModelProvider = {
    name: TEST_DOUBLE_NAME,
    async createMessage(request, options) {
      await gate;
      return inner.createMessage(request, options);
    },
  };
  return { provider, release };
}

// The cart double with a pause before each reply, so progress is observable.
function slowDouble(delayMs: number): ModelProvider {
  const inner = cartInvestigatorDouble();
  return {
    name: TEST_DOUBLE_NAME,
    async createMessage(request, options) {
      await new Promise((r) => setTimeout(r, delayMs));
      return inner.createMessage(request, options);
    },
  };
}

const authFailure = () =>
  scriptedProvider(() => {
    throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
  });

describe('server API', () => {
  test('a run streams recorded events, saves its report and can be reopened', async () => {
    const h = await startRepro(cartInvestigatorDouble());
    try {
      const response = await post(h.base, { complaint: COMPLAINT });
      assert.equal(response.status, 202);
      const { runId, state } = await response.json();
      assert.match(runId, /^run-[0-9a-f]{8}$/);
      assert.equal(state, 'running');

      const data = await waitForState(h.base, runId);
      assert.equal(data.status.state, 'finished');
      assert.equal(data.status.verdict, 'Reproduced');
      assert.equal(data.record.provider, TEST_DOUBLE_NAME);
      assert.equal(data.record.runDir, undefined, 'server paths are not exposed');
      const types = data.events.map((e: { type: string }) => e.type);
      assert.deepEqual(types, [
        'run_started',
        'action',
        'observation',
        'model_request_started',
        'model_request_finished',
        'browser_tool_requested',
        'action',
        'observation',
        'model_request_started',
        'model_request_finished',
        'report_submitted',
        'run_finished',
      ]);
      const requested = data.events.find((e: { type: string }) => e.type === 'browser_tool_requested');
      assert.deepEqual(requested.target, { role: 'button', name: 'Increase quantity', fromObservation: 'obs-1' });
      assert.ok(!JSON.stringify(data.events).includes('"text"'), 'no model text is streamed');

      // Reopen: the SSE stream of a finished run replays events and ends with its status.
      const sse = await (await fetch(`${h.base}/api/runs/${runId}/events`)).text();
      const messages = sse.trim().split('\n\n').map((m) => JSON.parse(m.replace(/^data: /, '')));
      assert.equal(messages.length, data.events.length + 1);
      assert.equal(messages.at(-1).status.state, 'finished');

      const shot = await fetch(`${h.base}/api/runs/${runId}/obs-1.png`);
      assert.equal(shot.status, 200);
      assert.equal(shot.headers.get('content-type'), 'image/png');
      assert.ok((await shot.arrayBuffer()).byteLength > 1000);

      const saved = await readFile(join(h.runsDir, runId, 'events.jsonl'), 'utf8');
      assert.equal(saved.trim().split('\n').length, data.events.length);
      const listed = await (await fetch(`${h.base}/api/runs`)).json();
      assert.equal(listed.runs[0].runId, runId);
    } finally {
      await h.close();
    }
  });

  test('a second investigation is refused while one is running', async () => {
    const { provider, release } = gatedDouble();
    const h = await startRepro(provider);
    try {
      const first = await (await post(h.base, { complaint: COMPLAINT })).json();
      const second = await post(h.base, { complaint: 'Another complaint.' });
      assert.equal(second.status, 409);
      const body = await second.json();
      assert.equal(body.activeRunId, first.runId);
      assert.match(body.error, /already running/);
      const status = await (await fetch(`${h.base}/api/status`)).json();
      assert.equal(status.activeRunId, first.runId);
      release();
      await waitForState(h.base, first.runId);
      await h.repro.idle();
      assert.equal((await post(h.base, { complaint: COMPLAINT })).status, 202);
    } finally {
      release();
      await h.close();
    }
  });

  test('a model API failure is saved as Inconclusive with the provider error', async () => {
    const h = await startRepro(authFailure());
    try {
      const { runId } = await (await post(h.base, { complaint: COMPLAINT })).json();
      const data = await waitForState(h.base, runId);
      assert.equal(data.status.state, 'finished');
      assert.equal(data.record.verdictCode, 'inconclusive');
      assert.equal(data.record.endReason, 'provider_error');
      assert.match(data.record.verdictReasons[0], /AuthenticationError 401/);
      assert.equal(data.record.providerCalls.length, 1, 'a 401 is not retried');
    } finally {
      await h.close();
    }
  });

  test('a run that outlives the watchdog is marked failed and keeps the lock until it settles', async () => {
    const { provider, release } = gatedDouble();
    // A negative grace makes the watchdog fire 100 ms into the run.
    const h = await startRepro(provider, { deadlineMs: 5_000, watchdogGraceMs: -4_900 });
    try {
      const { runId } = await (await post(h.base, { complaint: COMPLAINT })).json();
      const data = await waitForState(h.base, runId);
      assert.equal(data.status.state, 'failed');
      assert.match(data.status.error, /did not finish within its deadline/);
      const blocked = await post(h.base, { complaint: COMPLAINT });
      assert.equal(blocked.status, 409);
      assert.match((await blocked.json()).error, /still shutting down/);
      release();
      await h.repro.idle();
      const after = await (await fetch(`${h.base}/api/runs/${runId}`)).json();
      assert.equal(after.status.state, 'failed', 'the late result does not overwrite the failure');
    } finally {
      release();
      await h.close();
    }
  });

  test('a run left running by a stopped server is marked interrupted on startup', async () => {
    const runsDir = await tempRunsDir();
    const dir = join(runsDir, 'run-0000abcd');
    await mkdir(dir);
    await writeFile(
      join(dir, 'status.json'),
      JSON.stringify({ runId: 'run-0000abcd', state: 'running', complaint: COMPLAINT, startedAt: new Date().toISOString() }),
    );
    const h = await startRepro(cartInvestigatorDouble(), { runsDir });
    try {
      const data = await (await fetch(`${h.base}/api/runs/run-0000abcd`)).json();
      assert.equal(data.status.state, 'interrupted');
      assert.equal(data.record, null);
    } finally {
      await h.close();
    }
  });

  test('input, origin, host and path checks', async () => {
    const h = await startRepro(cartInvestigatorDouble());
    try {
      assert.equal((await post(h.base, { complaint: '   ' })).status, 400);
      assert.equal((await post(h.base, { complaint: 'x'.repeat(2_001) })).status, 400);
      assert.equal((await post(h.base, { complaint: 'x', expectedBehavior: 5 })).status, 400);
      assert.equal((await post(h.base, { complaint: COMPLAINT }, { Origin: 'http://evil.example' })).status, 403);
      // fetch() cannot override Host, so this request goes through node:http.
      const rebound = await new Promise<number>((resolve, reject) =>
        request(`${h.base}/api/status`, { headers: { Host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        })
          .on('error', reject)
          .end(),
      );
      assert.equal(rebound, 421);
      for (const path of [
        '/.env',
        '/package.json',
        '/app/server.ts',
        '/api/runs/run-0000abcd',
        '/api/runs/..%2F..%2F.env',
        '/api/runs/run-0000abcd/run.json',
        '/api/runs/run-0000abcd/transcript.json',
        '/api/runs/run-0000abcd/status.json',
        '/api/runs/run-0000abcd/obs-1.png',
      ]) {
        assert.equal((await fetch(`${h.base}${path}`)).status, 404, path);
      }
      const page = await fetch(`${h.base}/`);
      assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    } finally {
      await h.close();
    }
  });

  test('without configuration the UI loads but investigations are refused', async () => {
    const h = await startRepro(null);
    try {
      const status = await (await fetch(`${h.base}/api/status`)).json();
      assert.equal(status.configured, false);
      const response = await post(h.base, { complaint: COMPLAINT });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /REPRO_ANTHROPIC_API_KEY is not set/);
    } finally {
      await h.close();
    }
  });
});

describe('browser flow (test double)', () => {
  async function newPage(): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => assert.fail(`page error: ${error.message}`));
    return page;
  }
  const shoot = async (page: Page, name: string) => {
    if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
  };

  test('investigate from the example, follow live progress, read the report, reload it', async () => {
    const h = await startRepro(slowDouble(700));
    const page = await newPage();
    try {
      await page.goto(`${h.base}/`);
      await page.getByText('Repro takes a plain-English bug report').waitFor();
      assert.equal(await page.locator('label.scenario').count(), 3);
      assert.equal(await page.getByRole('radio', { name: /^Total never updates/ }).isChecked(), true, 'server default is preselected');
      await page.getByRole('button', { name: COMPLAINT }).click();
      assert.equal(await page.getByLabel('Bug report').inputValue(), COMPLAINT);
      await shoot(page, '1-home');
      await page.getByRole('button', { name: 'Investigate' }).click();

      await page.waitForURL(/\/runs\/run-[0-9a-f]{8}$/);
      // Progress appears while the run is still in progress.
      await page.getByText('Recorded the page (obs-1)').waitFor();
      assert.equal(await page.locator('.verdict.running').count(), 1);
      // While the model is asked for its next step, that row is the current one.
      await page.locator('ol.timeline li[data-state="current"]', { hasText: 'Waiting for the model' }).first().waitFor();
      await page.getByText(/^Clicked button “Increase quantity”$/).waitFor();
      assert.equal(await page.locator('ol.timeline li[data-state="current"]').count() <= 1, true, 'at most one current step');
      await shoot(page, '2-progress');

      const verdict = page.locator('.verdict[data-verdict]');
      await verdict.waitFor({ timeout: 20_000 });
      assert.equal(await verdict.getAttribute('data-verdict'), 'reproduced');
      assert.match(await verdict.innerText(), /Reproduced/);
      await page.getByText('This run used a scripted test double, not a real model').waitFor();

      // Summary at the top: verdict, the finding from recorded evidence, coverage.
      assert.equal(await findingText(page), 'Quantity changed from 1 to 2, but Total stayed at $20.00 instead of reaching $40.00.');
      assert.equal(
        await inferredNote(page),
        '$40.00 is inferred, not stated in the report: Unit price $20.00 × Quantity 2, assuming one item and no discounts, tax or shipping.',
      );
      assert.equal(await coverageText(page), 'Tested quantities: 1, 2. Clicked button “Increase quantity” once.');
      const order = await page.evaluate(() =>
        [...document.querySelectorAll('#app > section, #app > details')].map((el) => (el as HTMLElement).dataset.section ?? el.className),
      );
      assert.deepEqual(order, ['verdict reproduced', 'report', 'evidence', 'steps', 'model', 'citations', 'run-details', 'activity']);
      assert.equal(await page.locator('[data-section="report"] .demo-setup .scenario-name').innerText(), 'Total never updates');

      // Secondary material is collapsed until opened.
      for (const section of ['model', 'citations', 'run-details', 'activity']) {
        assert.equal(await page.locator(`details[data-section="${section}"]`).getAttribute('open'), null, section);
      }
      assert.equal(await page.getByText('The total should equal unit price times quantity.').isVisible(), false);
      await page.locator('details[data-section="model"] > summary').click();
      await page.getByText('Expected behavior · inferred by the model (not stated in the report)').waitFor();
      await page.getByText('The total should equal unit price times quantity.').waitFor();

      // Readable step labels, with observation IDs kept alongside.
      const headers = await page.locator('table.obs thead th').allInnerTexts();
      assert.deepEqual(headers.map((t) => t.split('\n')), [['Value'], ['Page opened', 'obs-1'], ['After the first increase', 'obs-2']]);
      assert.deepEqual(await pairLabels(page), ['Before: Page opened', 'After: After the first increase']);
      const totalRow = await page.locator('table.obs tbody tr', { hasText: 'Total' }).locator('td').allInnerTexts();
      assert.deepEqual(totalRow.map((t) => t.split(/\s*cited/)[0].trim()), ['$20.00', '$20.00']);
      assert.equal(await page.locator('table.obs tbody tr', { hasText: 'Quantity' }).locator('td.changed').count(), 1);
      const actions = await page.locator('ol.actions li').allInnerTexts();
      assert.equal(actions.length, 2);
      assert.match(actions[1], /Clicked button “Increase quantity”/);

      // Every screenshot on the page actually loads.
      await page.waitForFunction(() => [...document.images].every((img) => img.complete));
      const broken = await page.evaluate(() => [...document.images].filter((img) => img.naturalWidth === 0).length);
      assert.equal(broken, 0);
      assert.equal(await page.locator('figure.shot').count(), 2);
      assert.ok(!(await page.locator('body').innerText()).includes('[object'), 'no unrendered nodes');
      await shoot(page, '3-report');

      const url = page.url();
      await page.reload();
      await page.locator('.verdict[data-verdict="reproduced"]').waitFor();
      assert.equal(await page.locator('details[data-section="activity"] .summary-meta').innerText(), '12 recorded events');
      const reopened = await newPage();
      await reopened.goto(url);
      await reopened.locator('.verdict[data-verdict="reproduced"]').waitFor();
      await reopened.context().close();

      await page.goto(`${h.base}/`);
      await page.locator('.run-list a', { hasText: COMPLAINT }).waitFor();
    } finally {
      await page.context().close();
      await h.close();
    }
  });

  test('the form explains when a run is already active', async () => {
    const { provider, release } = gatedDouble();
    const h = await startRepro(provider);
    const page = await newPage();
    try {
      await (await post(h.base, { complaint: COMPLAINT })).json();
      await page.goto(`${h.base}/`);
      await page.getByText('An investigation is running. This local version runs one at a time.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Investigate' }).isDisabled(), true);
    } finally {
      release();
      await page.context().close();
      await h.close();
    }
  });

  test('a failed model call, an interrupted run and hostile text are shown plainly', async () => {
    const runsDir = await tempRunsDir();
    await mkdir(join(runsDir, 'run-0000beef'));
    await writeFile(
      join(runsDir, 'run-0000beef', 'status.json'),
      JSON.stringify({ runId: 'run-0000beef', state: 'running', complaint: COMPLAINT, startedAt: new Date().toISOString() }),
    );
    const h = await startRepro(authFailure(), { runsDir });
    const page = await newPage();
    try {
      const hostile = '<img src=x onerror="window.__pwned=1"> total wrong';
      await page.goto(`${h.base}/`);
      await page.getByLabel('Bug report').fill(hostile);
      await page.getByRole('button', { name: 'Investigate' }).click();
      const verdict = page.locator('.verdict[data-verdict]');
      await verdict.waitFor({ timeout: 20_000 });
      assert.equal(await verdict.getAttribute('data-verdict'), 'inconclusive');
      assert.match(await verdict.innerText(), /Model API failure/);
      assert.match(await verdict.innerText(), /AuthenticationError 401/);
      assert.equal(await page.locator('blockquote.complaint').innerText(), hostile);
      assert.equal(await page.locator('blockquote.complaint img').count(), 0);
      assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined);
      assert.equal(await page.locator('.spinner').count(), 0);
      await shoot(page, '4-api-failure');
      assert.ok(!(await page.locator('body').innerText()).includes('[object'), 'no unrendered nodes');

      await page.goto(`${h.base}/runs/run-0000beef`);
      await page.locator('.verdict.interrupted').waitFor();
      assert.match(await page.locator('.verdict').innerText(), /stopped before this investigation finished/);
      assert.equal(await page.locator('.spinner').count(), 0);
      await shoot(page, '5-interrupted');

      await page.goto(`${h.base}/runs/run-ffffffff`);
      await page.getByText('Run run-ffffffff was not found.').waitFor();
    } finally {
      await page.context().close();
      await h.close();
    }
  });

  test('losing the server mid-run stops the spinner and says so', async () => {
    const { provider, release } = gatedDouble();
    const h = await startRepro(provider);
    const page = await newPage();
    try {
      const { runId } = await (await post(h.base, { complaint: COMPLAINT })).json();
      await page.goto(`${h.base}/runs/${runId}`);
      await page.getByText('Recorded the page (obs-1)').waitFor();
      h.repro.interruptActive('Test: server stopped.');
      h.repro.server.close();
      h.repro.server.closeAllConnections();
      await page.locator('.verdict.interrupted').waitFor({ timeout: 10_000 });
      assert.match(await page.locator('.verdict').innerText(), /Lost contact with the Repro server|Interrupted/);
      assert.equal(await page.locator('.spinner').count(), 0);
    } finally {
      release();
      await page.context().close();
      await h.close().catch(() => {});
    }
  });
});

describe('coverage and downgrade display (test double)', () => {
  async function runThroughUi(provider: ModelProvider, name: string) {
    const h = await startRepro(provider, { defaultScenario: 'total-stops-after-first' });
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => assert.fail(`page error: ${error.message}`));
    await page.goto(`${h.base}/`);
    await page.getByRole('button', { name: COMPLAINT }).click();
    await page.getByRole('button', { name: 'Investigate' }).click();
    const verdict = page.locator('.verdict[data-verdict]');
    await verdict.waitFor({ timeout: 20_000 });
    if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
    return { h, page, verdict, close: async () => { await context.close(); await h.close(); } };
  }

  test('a contradicted claim shows the proposed verdict, final verdict and the contradicting observation', async () => {
    const { page, verdict, close } = await runThroughUi(twoClickNotReproducedDouble(), '6-downgraded');
    try {
      assert.equal(await verdict.getAttribute('data-verdict'), 'inconclusive');
      assert.equal(await page.locator('.verdict .proposed').getAttribute('data-proposed'), 'not_reproduced');
      const text = await verdict.innerText();
      assert.match(text, /Model proposed: Not reproduced in this run → final verdict: Inconclusive/);
      assert.match(text, /Contradicted by its own evidence \(demo cart pricing rule/);
      assert.match(text, /obs-3 shows Quantity 3 and Unit price \$20\.00, so Total should be \$60\.00, but it shows Total \$40\.00/);
      assert.equal(await coverageText(page), 'Tested quantities: 1, 2, 3. Clicked button “Increase quantity” twice.');
      assert.equal(await findingText(page), 'Quantity changed from 2 to 3, but Total stayed at $40.00 instead of reaching $60.00.');
      assert.match(await inferredNote(page), /^\$60\.00 is inferred, not stated in the report/);
      // The comparison opens on the steps just before and after the problem.
      assert.equal(await page.locator('#cmp-before').inputValue(), 'obs-2');
      assert.equal(await page.locator('#cmp-after').inputValue(), 'obs-3');
      assert.deepEqual(await pairLabels(page), ['Before: After the first increase', 'After: After the second increase']);
      assert.deepEqual(await page.locator('figure.shot[data-role="After"] dd.changed .tag').allInnerTexts(), ['different from Before']);
      assert.deepEqual(await page.locator('figure.shot[data-role="After"] dd.changed .value').allInnerTexts(), ['3']);
      // Other steps stay selectable.
      await page.locator('#cmp-before').selectOption('obs-1');
      assert.deepEqual(await pairLabels(page), ['Before: Page opened', 'After: After the second increase']);
      await page.reload();
      await page.locator('.verdict[data-verdict="inconclusive"] .proposed').waitFor();
    } finally {
      await close();
    }
  });

  test('a valid "Not reproduced" shows exactly the quantities it observed', async () => {
    const { h, page, verdict, close } = await runThroughUi(cartInvestigatorDouble(), '7-not-reproduced-coverage');
    try {
      assert.equal(await verdict.getAttribute('data-verdict'), 'not_reproduced');
      assert.equal(await page.locator('.verdict .proposed').count(), 0, 'no downgrade, so no proposed/final line');
      assert.equal(await coverageText(page), 'Tested quantities: 1, 2. Clicked button “Increase quantity” once.');
      assert.match(await page.locator('.verdict .coverage .coverage-note').innerText(), /applies only to the states listed/);

      // A record saved before coverage existed: the server derives it on read
      // and leaves the file untouched.
      const runId = /run-[0-9a-f]{8}/.exec(page.url())![0];
      const file = join(h.runsDir, runId, 'run.json');
      const legacy = JSON.parse(await readFile(file, 'utf8'));
      for (const key of ['coverage', 'proposedVerdict', 'downgrade', 'cartPricingCheck']) delete legacy[key];
      const legacyText = JSON.stringify(legacy, null, 2);
      await writeFile(file, legacyText);
      await page.reload();
      await page.locator('.verdict .coverage').waitFor();
      assert.equal(await coverageText(page), 'Tested quantities: 1, 2. Clicked button “Increase quantity” once.');
      assert.equal(await readFile(file, 'utf8'), legacyText, 'the saved record is not rewritten');
    } finally {
      await close();
    }
  });
});

describe('demo scenarios', () => {
  // Strings the investigator must never see: scenario ids, labels and
  // descriptions, and fixture names.
  const forbidden = SCENARIOS.flatMap((s) => [s.id, s.label, s.description, s.fixture]);
  const leaks = (text: string) => forbidden.filter((f) => text.includes(f));

  test('the scenario is captured at start, saved as demo setup, and kept from the investigator', async () => {
    const provider = cartInvestigatorDouble();
    const h = await startRepro(provider);
    try {
      const unknown = await post(h.base, { complaint: COMPLAINT, scenario: 'no-such-scenario' });
      assert.equal(unknown.status, 400);

      const { runId, scenario } = await (await post(h.base, { complaint: COMPLAINT, scenario: 'total-stops-after-first' })).json();
      assert.deepEqual(scenario, { id: 'total-stops-after-first', label: 'Total stops updating after the first increase' });
      const data = await waitForState(h.base, runId);
      const fromThree = stores.find((s) => s.scenario.id === 'total-stops-after-first')!;
      assert.equal(data.record.input.storeOrigin, new URL(fromThree.url).origin, 'the run used the chosen scenario’s store');
      assert.equal(data.setup.scenario.id, 'total-stops-after-first');
      assert.equal(data.setup.fixture, 'faulty-from-3');
      assert.match(data.setup.storeCheck, /^faulty-from-3 store confirmed at http:\/\/127\.0\.0\.1:\d+\/ before the run$/);
      const saved = JSON.parse(await readFile(join(h.runsDir, runId, 'demo-setup.json'), 'utf8'));
      assert.deepEqual(saved, data.setup);

      // Nothing the investigator saw or produced mentions the scenario.
      assert.deepEqual(leaks(JSON.stringify(provider.requests)), [], 'model requests');
      for (const file of ['run.json', 'transcript.json', 'events.jsonl']) {
        assert.deepEqual(leaks(await readFile(join(h.runsDir, runId, file), 'utf8')), [], file);
      }
    } finally {
      await h.close();
    }
  });

  test('a scenario chosen for the next run does not change the active one', async () => {
    const { provider, release } = gatedDouble();
    const h = await startRepro(provider);
    try {
      const first = await (await post(h.base, { complaint: COMPLAINT, scenario: 'working-cart' })).json();
      const second = await post(h.base, { complaint: COMPLAINT, scenario: 'total-never-updates' });
      assert.equal(second.status, 409);
      release();
      const done = await waitForState(h.base, first.runId);
      assert.equal(done.setup.scenario.id, 'working-cart');
      assert.equal(done.record.verdictCode, 'not_reproduced', 'the working cart was investigated');
      await h.repro.idle();
      const next = await (await post(h.base, { complaint: COMPLAINT, scenario: 'total-never-updates' })).json();
      const nextDone = await waitForState(h.base, next.runId);
      assert.equal(nextDone.setup.scenario.id, 'total-never-updates');
      const again = await (await fetch(`${h.base}/api/runs/${first.runId}`)).json();
      assert.equal(again.setup.scenario.id, 'working-cart', 'the earlier report keeps its original setup');
    } finally {
      release();
      await h.close();
    }
  });

  test('a store that does not serve the chosen scenario stops the run before any model call', async () => {
    const provider = cartInvestigatorDouble();
    const correct = stores.find((s) => s.scenario.fixture === 'correct')!;
    const runsDir = await tempRunsDir();
    const repro = await createReproServer({
      provider,
      settings: testSettings(),
      // Misconfigured on purpose: this scenario points at the working store.
      stores: [{ scenario: SCENARIOS.find((s) => s.id === 'total-never-updates')!, url: correct.url }],
      runsDir,
    });
    repro.server.listen(0, '127.0.0.1');
    await once(repro.server, 'listening');
    const base = `http://127.0.0.1:${(repro.server.address() as AddressInfo).port}`;
    try {
      const { runId } = await (await post(base, { complaint: COMPLAINT })).json();
      const data = await waitForState(base, runId);
      assert.equal(data.status.state, 'failed');
      assert.match(data.status.error, /the demo store for "Total never updates" is not serving that scenario/);
      assert.equal(provider.requests.length, 0);
      assert.equal(data.record, null);
    } finally {
      await repro.idle();
      repro.server.close();
      repro.server.closeAllConnections();
    }
  });

  test('the UI sends the selected scenario; older reports without demo setup still open', async () => {
    const h = await startRepro(cartInvestigatorDouble());
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', (error) => assert.fail(`page error: ${error.message}`));
    try {
      await page.goto(`${h.base}/`);
      await page.getByRole('radio', { name: /^Working cart/ }).check();
      await page.getByRole('button', { name: COMPLAINT }).click();
      await page.getByRole('button', { name: 'Investigate' }).click();
      await page.locator('.verdict[data-verdict]').waitFor({ timeout: 20_000 });
      assert.equal(await page.locator('.verdict').getAttribute('data-verdict'), 'not_reproduced');
      assert.equal(await page.locator('.demo-setup').getAttribute('data-scenario'), 'working-cart');
      assert.equal(await findingText(page), 'Every observed total matched unit price × quantity: Quantity 1 → 2, Total $20.00 → $40.00.');
      const runUrl = page.url();

      // The choice is remembered for the next run, without affecting this report.
      await page.goto(`${h.base}/`);
      assert.equal(await page.getByRole('radio', { name: /^Working cart/ }).isChecked(), true);
      await page.getByRole('radio', { name: /^Total never updates/ }).check();
      await page.goto(runUrl);
      await page.locator('.verdict[data-verdict]').waitFor();
      assert.equal(await page.locator('.demo-setup').getAttribute('data-scenario'), 'working-cart');

      // A report saved before scenarios existed: no demo-setup.json, no scenario in status.
      const runId = /run-[0-9a-f]{8}/.exec(runUrl)![0];
      const dir = join(h.runsDir, runId);
      const { rm } = await import('node:fs/promises');
      await rm(join(dir, 'demo-setup.json'));
      const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
      delete status.scenario;
      await writeFile(join(dir, 'status.json'), JSON.stringify(status));
      await page.reload();
      await page.locator('.verdict[data-verdict="not_reproduced"]').waitFor();
      assert.match(await page.locator('.demo-setup .scenario-name').innerText(), /^Not recorded/);
      assert.match(await findingText(page), /Every observed total matched/);
    } finally {
      await page.close();
      await h.close();
    }
  });
});

describe('evidence display: changes versus contradicted expectations (test double)', () => {
  // Clicks twice, then reports Reproduced with an assumption worded the way a
  // live run worded it ("intermittent"). Model text must stay attributed.
  function twoClickReproducedDouble() {
    const seen: ModelObservation[] = [];
    return scriptedProvider(({ request }) => {
      const observation = latestObservation(request);
      seen.push(observation);
      if (seen.length <= 2) return reply([toolUse('click_element', { element_id: elementNamed(observation, 'Increase quantity') })]);
      const cite = (o: ModelObservation, label: string) => ({ observation_id: o.observation_id, label, value: valueOf(o, label) });
      return reply([
        toolUse('finish_investigation', {
          verdict: 'reproduced',
          expected_behavior: 'The total equals unit price times quantity after each increase.',
          assumptions: ['The bug appears intermittent: the first increase worked and the second did not.'],
          observed_behavior: 'The second increase left the total unchanged.',
          evidence: [cite(seen[1], 'Quantity'), cite(seen[1], 'Total'), cite(seen[2], 'Quantity'), cite(seen[2], 'Total')],
          explanation: 'Quantity rose from 2 to 3 but the total stayed the same.',
        }),
      ]);
    });
  }

  async function runInUi(provider: ModelProvider, scenarioLabel: RegExp, shot: string, complaint = COMPLAINT) {
    const h = await startRepro(provider);
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => assert.fail(`page error: ${error.message}`));
    await page.goto(`${h.base}/`);
    await page.getByRole('radio', { name: scenarioLabel }).check();
    await page.getByLabel('Bug report').fill(complaint);
    await page.getByRole('button', { name: 'Investigate' }).click();
    await page.locator('.verdict[data-verdict]').waitFor({ timeout: 20_000 });
    if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${shot}.png`), fullPage: true });
    return { page, close: async () => { await context.close(); await h.close(); } };
  }
  const caption = (page: Page) => page.locator('[data-section="evidence"] .compare-caption').innerText();
  // The text label on each value marked as contradicting the inferred expectation.
  const flagged = (page: Page, scope: string) => page.locator(`${scope} .contradicts .flag`).allInnerTexts();

  test('working cart: the caption describes the comparison and nothing is flagged as wrong', async () => {
    const { page, close } = await runInUi(twoClickNotReproducedDouble(), /^Working cart/, '8-working-cart');
    try {
      assert.equal(await page.locator('.verdict').getAttribute('data-verdict'), 'not_reproduced');
      const text = await caption(page);
      assert.doesNotMatch(text, /problem/i);
      assert.equal(
        text,
        'Comparing “Page opened” (obs-1) with “After the second increase” (obs-3). Both totals match the inferred expectation (Total = Unit price × Quantity).',
      );
      assert.deepEqual(await flagged(page, 'table.obs'), []);
      assert.deepEqual(await flagged(page, 'figure.shot'), []);
      // Ordinary changes carry a text label, not only a colour.
      assert.deepEqual(await page.locator('table.obs td.changed .tag').allInnerTexts(), Array(4).fill('changed since previous step'));

      await page.locator('#cmp-before').selectOption('obs-2');
      assert.equal(
        await caption(page),
        'Comparing “After the first increase” (obs-2) with “After the second increase” (obs-3). Both totals match the inferred expectation (Total = Unit price × Quantity).',
      );
    } finally {
      await close();
    }
  });

  test('total stops updating: the $40.00 total is marked against the inferred $60.00; model wording stays attributed', async () => {
    const { page, close } = await runInUi(twoClickReproducedDouble(), /^Total stops updating/, '9-faulty-from-3');
    try {
      assert.equal(await page.locator('.verdict').getAttribute('data-verdict'), 'reproduced');
      assert.equal(
        await caption(page),
        'Comparing “After the first increase” (obs-2) with “After the second increase” (obs-3). These are the steps immediately ' +
          'before and after the total first stopped matching the inferred expectation. In obs-3, Total $40.00 does not match the ' +
          'inferred $60.00 (Unit price $20.00 × Quantity 3).',
      );
      // Table: only obs-3's Total is flagged; Quantity 3 is an ordinary change.
      assert.deepEqual(await flagged(page, 'table.obs'), ['✕ Expected $60.00 (inferred)']);
      const totalRow = page.locator('table.obs tbody tr', { hasText: 'Total' }).locator('td');
      assert.equal(await totalRow.nth(2).getAttribute('class'), 'contradicts');
      assert.equal(await totalRow.nth(1).getAttribute('class'), 'changed', '$20 → $40 is an ordinary change');
      const quantityRow = page.locator('table.obs tbody tr', { hasText: 'Quantity' }).locator('td');
      assert.equal(await quantityRow.nth(2).getAttribute('class'), 'changed');

      // Comparison details: the After total is flagged with the same text.
      assert.deepEqual(await flagged(page, 'figure.shot[data-role="After"]'), ['✕ Expected $60.00 (inferred)']);
      assert.match(await page.locator('figure.shot[data-role="After"] dd.contradicts').innerText(), /^\$40\.00\n/);
      assert.match(await totalRow.nth(2).innerText(), /^\$40\.00/);
      assert.deepEqual(await page.locator('figure.shot[data-role="After"] dd.changed .tag').allInnerTexts(), ['different from Before']);
      assert.deepEqual(await flagged(page, 'figure.shot[data-role="Before"]'), []);

      // Changing steps keeps the caption and flags accurate.
      await page.locator('#cmp-after').selectOption('obs-2');
      await page.locator('#cmp-before').selectOption('obs-1');
      assert.equal(
        await caption(page),
        'Comparing “Page opened” (obs-1) with “After the first increase” (obs-2). Both totals match the inferred expectation (Total = Unit price × Quantity).',
      );
      assert.deepEqual(await flagged(page, 'figure.shot'), []);
      await page.locator('#cmp-before').selectOption('obs-3');
      await page.locator('#cmp-after').selectOption('obs-3');
      assert.match(await caption(page), /^Both sides show “After the second increase” \(obs-3\)\. In obs-3, Total \$40\.00 does not match the inferred \$60\.00/);

      // The model's word "intermittent" appears only in the attributed model section.
      const outside = await page.evaluate(() =>
        [...document.querySelectorAll('#app > *')]
          .filter((el) => (el as HTMLElement).dataset.section !== 'model')
          .map((el) => (el as HTMLElement).innerText)
          .join('\n'),
      );
      assert.doesNotMatch(outside, /intermittent/i);
      await page.locator('details[data-section="model"] > summary').click();
      const model = await page.locator('details[data-section="model"]').innerText();
      assert.match(model, /The model’s own words, shown as written\. Repro has not checked them, and they are not findings\./);
      assert.match(model, /Assumptions the model made\n.*The bug appears intermittent: the first increase worked and the second did not\./is);
      if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, '9b-faulty-from-3-model-open.png'), fullPage: true });
    } finally {
      await close();
    }
  });

  test('inconclusive: a failed model call and an out-of-scope complaint flag nothing', async () => {
    const failed = await runInUi(authFailure(), /^Total stops updating/, '10-inconclusive-api');
    try {
      assert.equal(await failed.page.locator('.verdict').getAttribute('data-verdict'), 'inconclusive');
      assert.equal(await caption(failed.page), 'Both sides show “Page opened” (obs-1). Only one observation was recorded.');
      assert.deepEqual(await flagged(failed.page, '[data-section="evidence"]'), []);
    } finally {
      await failed.close();
    }

    // Totals are wrong at quantity 3, but the complaint is not about totals,
    // so the pricing expectation does not apply and nothing is marked.
    const unrelated = await runInUi(twoClickNotReproducedDouble(), /^Total stops updating/, '11-out-of-scope', 'Searching for headphones returns no results.');
    try {
      assert.deepEqual(await flagged(unrelated.page, '[data-section="evidence"]'), []);
      assert.equal(
        await caption(unrelated.page),
        'Comparing “Page opened” (obs-1) with “After the second increase” (obs-3). No pricing expectation was checked for this run: the complaint is not about the cart total and quantity.',
      );
    } finally {
      await unrelated.close();
    }
  });

  test('legends appear only where a flagged value is shown, and follow the selected pair', async () => {
    const working = await runInUi(twoClickNotReproducedDouble(), /^Working cart/, '12-working-legends');
    try {
      assert.equal(await working.page.locator('[data-section="evidence"] .legend .flag').count(), 0, 'nothing flagged, so no flag legend');
      assert.equal(await working.page.locator('.pair-legend').isHidden(), true);
      assert.equal(await working.page.locator('.table-legend .tag').innerText(), 'changed since previous step');
    } finally {
      await working.close();
    }

    const faulty = await runInUi(twoClickReproducedDouble(), /^Total stops updating/, '13-faulty-legends');
    const { page } = faulty;
    try {
      // Default pair includes the flagged obs-3: the comparison legend explains it.
      assert.equal(await page.locator('.pair-legend').isVisible(), true);
      assert.match(await page.locator('.pair-legend').innerText(), /does not match Total = Unit price × Quantity/);
      assert.equal(await page.locator('.table-legend .flag').count(), 1, 'the table contains a flagged value');
      // A pair without the flagged step hides the comparison legend; the table keeps its own.
      await page.locator('#cmp-after').selectOption('obs-2');
      await page.locator('#cmp-before').selectOption('obs-1');
      assert.equal(await page.locator('.pair-legend').isHidden(), true);
      assert.equal(await page.locator('.table-legend .flag').count(), 1);
    } finally {
      await faulty.close();
    }

    const outOfScope = await runInUi(twoClickNotReproducedDouble(), /^Total stops updating/, '14-out-of-scope-legends', 'Searching for headphones returns no results.');
    try {
      assert.equal(await outOfScope.page.locator('[data-section="evidence"] .legend .flag').count(), 0);
      assert.equal(await outOfScope.page.locator('.pair-legend').isHidden(), true);
    } finally {
      await outOfScope.close();
    }
  });

  test('change wording: previous step in the table, the selected Before step in the comparison', async () => {
    const { page, close } = await runInUi(twoClickNotReproducedDouble(), /^Working cart/, '15-change-wording');
    const afterTags = () =>
      page.locator('figure.shot[data-role="After"] dd').evaluateAll((dds) =>
        dds.map((dd) => `${dd.previousElementSibling?.textContent}: ${dd.querySelector('.value')?.textContent}${dd.querySelector('.tag') ? ` (${dd.querySelector('.tag')!.textContent})` : ''}`),
      );
    try {
      // Table: every change is relative to the column on its left.
      assert.deepEqual(await page.locator('table.obs td.changed .tag').allInnerTexts(), Array(4).fill('changed since previous step'));
      assert.equal(await page.locator('[data-section="evidence"] figure .tag', { hasText: 'previous step' }).count(), 0);

      // Nonadjacent (default first → last): relative to Before, not to the previous step.
      assert.deepEqual(await afterTags(), ['Unit price: $20.00', 'Quantity: 3 (different from Before)', 'Total: $60.00 (different from Before)']);

      // Adjacent.
      await page.locator('#cmp-before').selectOption('obs-2');
      assert.deepEqual(await afterTags(), ['Unit price: $20.00', 'Quantity: 3 (different from Before)', 'Total: $60.00 (different from Before)']);

      // Reversed: Before is later than After; the caption says so and tags stay relative to Before.
      await page.locator('#cmp-before').selectOption('obs-3');
      await page.locator('#cmp-after').selectOption('obs-1');
      assert.match(await page.locator('.compare-caption').innerText(), /^Comparing “After the second increase” \(obs-3\) with “Page opened” \(obs-1\)\. Before is a later step than After\./);
      assert.deepEqual(await afterTags(), ['Unit price: $20.00', 'Quantity: 1 (different from Before)', 'Total: $20.00 (different from Before)']);

      // Identical: nothing is marked as different.
      await page.locator('#cmp-after').selectOption('obs-3');
      assert.match(await page.locator('.compare-caption').innerText(), /^Both sides show “After the second increase” \(obs-3\)\./);
      assert.equal(await page.locator('[data-section="evidence"] figure .tag').count(), 0);
      // Unit price never changes, so it is never tagged.
      assert.equal(await page.locator('table.obs tbody tr', { hasText: 'Unit price' }).locator('.tag').count(), 0);
    } finally {
      await close();
    }
  });

  test('keyboard: scenario cards, the screenshot view toggle and comparison menus', async () => {
    const h = await startRepro(twoClickNotReproducedDouble());
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${h.base}/`);
      await page.locator('label.scenario').first().waitFor();
      // Tab from the brand link reaches the checked radio; arrows move the selection.
      await page.locator('a.brand').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).value), 'total-never-updates');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.getByRole('radio', { name: /^Working cart/ }).isChecked(), true);
      assert.deepEqual(
        await page.locator('label.scenario .scenario-state:not([hidden])').evaluateAll((els) => els.map((e) => e.closest('label')!.querySelector('.scenario-label')!.textContent)),
        ['Working cart'],
        'the "Selected" label follows the selection',
      );
      // Focus is visible on the selected card.
      const outline = await page.locator('label.scenario', { hasText: 'Working cart' }).evaluate((el) => getComputedStyle(el).outlineStyle);
      assert.equal(outline, 'solid');

      await page.getByRole('button', { name: COMPLAINT }).click();
      await page.getByRole('button', { name: 'Investigate' }).click();
      await page.locator('.verdict[data-verdict]').waitFor({ timeout: 20_000 });

      // The view toggle is a pair of pressed-state buttons; the screenshot file is unchanged.
      const src = await page.locator('figure.shot[data-role="After"] img').getAttribute('src');
      assert.equal(await page.locator('.pair').getAttribute('class'), 'pair zoomed');
      await page.getByRole('button', { name: 'Whole screenshot' }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.pair').getAttribute('class'), 'pair');
      assert.equal(await page.getByRole('button', { name: 'Whole screenshot' }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByRole('button', { name: 'Top of page' }).getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('figure.shot[data-role="After"] img').getAttribute('src'), src);

      // The menus work from the keyboard and update the caption.
      await page.locator('#cmp-before').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#cmp-before').inputValue(), 'obs-2');
      assert.match(await page.locator('.compare-caption').innerText(), /^Comparing “After the first increase” \(obs-2\)/);
    } finally {
      await context.close();
      await h.close();
    }
  });
});
