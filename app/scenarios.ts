// Demo scenarios offered in the UI. Each maps to an existing store fixture.
// Labels and descriptions are for the person running the demo only: they are
// saved as demo setup metadata beside a run, and never reach the
// investigator's prompt, tools, page content or observations.
import type { Fixture } from '../demo-store/pricing.ts';

export type Scenario = { id: string; fixture: Fixture; label: string; description: string };

export const SCENARIOS: Scenario[] = [
  {
    id: 'working-cart',
    fixture: 'correct',
    label: 'Working cart',
    description: 'The total updates on every increase ($20 → $40 → $60). A good investigation finds nothing wrong.',
  },
  {
    id: 'total-never-updates',
    fixture: 'faulty',
    label: 'Total never updates',
    description: 'Quantity goes up, but the total stays at $20.00. The bug appears on the first increase.',
  },
  {
    id: 'total-stops-after-first',
    fixture: 'faulty-from-3',
    label: 'Total stops updating after the first increase',
    description:
      'The first increase works ($40.00 at quantity 2). From quantity 3 the total stays at $40.00, so the bug is only found by increasing more than once.',
  },
];

export function scenarioForFixture(fixture: Fixture): Scenario {
  return SCENARIOS.find((s) => s.fixture === fixture)!;
}
