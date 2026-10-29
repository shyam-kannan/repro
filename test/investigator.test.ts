// Offline tests for the investigator. Every model response here comes from a
// scripted TEST DOUBLE (see helpers.ts); no request reaches a real model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { investigate, type InvestigationEvent, type InvestigatorDeps, type RunRecord } from '../src/investigator.ts';
import type { InvestigatorSettings } from '../src/config.ts';
import {
  cartInvestigatorDouble,
  elementNamed,
  latestObservation,
  reply,
  scriptedProvider,
  startStore,
  tempRunsDir,
  TEST_DOUBLE_NAME,
  testSettings,
  toolUse,
  trackedLaunch,
  twoClickNotReproducedDouble,
  type ScriptedProvider,
} from './helpers.ts';
import { checkCartPricing } from '../src/cart-pricing-rule.ts';
import type { RecordedObservation } from '../src/browser-session.ts';

const COMPLAINT = 'When I increase the quantity in my cart, the total stays the same.';

let faultyStore: { url: string; close: () => void };
let correctStore: { url: string; close: () => void };
let runsDir: string;

before(async () => {
  faultyStore = await startStore('faulty');
  correctStore = await startStore('correct');
  runsDir = await tempRunsDir();
});
after(() => {
  faultyStore.close();
  correctStore.close();
});

async function run(
  provider: ScriptedProvider | InvestigatorDeps['provider'],
  options: { storeUrl?: string; settings?: Partial<InvestigatorSettings>; retryBaseDelayMs?: number } = {},
): Promise<{ record: RunRecord; browsersClosed: boolean }> {
  const { browsers, launch } = trackedLaunch();
  const record = await investigate(
    { complaint: COMPLAINT, storeUrl: options.storeUrl ?? faultyStore.url },
    {
      provider,
      settings: testSettings(options.settings),
      runsDir,
      launchBrowser: launch,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 10,
    },
  );
  return { record, browsersClosed: browsers.every((b) => !b.isConnected()) };
}

const finish = (input: object) => reply([toolUse('finish_investigation', input)]);
const baseReport = {
  expected_behavior: 'The total increases with quantity.',
  assumptions: [],
  observed_behavior: 'n/a',
  explanation: 'n/a',
};

