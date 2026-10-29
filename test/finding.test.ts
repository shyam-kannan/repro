// Unit tests for the evidence-derived finding. No browser or model involved.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RecordedObservation } from '../src/browser-session.ts';
import { deriveFinding } from '../src/finding.ts';

const CART = 'When I increase the quantity in my cart, the total stays the same.';
const obs = (id: string, quantity: string, total: string, extra: [string, string][] = []) =>
  ({
    id,
    fields: [['Unit price', '$20.00'], ['Quantity', quantity], ['Total', total], ...extra].map(([label, value]) => ({ label, value, path: '' })),
  }) as unknown as RecordedObservation;

describe('deriveFinding', () => {
  test('names the step where the total stops matching, with the inferred expectation', () => {
    const finding = deriveFinding(CART, [obs('obs-1', '1', '$20.00'), obs('obs-2', '2', '$40.00'), obs('obs-3', '3', '$40.00')]);
    assert.deepEqual(finding, {
      kind: 'total_not_updated',
      text: 'Quantity changed from 2 to 3, but Total stayed at $40.00 instead of reaching $60.00.',
      inferredExpectation:
        '$60.00 is inferred, not stated in the report: Unit price $20.00 × Quantity 3, assuming one item and no discounts, tax or shipping.',
      before: 'obs-2',
      after: 'obs-3',
    });
  });

  test('a total that changes to the wrong value is described as changed, not stayed', () => {
    const finding = deriveFinding(CART, [obs('obs-1', '1', '$20.00'), obs('obs-2', '2', '$30.00')]);
    assert.equal(finding.text, 'Quantity changed from 1 to 2, but Total changed to $30.00 instead of reaching $40.00.');
  });

  test('consistent totals over several quantities', () => {
    const finding = deriveFinding(CART, [obs('obs-1', '1', '$20.00'), obs('obs-2', '2', '$40.00')]);
    assert.equal(finding.kind, 'totals_consistent');
    assert.equal(finding.text, 'Every observed total matched unit price × quantity: Quantity 1 → 2, Total $20.00 → $40.00.');
  });

  test('no finding outside the demo pricing scope', () => {
    assert.equal(deriveFinding('Searching for headphones returns no results.', [obs('obs-1', '1', '$20.00')]).kind, 'none');
    assert.equal(deriveFinding(CART, [obs('obs-1', '3', '$65.00', [['Shipping', '$5.00']])]).kind, 'none');
    assert.equal(deriveFinding(CART, []).kind, 'none');
    assert.equal(deriveFinding(CART, [obs('obs-1', '1', '$20.00')]).text, 'Only quantity 1 was observed, so no change could be compared.');
  });
});
