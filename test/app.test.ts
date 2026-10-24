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
import type { ModelProvider } from '../src/provider.ts';
import {
  cartInvestigatorDouble,
  twoClickNotReproducedDouble,
  scriptedProvider,
  startStore,
  tempRunsDir,
  TEST_DOUBLE_NAME,
  testSettings,
} from './helpers.ts';

const COMPLAINT = 'When I increase the quantity in my cart, the total stays the same.';
// Screenshots of the UI for manual review; outside the repository.
const SHOT_DIR = process.env.REPRO_UI_SHOT_DIR;

let store: { url: string; close: () => void };
let browser: Browser;

before(async () => {
  store = await startStore('faulty');
  browser = await chromium.launch();
});
after(async () => {
  store.close();
  await browser.close();
});

type Harness = { base: string; repro: ReproServer; runsDir: string; close: () => Promise<void> };

async function startRepro(
  provider: ModelProvider | null,
  options: { runsDir?: string; deadlineMs?: number; watchdogGraceMs?: number; storeUrl?: string } = {},
): Promise<Harness> {
  const runsDir = options.runsDir ?? (await tempRunsDir());
  const repro = await createReproServer({
    provider,
    configProblems: provider ? [] : ['REPRO_ANTHROPIC_API_KEY is not set'],
    settings: provider ? testSettings(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) : null,
    storeUrl: options.storeUrl ?? store.url,
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

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify(body),
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
      await page.getByRole('button', { name: COMPLAINT }).click();
      assert.equal(await page.getByLabel('Complaint').inputValue(), COMPLAINT);
      await shoot(page, '1-home');
      await page.getByRole('button', { name: 'Investigate' }).click();

      await page.waitForURL(/\/runs\/run-[0-9a-f]{8}$/);
      // Progress appears while the run is still in progress.
      await page.getByText('Recorded obs-1:').waitFor();
      assert.equal(await page.locator('.verdict.running').count(), 1);
      await page.getByText(/Model chose to click button “Increase quantity”/).waitFor();
      await shoot(page, '2-progress');

      const verdict = page.locator('.verdict[data-verdict]');
      await verdict.waitFor({ timeout: 20_000 });
      assert.equal(await verdict.getAttribute('data-verdict'), 'reproduced');
      assert.match(await verdict.innerText(), /Reproduced/);
      await page.getByText('This run used a scripted test double, not a real model').waitFor();
      await page.getByText('Expected behavior · inferred by the model').waitFor();
      await page.getByText('The total should equal unit price times quantity.').waitFor();

      const headers = await page.locator('table.obs thead th').allInnerTexts();
      assert.deepEqual(headers.map((t) => t.split('\n')[0]), ['Label', 'obs-1', 'obs-2']);
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
      await page.getByText(/Activity log \(12 recorded events\)/).waitFor();
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
      await page.getByLabel('Complaint').fill(hostile);
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
      await page.getByText('Recorded obs-1:').waitFor();
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
  let fromThree: { url: string; close: () => void };
  before(async () => {
    fromThree = await startStore('faulty-from-3');
  });
  after(() => fromThree.close());

  async function runThroughUi(provider: ModelProvider, name: string) {
    const h = await startRepro(provider, { storeUrl: fromThree.url });
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
      assert.match(text, /Covered in this run: Tested quantities: 1, 2, 3\. Clicked button “Increase quantity” twice\./);
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
      const coverage = await page.locator('.verdict .coverage').innerText();
      assert.match(coverage, /^Covered in this run: Tested quantities: 1, 2\. Clicked button “Increase quantity” once\./);
      assert.match(coverage, /applies only to the states listed/);

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
      assert.match(await page.locator('.verdict .coverage').innerText(), /Tested quantities: 1, 2\. Clicked button “Increase quantity” once\./);
      assert.equal(await readFile(file, 'utf8'), legacyText, 'the saved record is not rewritten');
    } finally {
      await close();
    }
  });
});