describe('tool execution', () => {
  test('model-chosen click on the faulty store yields Reproduced with validated evidence', async () => {
    const provider = cartInvestigatorDouble();
    const { record, browsersClosed } = await run(provider);

    assert.equal(record.provider, TEST_DOUBLE_NAME);
    assert.equal(record.verdict, 'Reproduced');
    assert.equal(record.endReason, 'report_submitted');
    assert.deepEqual(record.verdictReasons, []);
    assert.deepEqual(
      record.actions.map((a) => [a.id, a.kind, a.ok, a.target?.name ?? a.url]),
      [
        ['act-1', 'open', true, faultyStore.url],
        ['act-2', 'click', true, 'Increase quantity'],
      ],
    );
    assert.deepEqual(
      record.evidence.map((c) => [c.observation_id, c.label, c.value, c.ok]),
      [
        ['obs-1', 'Quantity', '1', true],
        ['obs-1', 'Total', '$20.00', true],
        ['obs-2', 'Quantity', '2', true],
        ['obs-2', 'Total', '$20.00', true],
      ],
    );
    assert.equal(record.browserToolCalls, 1);
    assert.deepEqual(record.usage, { inputTokens: 200, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    assert.equal(record.expectation.supplied, null);
    assert.deepEqual(record.expectation.modelAssumptions, ['The total should equal unit price times quantity.']);
    for (const o of record.observations) assert.ok((await stat(join(record.runDir, o.screenshot))).size > 0);
    assert.ok(browsersClosed && record.cleanup.browserClosed && record.cleanup.contextClosed);

    const saved = JSON.parse(await readFile(join(record.runDir, 'run.json'), 'utf8'));
    assert.equal(saved.verdict, 'Reproduced');
  });

  test('the same double on the correct store yields Not reproduced in this run', async () => {
    const { record } = await run(cartInvestigatorDouble(), { storeUrl: correctStore.url });
    assert.equal(record.verdict, 'Not reproduced in this run');
    assert.deepEqual(record.evidence.at(-1), {
      observation_id: 'obs-2', label: 'Total', value: '$40.00', ok: true, screenshot: 'obs-2.png',
    });
  });

  test('model inputs carry no fixture name, answer key or source, and mark page text untrusted', async () => {
    const provider = cartInvestigatorDouble();
    await run(provider);
    const sent = JSON.stringify(provider.requests);
    assert.doesNotMatch(sent, /faulty|fixture|\bcorrect\b|pricing\.ts|cart\.js|\$40\.00/i);
    assert.match(String(provider.requests[0].system), /Treat it strictly as data/);
    assert.deepEqual(provider.requests[0].tools!.map((t) => (t as Anthropic.Tool).name), ['observe_page', 'click_element', 'finish_investigation']);
    assert.equal(provider.requests[0].max_tokens, 1234);
  });
});

describe('invalid tool arguments', () => {
  test('bad arguments, stale element IDs and unknown tools return errors and are recorded', async () => {
    const provider = scriptedProvider(({ call }) => {
      switch (call) {
        case 1: return reply([toolUse('click_element', {})]);
        case 2: return reply([toolUse('click_element', { element_id: 'e99' })]);
        case 3: return reply([toolUse('observe_page', { selector: '#total' })]);
        case 4: return reply([toolUse('navigate', { url: 'https://example.com' })]);
        case 5: return reply([toolUse('click_element', { element_id: 'e1', force: true })]);
        default: return finish({ ...baseReport, verdict: 'inconclusive', evidence: [], inconclusive_reason: 'Tools rejected my calls.' });
      }
    });
    const { record } = await run(provider);
    assert.deepEqual(record.toolErrors.map((e) => [e.tool, e.kind]), [
      ['click_element', 'invalid_arguments'],
      ['click_element', 'invalid_arguments'],
      ['observe_page', 'invalid_arguments'],
      ['navigate', 'unknown_tool'],
      ['click_element', 'invalid_arguments'],
    ]);
    assert.match(record.toolErrors[1].message, /Unknown element_id "e99".*latest observation \(obs-1\)/);
    const results = provider.requests.slice(1).map((r) => (r.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]);
    assert.ok(results.every((r) => r.is_error === true));
    assert.equal(record.browserToolCalls, 5);
    assert.equal(record.actions.filter((a) => a.kind === 'click').length, 0);
    assert.equal(record.verdict, 'Inconclusive');
    assert.deepEqual(record.verdictReasons, ['Investigator reported: Tools rejected my calls.']);
  });

  test('a malformed report is returned for correction once, then ends the run', async () => {
    const provider = scriptedProvider(() => finish({ verdict: 'maybe', evidence: 'none' }));
    const { record } = await run(provider);
    assert.equal(provider.requests.length, 2);
    assert.equal(record.endReason, 'malformed_report');
    assert.equal(record.verdict, 'Inconclusive');
    assert.match(record.verdictReasons[0], /verdict must be/);
  });
});

describe('missing or mismatched evidence', () => {
  // Clicks Increase quantity once, then submits the given report.
  const clickThenReport = (report: object) =>
    scriptedProvider(({ request, call }) =>
      call === 1
        ? reply([toolUse('click_element', { element_id: elementNamed(latestObservation(request), 'Increase quantity') })])
        : finish({ ...baseReport, ...report }),
    );

  test('Reproduced without any action is downgraded', async () => {
    const provider = scriptedProvider(() =>
      finish({
        ...baseReport,
        verdict: 'reproduced',
        evidence: [
          { observation_id: 'obs-1', label: 'Quantity', value: '1' },
          { observation_id: 'obs-1', label: 'Total', value: '$20.00' },
        ],
      }),
    );
    const { record } = await run(provider);
    assert.equal(record.verdict, 'Inconclusive');
    assert.match(record.verdictReasons[0], /No action on the page succeeded/);
  });

  test('a value quoted under the wrong label is rejected even though it appears on the page', async () => {
    const { record } = await run(
      clickThenReport({
        verdict: 'reproduced',
        evidence: [
          { observation_id: 'obs-1', label: 'Quantity', value: '1' },
          { observation_id: 'obs-1', label: 'Total', value: '$20.00' },
          { observation_id: 'obs-2', label: 'Quantity', value: '2' },
          { observation_id: 'obs-2', label: 'Total', value: '$40.00' },
          { observation_id: 'obs-2', label: 'Unit price', value: '$40.00' },
        ],
      }),
      { storeUrl: faultyStore.url },
    );
    assert.equal(record.verdict, 'Inconclusive');
    assert.deepEqual(record.verdictReasons, [
      'Evidence did not match the recorded page: obs-2 shows "Total: $20.00", not "$40.00".',
      'Evidence did not match the recorded page: obs-2 shows "Unit price: $20.00", not "$40.00".',
    ]);
  });

  test('citations to missing observations or labels are rejected', async () => {
    const { record } = await run(
      clickThenReport({
        verdict: 'reproduced',
        evidence: [
          { observation_id: 'obs-9', label: 'Total', value: '$20.00' },
          { observation_id: 'obs-2', label: 'Subtotal', value: '$20.00' },
        ],
      }),
    );
    assert.deepEqual(record.evidence.map((c) => c.problem), ['no observation obs-9', 'obs-2 has no field labeled "Subtotal"']);
    assert.equal(record.verdict, 'Inconclusive');
  });

  test('a click with only after-click evidence does not establish reproduction', async () => {
    const { record } = await run(
      clickThenReport({
        verdict: 'reproduced',
        evidence: [
          { observation_id: 'obs-2', label: 'Quantity', value: '2' },
          { observation_id: 'obs-2', label: 'Total', value: '$20.00' },
        ],
      }),
    );
    assert.equal(record.verdict, 'Inconclusive');
    assert.match(record.verdictReasons[0], /does not show the scenario was exercised/);
  });

  test('Not reproduced without before-and-after evidence of a change is downgraded', async () => {
    const { record } = await run(
      clickThenReport({
        verdict: 'not_reproduced',
        evidence: [
          { observation_id: 'obs-1', label: 'Total', value: '$20.00' },
          { observation_id: 'obs-2', label: 'Total', value: '$40.00' },
        ],
      }),
      { storeUrl: correctStore.url },
    );
    assert.equal(record.verdict, 'Inconclusive');
    assert.match(record.verdictReasons[0], /proposed: not_reproduced/);
  });
});

describe('limits', () => {
  test('the 16th browser tool call ends the run as Inconclusive without executing', async () => {
    const provider = scriptedProvider(() => reply([toolUse('observe_page', {})]));
    const { record, browsersClosed } = await run(provider);
    assert.equal(record.endReason, 'browser_tool_limit');
    assert.equal(record.verdict, 'Inconclusive');
    assert.equal(record.browserToolCalls, 15);
    assert.equal(record.observations.length, 16); // initial page load + 15 observe_page calls
    assert.ok(browsersClosed);
  });

  test('the deadline interrupts a hanging model request and cleans up', async () => {
    let abortedSeen = false;
    const provider = scriptedProvider(
      ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            abortedSeen = true;
            reject(new Anthropic.APIUserAbortError());
          }),
        ),
    );
    const { record, browsersClosed } = await run(provider, { settings: { deadlineMs: 2_500 } });
    assert.equal(record.endReason, 'deadline');
    assert.equal(record.verdict, 'Inconclusive');
    assert.ok(record.durationMs < 2_500 + 1_000, `took ${record.durationMs}ms`);
    assert.ok(abortedSeen);
    assert.equal(record.providerCalls[0].error?.kind, 'DeadlineExceeded');
    assert.ok(browsersClosed);
  });

  test('provider retries stop rather than wait past the deadline', async () => {
    const provider = scriptedProvider(() => {
      throw new Anthropic.InternalServerError(500, undefined, 'overloaded', new Headers());
    });
    const { record } = await run(provider, { settings: { deadlineMs: 2_500, maxProviderRetries: 5 }, retryBaseDelayMs: 1_000 });
    assert.equal(record.endReason, 'provider_error');
    assert.ok(record.durationMs < 2_500, `took ${record.durationMs}ms`);
    assert.ok(record.providerCalls.length < 6, 'retry budget not exhausted because the deadline was closer');
  });

  test('a response cut off by the output-token limit ends the run as Inconclusive', async () => {
    const provider = scriptedProvider(() => reply([{ type: 'text', text: 'Thinking about' }], 'max_tokens'));
    const { record } = await run(provider, { settings: { maxOutputTokens: 64 } });
    assert.equal(provider.requests[0].max_tokens, 64);
    assert.equal(record.endReason, 'output_token_limit');
    assert.match(record.verdictReasons[0], /output-token limit \(64\)/);
  });
});

