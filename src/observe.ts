// Browser observations built only from what a user-facing browser exposes:
// the accessibility snapshot and a screenshot. Nothing here reads app source.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Request } from 'playwright';

// A "Label: value" pair taken from one text node of the accessibility tree,
// so a value is always reported together with the label it was displayed under.
export type LabeledField = {
  label: string;
  value: string;
  // Roles from the root to the node, e.g. `main > list "Cart items" > listitem > paragraph`.
  path: string;
};

// A clickable element as the accessibility tree exposes it. `nth` tells apart
// elements that share a role and name, in document order.
export type ClickableElement = {
  role: string;
  name: string;
  nth: number;
  disabled: boolean;
};

export type Observation = {
  step: string;
  capturedAt: string;
  url: string;
  title: string;
  screenshot: string;
  ariaSnapshot: string;
  fields: LabeledField[];
  elements: ClickableElement[];
};

type AriaNode = {
  role?: string;
  name?: string;
  text?: string;
  disabled?: boolean;
  children?: AriaNode[];
};

const CLICKABLE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem']);

const LABELED_TEXT = /^([^:\n]{1,40}):\s+(\S.*)$/;

export function extractLabeledFields(nodes: AriaNode[], parentPath: string[] = []): LabeledField[] {
  const fields: LabeledField[] = [];
  for (const node of nodes) {
    const role = node.role ?? 'text';
    const path = [...parentPath, node.name ? `${role} "${node.name}"` : role];
    const match = node.text?.trim().match(LABELED_TEXT);
    if (match) fields.push({ label: match[1].trim(), value: match[2].trim(), path: path.join(' > ') });
    if (node.children) fields.push(...extractLabeledFields(node.children, path));
  }
  return fields;
}

export function extractClickableElements(nodes: AriaNode[]): ClickableElement[] {
  const elements: ClickableElement[] = [];
  const visit = (node: AriaNode) => {
    if (node.role && CLICKABLE_ROLES.has(node.role)) {
      const name = node.name ?? '';
      const nth = elements.filter((e) => e.role === node.role && e.name === name).length;
      elements.push({ role: node.role, name, nth, disabled: node.disabled === true });
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return elements;
}

export async function readLabeledFields(page: Page): Promise<LabeledField[]> {
  return extractLabeledFields((await page.ariaSnapshotJSON()) as AriaNode[]);
}

// Returns the value shown under `label`, or an explanation when the label is
// missing or ambiguous. A matching number elsewhere on the page never counts.
export function fieldValue(
  fields: LabeledField[],
  label: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const matches = fields.filter((field) => field.label === label);
  if (matches.length === 1) return { ok: true, value: matches[0].value };
  if (matches.length === 0) return { ok: false, reason: `no field labeled "${label}"` };
  return { ok: false, reason: `${matches.length} fields labeled "${label}"` };
}

// Counts in-flight requests so callers can wait for the page to go quiet
// without knowing which value is supposed to change.
export function trackNetwork(page: Page): { inFlight: () => number } {
  const pending = new Set<Request>();
  page.on('request', (request) => pending.add(request));
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  return { inFlight: () => pending.size };
}

export async function waitForSettled(
  page: Page,
  network: { inFlight: () => number },
  { quietMs = 250, timeoutMs = 5_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quietSince = network.inFlight() === 0 ? Date.now() : Infinity;
  while (Date.now() - quietSince < quietMs) {
    if (Date.now() > deadline) throw new Error(`Page did not settle within ${timeoutMs}ms`);
    await page.waitForTimeout(50);
    if (network.inFlight() > 0) quietSince = Infinity;
    else if (quietSince === Infinity) quietSince = Date.now();
  }
  // Let any render scheduled by the last response reach the screen.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

// Polls the accessibility tree until the field under `label` shows something
// other than `previous`. Used to confirm an action took effect.
export async function waitForFieldChange(
  page: Page,
  label: string,
  previous: string,
  { timeoutMs = 5_000 } = {},
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = fieldValue(await readLabeledFields(page), label);
  while (!(last.ok && last.value !== previous)) {
    if (Date.now() > deadline) {
      const shown = last.ok ? `still "${last.value}"` : last.reason;
      return { ok: false, reason: `"${label}" did not change within ${timeoutMs}ms (${shown})` };
    }
    await page.waitForTimeout(100);
    last = fieldValue(await readLabeledFields(page), label);
  }
  return last;
}

export async function captureObservation(page: Page, step: string, outDir: string): Promise<Observation> {
  await mkdir(outDir, { recursive: true });
  const screenshot = join(outDir, `${step}.png`);
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled', caret: 'hide' });
  const ariaSnapshot = await page.ariaSnapshot();
  const tree = (await page.ariaSnapshotJSON()) as AriaNode[];
  return {
    step,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title(),
    screenshot,
    ariaSnapshot,
    fields: extractLabeledFields(tree),
    elements: extractClickableElements(tree),
  };
}
