// A one-sentence finding derived from a run's recorded observations, never
// from the model's description. It uses the same demo-scoped pricing
// assumption as cart-pricing-rule.ts (one item; no discounts, tax or shipping,
// so Total = Unit price × Quantity), states that the expectation is inferred,
// and names the observations that show it. Outside that scope there is no
// finding.
import type { RecordedObservation } from './browser-session.ts';
import { checkCartPricing } from './cart-pricing-rule.ts';

export type Finding =
  | {
      kind: 'total_not_updated' | 'totals_consistent';
      text: string;
      // Where the expected values come from; they are inferred, not observed.
      inferredExpectation: string;
      // The observations that show the finding, for the default comparison.
      before: string;
      after: string;
    }
  | { kind: 'none'; text: string };

const ASSUMPTION = 'assuming one item and no discounts, tax or shipping';

export function deriveFinding(complaint: string, observations: RecordedObservation[]): Finding {
  const pricing = checkCartPricing(complaint, observations);
  if (!pricing.applies) return { kind: 'none', text: `No finding derived from the observations: ${pricing.why}.` };

  const value = (o: RecordedObservation, label: string) => o.fields.find((f) => f.label === label)!.value;
  const first = pricing.contradictions[0];
  if (first) {
    const index = observations.findIndex((o) => o.id === first.observation);
    const after = observations[index];
    const before = observations[index - 1];
    const inferredExpectation =
      `${first.expectedTotal} is inferred, not stated in the report: Unit price ${first.unitPrice} × Quantity ${first.quantity}, ${ASSUMPTION}.`;
    if (!before) {
      return {
        kind: 'total_not_updated',
        text: `The page opened with Quantity ${first.quantity} and Total ${first.total} instead of ${first.expectedTotal}.`,
        inferredExpectation,
        before: after.id,
        after: after.id,
      };
    }
    const [q0, t0] = [value(before, 'Quantity'), value(before, 'Total')];
    const totalPart = t0 === first.total ? `Total stayed at ${first.total}` : `Total changed to ${first.total}`;
    const text =
      q0 === String(first.quantity)
        ? `${after.id} shows Quantity ${first.quantity} with Total ${first.total} instead of ${first.expectedTotal}.`
        : `Quantity changed from ${q0} to ${first.quantity}, but ${totalPart} instead of reaching ${first.expectedTotal}.`;
    return { kind: 'total_not_updated', text, inferredExpectation, before: before.id, after: after.id };
  }

  const quantities = [...new Set(observations.map((o) => value(o, 'Quantity')))];
  if (quantities.length < 2) {
    return { kind: 'none', text: `Only quantity ${quantities.join(', ')} was observed, so no change could be compared.` };
  }
  const [start, end] = [observations[0], observations.at(-1)!];
  return {
    kind: 'totals_consistent',
    text:
      `Every observed total matched unit price × quantity: Quantity ${value(start, 'Quantity')} → ${value(end, 'Quantity')}, ` +
      `Total ${value(start, 'Total')} → ${value(end, 'Total')}.`,
    inferredExpectation: `"Matched" is judged against an inferred expectation: Total = Unit price × Quantity, ${ASSUMPTION}.`,
    before: start.id,
    after: end.id,
  };
}