describe('provider failures', () => {
  test('retryable failures are retried, recorded, and the run continues', async () => {
    const double = cartInvestigatorDouble();
    let failures = 0;
    const provider = scriptedProvider(async (ctx) => {
      if (failures < 2) {
        failures++;
        throw new Anthropic.APIConnectionError({ message: 'Connection error.' });
      }
      return double.createMessage(ctx.request, { signal: ctx.signal, timeoutMs: 1_000 });
    });
    const { record } = await run(provider);
    assert.equal(record.verdict, 'Reproduced');
    assert.deepEqual(record.providerCalls.map((c) => [c.attempt, c.ok, c.error?.kind]), [
      [1, false, 'APIConnectionError'],
      [2, false, 'APIConnectionError'],
      [3, true, undefined],
      [1, true, undefined],
    ]);
  });

  test('an authentication error is not retried and yields Inconclusive', async () => {
    const provider = scriptedProvider(() => {
      throw new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers());
    });
    const { record, browsersClosed } = await run(provider);
    assert.equal(record.endReason, 'provider_error');
    assert.equal(record.providerCalls.length, 1);
    assert.match(record.verdictReasons[0], /AuthenticationError 401/);
    assert.ok(browsersClosed);
  });

  test('persistent server errors exhaust the retry budget', async () => {
    const provider = scriptedProvider(() => {
      throw new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers());
    });
    const { record } = await run(provider);
    assert.equal(record.providerCalls.length, 3); // first attempt + 2 retries
    assert.match(record.verdictReasons[0], /after 3 attempt\(s\)/);
  });

  test('a refusal ends the run as Inconclusive', async () => {
    const { record } = await run(scriptedProvider(() => reply([], 'refusal')));
    assert.equal(record.endReason, 'model_refusal');
    assert.equal(record.verdict, 'Inconclusive');
  });

  test('a model that stops without a report is reminded once, then the run ends', async () => {
    const provider = scriptedProvider(() => reply([{ type: 'text', text: 'The cart looks fine.' }]));
    const { record } = await run(provider);
    assert.equal(provider.requests.length, 2);
    assert.equal(record.endReason, 'no_report');
  });
});

