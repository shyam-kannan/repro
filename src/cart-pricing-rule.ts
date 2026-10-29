// A deliberately narrow consistency rule for this demo's cart complaint.
//
// The demo cart has one line item and no discounts, tax, shipping or fees, so
// its total should equal unit price × quantity. When a run reports "Not
// reproduced" for a complaint about the total and quantity, but one of its own
// recorded observations shows a different total, the report contradicts its
// evidence and the verdict is downgraded to Inconclusive.
//
// This is NOT a general pricing rule. It applies only when:
//   - the complaint mentions both the total and the quantity, and
//   - every recorded observation shows exactly one "Unit price", "Quantity" and
//     "Total" field, parsable as dollars and a whole number, and
//   - no observation shows a label suggesting other price components
//     (discount, tax, shipping, fee, subtotal, coupon, ...).
// Otherwise it reports itself as not applicable and changes nothing. It reads
// browser observations only: never the fixture name or the store's pricing code.
import type { RecordedObservation } from './browser-session.ts';

export const CART_PRICING_RULE = 'demo_cart_total_equals_unit_price_times_quantity';

export const CART_PRICING_ASSUMPTION =
  'demo cart pricing assumption: one line item, no discounts, tax, shipping or fees, so Total = Unit price × Quantity';

const COMPLAINT_SCOPE = { total: /\btotals?\b/i, quantity: /\bquantit(y|ies)\b/i };
const OTHER_PRICE_COMPONENTS = /discount|tax|vat|shipping|delivery|fee|subtotal|coupon|promo|savings|surcharge/i;

export type CartPricingCheck =
  | { applies: false; why: string }
  | { applies: true; contradictions: { observation: string; quantity: number; unitPrice: string; total: string; expectedTotal: string }[] };

export function checkCartPricing(complaint: string, observations: RecordedObservation[]): CartPricingCheck {
  if (!COMPLAINT_SCOPE.total.test(complaint) || !COMPLAINT_SCOPE.quantity.test(complaint)) {
    return { applies: false, why: 'the complaint is not about the cart total and quantity' };
  }
  if (observations.length === 0) return { applies: false, why: 'no observations were recorded' };

  const contradictions: Extract<CartPricingCheck, { applies: true }>['contradictions'] = [];
  for (const o of observations) {
    const other = o.fields.find((f) => OTHER_PRICE_COMPONENTS.test(f.label));
    if (other) return { applies: false, why: `${o.id} shows "${other.label}", outside the demo pricing assumption` };
    const single = (label: string) => {
      const matches = o.fields.filter((f) => f.label === label);
      return matches.length === 1 ? matches[0].value : null;
    };
    const unit = cents(single('Unit price'));
    const total = cents(single('Total'));
    const quantityText = single('Quantity');
    const quantity = quantityText !== null && /^\d+$/.test(quantityText) ? Number(quantityText) : null;
    if (unit === null || total === null || quantity === null) {
      return { applies: false, why: `${o.id} does not show exactly one Unit price, Quantity and Total` };
    }
    if (total !== unit * quantity) {
      contradictions.push({
        observation: o.id,
        quantity,
        unitPrice: dollars(unit),
        total: dollars(total),
        expectedTotal: dollars(unit * quantity),
      });
    }
  }
  return { applies: true, contradictions };
}

// The downgrade reason, naming each contradicting observation and its values.
export function describeContradictions(check: Extract<CartPricingCheck, { applies: true }>): string {
  const details = check.contradictions
    .map((c) => `${c.observation} shows Quantity ${c.quantity} and Unit price ${c.unitPrice}, so Total should be ${c.expectedTotal}, but it shows Total ${c.total}`)
    .join('; ');
  return `The model reported "Not reproduced", but its own recorded observations contradict that under the ${CART_PRICING_ASSUMPTION}: ${details}.`;
}

function cents(money: string | null): number | null {
  const match = /^\$(\d+)\.(\d{2})$/.exec(money ?? '');
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
}

function dollars(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}
