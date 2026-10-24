// Offline tests for the evaluation harness. The model is a scripted TEST
// DOUBLE; these results check the harness, not the model.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ModelProvider } from '../src/provider.ts';
import { CASES, runEvaluation } from '../scripts/eval.ts';
import { identifyStore, startStore, unavailableStoreUrl } from '../scripts/harness.ts';
import { cartInvestigatorDouble, tempRunsDir, TEST_DOUBLE_NAME, testSettings } from './helpers.ts';

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
    for (const fixture of ['correct', 'faulty'] as const) {
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
