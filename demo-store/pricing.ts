// Server-side cart pricing. The fixture is chosen when the server starts and
// never reaches the page: all fixtures serve identical HTML and JavaScript.

// correct:       total = unit price × quantity.
// faulty:        total ignores quantity (stays at one unit).
// faulty-from-3: correct up to quantity 2, then the line total stops growing
//                (quantity 3 or more is priced as 2).
export const FIXTURES = ['correct', 'faulty', 'faulty-from-3'] as const;
export type Fixture = (typeof FIXTURES)[number];

export function isFixture(value: unknown): value is Fixture {
  return typeof value === 'string' && (FIXTURES as readonly string[]).includes(value);
}

type CatalogItem = { id: string; name: string; unitPriceCents: number };

const CATALOG: Record<string, CatalogItem> = {
  mug: { id: 'mug', name: 'Ceramic Mug', unitPriceCents: 2000 },
};

export type CartLineInput = { id: string; quantity: number };
export type PricedLine = CatalogItem & { quantity: number };
export type PricedCart = { lines: PricedLine[]; totalCents: number };

export class PricingError extends Error {}

export function priceCart(input: unknown, fixture: Fixture): PricedCart {
  if (!Array.isArray(input) || input.length === 0) {
    throw new PricingError('Cart must be a non-empty array of lines.');
  }
  const lines = input.map((raw: Partial<CartLineInput>): PricedLine => {
    const item = typeof raw?.id === 'string' ? CATALOG[raw.id] : undefined;
    if (!item) throw new PricingError(`Unknown item: ${String(raw?.id)}`);
    const { quantity } = raw;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new PricingError(`Invalid quantity for ${item.id}.`);
    }
    return { ...item, quantity };
  });

  const totalCents = lines.reduce((sum, line) => {
    if (fixture === 'faulty') return sum + line.unitPriceCents; // Deliberate bug: quantity is ignored.
    if (fixture === 'faulty-from-3') return sum + line.unitPriceCents * Math.min(line.quantity, 2); // Deliberate bug from quantity 3.
    return sum + line.unitPriceCents * line.quantity;
  }, 0);
  return { lines, totalCents };
}
