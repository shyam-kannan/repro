// What an investigation actually covered, derived only from the recorded
// actions and observations, never from the model's description of its work.
import type { RecordedAction, RecordedObservation } from './browser-session.ts';

export type Coverage = {
  observations: number;
  // Distinct Quantity values in the order they were first observed. Only the
  // values seen are listed; nothing in between is implied.
  quantitiesObserved: string[];
  clicks: { target: string; count: number }[];
  failedActions: number;
  summary: string;
};

const TIMES = ['never', 'once', 'twice'];

export function describeCoverage(observations: RecordedObservation[], actions: RecordedAction[]): Coverage {
  const quantitiesObserved: string[] = [];
  for (const o of observations) {
    const quantity = o.fields.filter((f) => f.label === 'Quantity');
    if (quantity.length === 1 && !quantitiesObserved.includes(quantity[0].value)) quantitiesObserved.push(quantity[0].value);
  }

  const clicks: Coverage['clicks'] = [];
  for (const a of actions) {
    if (a.kind !== 'click' || !a.ok || !a.target) continue;
    const target = `${a.target.role} “${a.target.name}”`;
    const entry = clicks.find((c) => c.target === target);
    if (entry) entry.count++;
    else clicks.push({ target, count: 1 });
  }
  const failedActions = actions.filter((a) => !a.ok).length;

  const parts: string[] = [];
  if (observations.length === 0) {
    parts.push('No page observations were recorded.');
  } else if (quantitiesObserved.length > 0) {
    parts.push(`Tested quantities: ${quantitiesObserved.join(', ')}.`);
  } else {
    parts.push(`${observations.length} page observation(s), none showing a single Quantity value.`);
  }
  parts.push(
    clicks.length === 0
      ? 'No successful clicks.'
      : `Clicked ${clicks.map((c) => `${c.target} ${TIMES[c.count] ?? `${c.count} times`}`).join(', ')}.`,
  );
  if (failedActions > 0) parts.push(`${failedActions} action(s) failed.`);

  return { observations: observations.length, quantitiesObserved, clicks, failedActions, summary: parts.join(' ') };
}