describe('browser cleanup and isolation', () => {
  test('an unexpected exception still closes the browser and saves the run', async () => {
    const provider = scriptedProvider(() => {
      throw new TypeError('provider exploded');
    });
    const { record, browsersClosed } = await run(provider);
    assert.equal(record.endReason, 'provider_error');
    assert.ok(browsersClosed);
    assert.ok((await stat(join(record.runDir, 'run.json'))).size > 0);
  });

  test('an unreachable store is Inconclusive, closes the browser, and never calls the model', async () => {
    const provider = scriptedProvider(() => reply([]));
    const { record, browsersClosed } = await run(provider, { storeUrl: 'http://127.0.0.1:9/' });
    assert.equal(record.endReason, 'store_unreachable');
    assert.equal(provider.requests.length, 0);
    assert.ok(browsersClosed);
  });

  test('each run starts with fresh browser state', async () => {
    const first = await run(cartInvestigatorDouble());
    const second = await run(cartInvestigatorDouble());
    for (const { record } of [first, second]) {
      assert.equal(record.observations[0].fields.find((f) => f.label === 'Quantity')?.value, '1');
    }
  });

  test('requests and navigation to other origins are blocked and recorded', async () => {
    let offsiteHits = 0;
    const offsite = createServer((_, res) => {
      offsiteHits++;
      res.end('offsite');
    });
    offsite.listen(0, '127.0.0.1');
    await once(offsite, 'listening');
    const offsiteUrl = `http://127.0.0.1:${(offsite.address() as AddressInfo).port}`;
    const page = createServer((_, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Origin test</title>
        <img src="${offsiteUrl}/pixel.png" alt="">
        <button onclick="fetch('${offsiteUrl}/beacon').catch(() => {})">Send beacon</button>
        <a href="${offsiteUrl}/elsewhere">Leave store</a>`);
    });
    page.listen(0, '127.0.0.1');
    await once(page, 'listening');
    const pageUrl = `http://127.0.0.1:${(page.address() as AddressInfo).port}/`;

    try {
      const provider = scriptedProvider(({ request, call }) => {
        const observation = latestObservation(request);
        if (call === 1) return reply([toolUse('click_element', { element_id: elementNamed(observation, 'Send beacon') })]);
        if (call === 2) return reply([toolUse('click_element', { element_id: elementNamed(observation, 'Leave store') })]);
        return finish({ ...baseReport, verdict: 'inconclusive', evidence: [], inconclusive_reason: 'Origin test.' });
      });
      const { record, browsersClosed } = await run(provider, { storeUrl: pageUrl });
      assert.equal(offsiteHits, 0);
      const blocked = record.blockedRequests.map((b) => new URL(b.url).pathname).sort();
      assert.deepEqual(blocked, ['/beacon', '/elsewhere', '/pixel.png']);
      assert.ok(browsersClosed);
    } finally {
      offsite.close();
      page.close();
    }
  });
});

describe('progress events', () => {
  test('events mirror the recorded run, and a throwing listener cannot change it', async () => {
    const events: InvestigationEvent[] = [];
    const { browsers, launch } = trackedLaunch();
    const record = await investigate(
      { complaint: COMPLAINT, storeUrl: faultyStore.url },
      {
        provider: cartInvestigatorDouble(),
        settings: testSettings(),
        runsDir,
        launchBrowser: launch,
        onEvent: (event) => {
          events.push(event);
          throw new Error('listener failure');
        },
      },
    );
    assert.equal(record.verdict, 'Reproduced');
    assert.equal(record.endReason, 'report_submitted');
    assert.ok(browsers.every((b) => !b.isConnected()));
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.action.id] : []));
    const observations = events.flatMap((e) => (e.type === 'observation' ? [e.observation.id] : []));
    assert.deepEqual(actions, record.actions.map((a) => a.id));
    assert.deepEqual(observations, record.observations.map((o) => o.id));
    const finished = events.filter((e) => e.type === 'model_request_finished');
    assert.equal(finished.length, record.providerCalls.length);
    assert.deepEqual(events.at(-1), {
      type: 'run_finished',
      at: record.finishedAt,
      verdict: 'Reproduced',
      verdictCode: 'reproduced',
      endReason: 'report_submitted',
    });
  });
});

