// The report the model submits, and the code-enforced rules that decide the
// final verdict. The model proposes; these checks can only keep its verdict or
// downgrade it to Inconclusive.
import type Anthropic from '@anthropic-ai/sdk';
import type { RecordedAction, RecordedObservation } from './browser-session.ts';

export const VERDICT_LABELS = {
  reproduced: 'Reproduced',
  not_reproduced: 'Not reproduced in this run',
  inconclusive: 'Inconclusive',
} as const;
export type VerdictCode = keyof typeof VERDICT_LABELS;

export type Citation = { observation_id: string; label: string; value: string };

export type SubmittedReport = {
  verdict: VerdictCode;
  expected_behavior: string;
  assumptions: string[];
  observed_behavior: string;
  evidence: Citation[];
  explanation: string;
  inconclusive_reason?: string;
};

export const FINISH_TOOL: Anthropic.Tool = {
  name: 'finish_investigation',
  description:
    'Submit the final report. Call once, after the browser work is done. Every evidence entry must copy an ' +
    'observation_id, label and value exactly from labeled_values in a recorded observation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'expected_behavior', 'assumptions', 'observed_behavior', 'evidence', 'explanation'],
    properties: {
      verdict: { type: 'string', enum: ['reproduced', 'not_reproduced', 'inconclusive'] },
      expected_behavior: { type: 'string', description: 'The behavior you tested against.' },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything you inferred that the reporter or the supplied expected behavior did not state.',
      },
      observed_behavior: { type: 'string', description: 'What the page actually showed.' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['observation_id', 'label', 'value'],
          properties: {
            observation_id: { type: 'string' },
            label: { type: 'string' },
            value: { type: 'string' },
          },
        },
      },
      explanation: { type: 'string', description: 'How the evidence supports the verdict.' },
      inconclusive_reason: { type: 'string', description: 'Required when verdict is "inconclusive".' },
    },
  },
};

export function parseReport(input: unknown): { ok: true; report: SubmittedReport } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['report must be an object'] };

  const allowed = new Set(Object.keys(FINISH_TOOL.input_schema.properties as object));
  for (const key of Object.keys(input)) if (!allowed.has(key)) errors.push(`unexpected field "${key}"`);

  const { verdict, expected_behavior, assumptions, observed_behavior, evidence, explanation, inconclusive_reason } =
    input;
  if (typeof verdict !== 'string' || !(verdict in VERDICT_LABELS)) {
    errors.push('verdict must be "reproduced", "not_reproduced" or "inconclusive"');
  }
  for (const [name, value] of Object.entries({ expected_behavior, observed_behavior, explanation })) {
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${name} must be a non-empty string`);
  }
  if (!Array.isArray(assumptions) || !assumptions.every((a) => typeof a === 'string')) {
    errors.push('assumptions must be an array of strings');
  }
  if (!Array.isArray(evidence)) {
    errors.push('evidence must be an array');
  } else {
    evidence.forEach((item, index) => {
      const ok =
        isRecord(item) &&
        Object.keys(item).every((k) => ['observation_id', 'label', 'value'].includes(k)) &&
        typeof item.observation_id === 'string' &&
        typeof item.label === 'string' &&
        typeof item.value === 'string';
      if (!ok) errors.push(`evidence[${index}] must have string observation_id, label and value only`);
    });
  }
  if (inconclusive_reason !== undefined && typeof inconclusive_reason !== 'string') {
    errors.push('inconclusive_reason must be a string');
  }
  if (verdict === 'inconclusive' && (typeof inconclusive_reason !== 'string' || inconclusive_reason.trim() === '')) {
    errors.push('inconclusive_reason is required when verdict is "inconclusive"');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, report: input as SubmittedReport };
}

export type CheckedCitation = Citation & { ok: boolean; problem?: string; screenshot?: string };

// A citation holds only if the cited observation shows exactly one field with
// that label and the field's value is exactly the quoted value.
export function checkCitations(citations: Citation[], observations: RecordedObservation[]): CheckedCitation[] {
  return citations.map((citation) => {
    const observation = observations.find((o) => o.id === citation.observation_id);
    if (!observation) return { ...citation, ok: false, problem: `no observation ${citation.observation_id}` };
    const matches = observation.fields.filter((f) => f.label === citation.label);
    const screenshot = observation.screenshot;
    if (matches.length === 0) {
      return { ...citation, ok: false, screenshot, problem: `${observation.id} has no field labeled "${citation.label}"` };
    }
    if (matches.length > 1) {
      return { ...citation, ok: false, screenshot, problem: `${observation.id} has ${matches.length} fields labeled "${citation.label}"` };
    }
    if (matches[0].value !== citation.value.trim()) {
      return {
        ...citation,
        ok: false,
        screenshot,
        problem: `${observation.id} shows "${citation.label}: ${matches[0].value}", not "${citation.value}"`,
      };
    }
    return { ...citation, ok: true, screenshot };
  });
}

// Decides the final verdict from the submitted report and what was recorded.
// Reproduced and Not reproduced both require proof that the scenario ran: the
// report must cite at least two labels both before and after a successful
// action, and at least one of those values must have changed.
export function decideVerdict(
  report: SubmittedReport,
  citations: CheckedCitation[],
  observations: RecordedObservation[],
  actions: RecordedAction[],
): { verdict: VerdictCode; reasons: string[] } {
  const failed = citations.filter((c) => !c.ok);
  if (failed.length > 0) {
    return {
      verdict: 'inconclusive',
      reasons: failed.map((c) => `Evidence did not match the recorded page: ${c.problem}.`),
    };
  }
  if (report.verdict === 'inconclusive') {
    return { verdict: 'inconclusive', reasons: [`Investigator reported: ${report.inconclusive_reason}`] };
  }

  const clicks = actions.filter((a) => a.kind === 'click' && a.ok && a.beforeObservation && a.afterObservation);
  if (clicks.length === 0) {
    return {
      verdict: 'inconclusive',
      reasons: [`No action on the page succeeded, so the reported scenario was not exercised (proposed: ${report.verdict}).`],
    };
  }
  if (!showsExercisedScenario(citations, observations, clicks)) {
    return {
      verdict: 'inconclusive',
      reasons: [
        `The report does not show the scenario was exercised (proposed: ${report.verdict}). It must cite at least ` +
          'two labeled values both before and after a successful action, with at least one value changed.',
      ],
    };
  }
  return { verdict: report.verdict, reasons: [] };
}

function showsExercisedScenario(
  citations: CheckedCitation[],
  observations: RecordedObservation[],
  clicks: RecordedAction[],
): boolean {
  const seq = (id: string) => observations.find((o) => o.id === id)?.seq ?? NaN;
  const valuesByObservation = new Map<string, Map<string, string>>();
  for (const c of citations) {
    if (!valuesByObservation.has(c.observation_id)) valuesByObservation.set(c.observation_id, new Map());
    valuesByObservation.get(c.observation_id)!.set(c.label, c.value.trim());
  }
  const cited = [...valuesByObservation.keys()];
  for (const before of cited) {
    for (const after of cited) {
      const clickBetween = clicks.some(
        (click) => seq(before) <= seq(click.beforeObservation!) && seq(click.afterObservation!) <= seq(after),
      );
      if (!clickBetween) continue;
      const beforeValues = valuesByObservation.get(before)!;
      const afterValues = valuesByObservation.get(after)!;
      const shared = [...beforeValues.keys()].filter((label) => afterValues.has(label));
      if (shared.length >= 2 && shared.some((label) => beforeValues.get(label) !== afterValues.get(label))) {
        return true;
      }
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
