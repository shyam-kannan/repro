// Offline tests for the evaluation harness. The model is a scripted TEST
// DOUBLE; these results check the harness, not the model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ModelProvider } from '../src/provider.ts';
import { CASES, FAULTY_FROM_3_CASES, runEvaluation } from '../scripts/eval.ts';
import { FIXTURES } from '../demo-store/pricing.ts';
import { identifyStore, startStore, unavailableStoreUrl } from '../scripts/harness.ts';
import {
  cartInvestigatorDouble,
  elementNamed,
  latestObservation,
  reply,
  tempRunsDir,
  TEST_DOUBLE_NAME,
  testSettings,
  toolUse,
  valueOf,
  type ModelObservation,
} from './helpers.ts';

// The cart double keeps per-run state, so start a fresh one for each run.
function perRunCartDouble(): ModelProvider {
  let current = cartInvestigatorDouble();
  return {
    name: TEST_DOUBLE_NAME,
    createMessage(request, options) {
      if (request.messages.length === 1) current = cartInvestigatorDouble();
      return current.createMessage(request, options);
    },
  };
}

describe('store checks', () => {
  test('identifies each fixture from its pricing, and rejects other servers', async () => {
    for (const fixture of FIXTURES) {
      const store = await startStore(fixture);
      try {
        assert.equal(await identifyStore(store.url), fixture);
      } finally {
        store.close();
      }
    }
    const other = createServer((_req, res) => res.end('<p>Increase quantity</p>'));
    other.listen(0, '127.0.0.1');
    await once(other, 'listening');
    try {
      await assert.rejects(identifyStore(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`));
    } finally {
      other.close();
    }
  });

  test('the unavailable-store URL refuses connections', async () => {
    const url = await unavailableStoreUrl();
    await assert.rejects(fetch(url), (error: { cause?: { code?: string } }) => error.cause?.code === 'ECONNREFUSED');
  });
});

describe('evaluation pipeline (test double)', () => {
  test('runs cases, keeps mismatches, checks screenshots and writes the summary', async () => {
    const evalDir = join(await tempRunsDir(), 'eval');
    const cases = CASES.filter((c) => ['correct-1', 'faulty-1', 'store-unavailable', 'unrelated-complaint'].includes(c.id));
    const summary = await runEvaluation({ provider: perRunCartDouble(), settings: testSettings(), evalDir, cases, log: () => {} });

    assert.equal(summary.provider, TEST_DOUBLE_NAME);
    const byId = Object.fromEntries(summary.results.map((r) => [r.caseId, r]));
    assert.equal(byId['correct-1'].actual, 'Not reproduced in this run');
    assert.equal(byId['faulty-1'].actual, 'Reproduced');
    assert.match(byId['correct-1'].storeCheck, /^correct store confirmed/);
    assert.match(byId['faulty-1'].storeCheck, /^faulty store confirmed/);
    for (const id of ['correct-1', 'faulty-1']) {
      assert.equal(byId[id].match, true);
      assert.equal(byId[id].evidenceChecksPassed, true);
      assert.deepEqual(byId[id].screenshots?.missing, []);
      assert.equal(byId[id].screenshots?.sizes['obs-1.png'], '800x600');
    }

    const unavailable = byId['store-unavailable'];
    assert.match(unavailable.storeCheck, /^connection refused/);
    assert.equal(unavailable.actual, 'Inconclusive');
    assert.equal(unavailable.endReason, 'store_unreachable');
    assert.equal(unavailable.modelRequests, 0);
    assert.equal(unavailable.evidenceChecksPassed, null);

    // The cart double answers every complaint the same way, so this case is
    // a mismatch. It must be kept and reported, not dropped.
    const unrelated = byId['unrelated-complaint'];
    assert.equal(unrelated.match, false);
    assert.equal(summary.matched, 3);

    const lines = (await readFile(join(evalDir, 'results.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 4);
    const markdown = await readFile(join(evalDir, 'summary.md'), 'utf8');
    assert.match(markdown, /3\/4 verdicts matched/);
    assert.match(markdown, /\| unrelated-complaint \| run-[0-9a-f]{8} \| Inconclusive \| Not reproduced in this run \| NO \|/);
    assert.ok((await stat(join(evalDir, 'contact-sheet.png'))).size > 10_000);
  });
});

describe('faulty-from-3 analysis (test double)', () => {
  // Clicks twice, then claims Not reproduced while its own observations show the bug.
  function contradictingDouble(): ModelProvider {
    let seen: ModelObservation[] = [];
    return {
      name: TEST_DOUBLE_NAME,
      async createMessage(request) {
        if (request.messages.length === 1) seen = [];
        const observation = latestObservation(request);
        seen.push(observation);
        if (seen.length <= 2) return reply([toolUse('click_element', { element_id: elementNamed(observation, 'Increase quantity') })]);
        const cite = (o: ModelObservation, label: string) => ({ observation_id: o.observation_id, label, value: valueOf(o, label) });
        return reply([
          toolUse('finish_investigation', {
            verdict: 'not_reproduced',
            expected_behavior: 'The total increases when the quantity increases.',
            assumptions: [],
            observed_behavior: 'The total changed after increasing the quantity.',
            evidence: [cite(seen[0], 'Quantity'), cite(seen[0], 'Total'), cite(seen[2], 'Quantity'), cite(seen[2], 'Total')],
            explanation: 'Compared first and last observation.',
          }),
        ]);
      },
    };
  }

  test('a one-click run that misses the bug is "not discovered"; a claim against recorded evidence is downgraded', async () => {
    const cases = FAULTY_FROM_3_CASES.filter((c) => c.id === 'faulty-from-3-1' || c.id === 'correct-control');
    const missed = await runEvaluation({
      provider: perRunCartDouble(),
      settings: testSettings(),
      evalDir: join(await tempRunsDir(), 'eval'),
      cases,
      log: () => {},
    });
    const [oneClick, control] = missed.results;
    assert.match(oneClick.storeCheck, /^faulty-from-3 store confirmed/);
    assert.equal(oneClick.actual, 'Not reproduced in this run');
    assert.equal(oneClick.match, false);
    assert.deepEqual(oneClick.exploration?.quantities, ['1', '2']);
    assert.deepEqual(oneClick.exploration?.wrongTotals, []);
    assert.match(oneClick.mismatchAnalysis ?? '', /^Bug not discovered: the run stopped after 1 click\(s\) at quantity 2/);
    assert.equal(control.match, true);
    assert.equal(control.mismatchAnalysis, null);

    const contradicted = await runEvaluation({
      provider: contradictingDouble(),
      settings: testSettings(),
      evalDir: join(await tempRunsDir(), 'eval'),
      cases: cases.slice(0, 1),
      log: () => {},
    });
    const [run] = contradicted.results;
    assert.equal(run.actual, 'Inconclusive', 'the demo cart pricing rule downgrades the contradicted claim');
    assert.equal(run.modelProposed, 'not_reproduced');
    assert.equal(run.downgradeRule, 'demo_cart_total_equals_unit_price_times_quantity');
    assert.deepEqual(run.exploration?.quantities, ['1', '2', '3']);
    assert.deepEqual(run.exploration?.wrongTotals, [{ observation: 'obs-3', quantity: '3', total: '$40.00', expectedTotal: '$60.00' }]);
    assert.match(run.mismatchAnalysis ?? '', /^Claim contradicted its own evidence and was downgraded: the model proposed not_reproduced, final verdict inconclusive\./);
    assert.match(run.mismatchAnalysis ?? '', /obs-3 shows Quantity 3 and Unit price \$20\.00, so Total should be \$60\.00, but it shows Total \$40\.00/);

    // The command line path, run as a real process: rebuilds the summary from the
    // saved records without investigating (this path once failed on init order).
    const evalDir = join(run.runDir!, '..');
    // No REPRO_* variables: summarizing needs no credentials.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('REPRO_')));
    const cli = spawnSync(process.execPath, ['scripts/eval.ts', '--summarize', evalDir], { encoding: 'utf8', env });
    assert.equal(cli.status, 0, cli.stderr);
    const rebuilt = JSON.parse(await readFile(join(evalDir, 'summary.json'), 'utf8'));
    assert.match(rebuilt.note, /no investigations were run/);
    assert.equal(rebuilt.suite, 'faulty-from-3');
    assert.equal(rebuilt.results[0].mismatchAnalysis, run.mismatchAnalysis);
    assert.deepEqual(rebuilt.results[0].exploration, run.exploration);
  });
});