describe('coverage and the demo cart pricing rule', () => {
  let fromThreeStore: { url: string; close: () => void };
  before(async () => {
    fromThreeStore = await startStore('faulty-from-3');
  });
  after(() => fromThreeStore.close());

  test('a contradicted "Not reproduced" is downgraded, naming the observation and values', async () => {
    const { record } = await run(twoClickNotReproducedDouble(), { storeUrl: fromThreeStore.url });
    assert.equal(record.proposedVerdict, 'not_reproduced');
    assert.equal(record.verdictCode, 'inconclusive');
    assert.equal(record.verdict, 'Inconclusive');
    assert.ok(record.evidence.every((c) => c.ok), 'every citation is valid; only uncited obs-3 contradicts');
    assert.deepEqual(record.downgrade && { ...record.downgrade, reasons: record.downgrade.reasons.length }, {
      from: 'not_reproduced',
      to: 'inconclusive',
      rule: 'demo_cart_total_equals_unit_price_times_quantity',
      reasons: 1,
    });
    assert.equal(
      record.verdictReasons[0],
      'The model reported "Not reproduced", but its own recorded observations contradict that under the demo cart ' +
        'pricing assumption: one line item, no discounts, tax, shipping or fees, so Total = Unit price × Quantity: ' +
        'obs-3 shows Quantity 3 and Unit price $20.00, so Total should be $60.00, but it shows Total $40.00.',
    );
    assert.equal(record.coverage.summary, 'Tested quantities: 1, 2, 3. Clicked button “Increase quantity” twice.');
    assert.equal(record.modelReport?.verdict, 'not_reproduced', 'the model report itself is preserved');
  });

  test('a valid negative that only explored quantities 1 and 2 keeps its verdict and states its coverage', async () => {
    const { record } = await run(cartInvestigatorDouble(), { storeUrl: fromThreeStore.url });
    assert.equal(record.verdictCode, 'not_reproduced', 'limited coverage alone is not a downgrade');
    assert.equal(record.proposedVerdict, 'not_reproduced');
    assert.equal(record.downgrade, null);
    assert.deepEqual(record.cartPricingCheck, { applies: true, contradictions: [] });
    assert.deepEqual(record.coverage.quantitiesObserved, ['1', '2']);
    assert.equal(record.coverage.summary, 'Tested quantities: 1, 2. Clicked button “Increase quantity” once.');
  });

  test('the rule does not apply to a complaint about something else', async () => {
    const provider = twoClickNotReproducedDouble();
    const { browsers, launch } = trackedLaunch();
    const record = await investigate(
      { complaint: 'Searching for headphones returns no results.', storeUrl: fromThreeStore.url },
      { provider, settings: testSettings(), runsDir, launchBrowser: launch },
    );
    assert.ok(browsers.every((b) => !b.isConnected()));
    assert.equal(record.verdictCode, 'not_reproduced');
    assert.equal(record.downgrade, null);
    assert.deepEqual(record.cartPricingCheck, { applies: false, why: 'the complaint is not about the cart total and quantity' });
  });
});

describe('checkCartPricing scope', () => {
  const observation = (id: string, fields: [string, string][]) =>
    ({ id, fields: fields.map(([label, value]) => ({ label, value, path: '' })) }) as unknown as RecordedObservation;
  const cartComplaint = 'When I increase the quantity in my cart, the total stays the same.';

  test('flags a total that differs from unit price × quantity', () => {
    const result = checkCartPricing(cartComplaint, [
      observation('obs-1', [['Unit price', '$20.00'], ['Quantity', '2'], ['Total', '$40.00']]),
      observation('obs-2', [['Unit price', '$20.00'], ['Quantity', '3'], ['Total', '$40.00']]),
    ]);
    assert.deepEqual(result, {
      applies: true,
      contradictions: [{ observation: 'obs-2', quantity: 3, unitPrice: '$20.00', total: '$40.00', expectedTotal: '$60.00' }],
    });
  });

  test('does not apply when the page shows other price components', () => {
    for (const label of ['Shipping', 'Tax', 'Discount', 'Subtotal', 'Coupon savings']) {
      const result = checkCartPricing(cartComplaint, [
        observation('obs-1', [['Unit price', '$20.00'], ['Quantity', '3'], [label, '$5.00'], ['Total', '$65.00']]),
      ]);
      assert.equal(result.applies, false, label);
    }
  });

  test('does not apply to multiple line items or unreadable values', () => {
    assert.equal(
      checkCartPricing(cartComplaint, [
        observation('obs-1', [['Unit price', '$20.00'], ['Quantity', '1'], ['Unit price', '$5.00'], ['Quantity', '1'], ['Total', '$25.00']]),
      ]).applies,
      false,
    );
    assert.equal(
      checkCartPricing(cartComplaint, [observation('obs-1', [['Unit price', '20 EUR'], ['Quantity', '1'], ['Total', '20 EUR']])]).applies,
      false,
    );
  });
});
