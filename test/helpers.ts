// Shared helpers for offline tests. Nothing here calls a real model: the
// provider below is a scripted TEST DOUBLE, and its name says so in every run
// record it produces.
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser } from 'playwright';
import { createStoreServer } from '../demo-store/server.ts';
import type { Fixture } from '../demo-store/pricing.ts';
import { LIMITS, type InvestigatorSettings } from '../src/config.ts';
import type { ModelProvider, ModelRequest } from '../src/provider.ts';

export const TEST_DOUBLE_NAME = 'TEST DOUBLE: scripted provider, not a real model';

type ScriptContext = { request: ModelRequest; call: number; signal: AbortSignal };

export type ScriptedProvider = ModelProvider & { requests: ModelRequest[] };

export function scriptedProvider(
  script: (ctx: ScriptContext) => Anthropic.Message | Promise<Anthropic.Message>,
): ScriptedProvider {
  const requests: ModelRequest[] = [];
  return {
    name: TEST_DOUBLE_NAME,
    requests,
    async createMessage(request, { signal }) {
      requests.push(structuredClone(request));
      return script({ request, call: requests.length, signal });
    },
  };
}

let toolUseCounter = 0;

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown };

export function toolUse(name: string, input: unknown): Block {
  return { type: 'tool_use', name, input };
}

// Builds a Messages API response for the test double.
export function reply(blocks: Block[], stopReason?: Anthropic.Message['stop_reason']): Anthropic.Message {
  const content = blocks.map((b) =>
    b.type === 'tool_use' ? { ...b, id: `toolu_test_${++toolUseCounter}` } : { ...b, citations: null },
  );
  return {
    id: `msg_test_${toolUseCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-double',
    content,
    stop_reason: stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

export type ModelObservation = {
  observation_id: string;
  labeled_values: { label: string; value: string }[];
  clickable_elements: { element_id: string; role: string; name: string }[];
};

// The observation most recently sent to the model, as the model sees it.
export function latestObservation(request: ModelRequest): ModelObservation {
  const last = request.messages.at(-1)!;
  if (typeof last.content === 'string') {
    return JSON.parse(last.content.split('<observation>')[1].split('</observation>')[0]);
  }
  for (const block of [...last.content].reverse()) {
    if (block.type === 'tool_result' && !block.is_error && typeof block.content === 'string') {
      return JSON.parse(block.content).observation;
    }
  }
  throw new Error('No observation in the latest message');
}

export function valueOf(observation: ModelObservation, label: string): string {
  return observation.labeled_values.find((f) => f.label === label)!.value;
}

export function elementNamed(observation: ModelObservation, name: string): string {
  return observation.clickable_elements.find((e) => e.name === name)!.element_id;
}

// A scripted stand-in for the model on the cart complaint: it clicks the
// element it finds in the observation, then compares the observed totals.
export function cartInvestigatorDouble(): ScriptedProvider {
  let before: ModelObservation | undefined;
  return scriptedProvider(({ request, call }) => {
    const observation = latestObservation(request);
    if (call === 1) {
      before = observation;
      return reply([toolUse('click_element', { element_id: elementNamed(observation, 'Increase quantity') })]);
    }
    const unchanged = valueOf(before!, 'Total') === valueOf(observation, 'Total');
    const cite = (o: ModelObservation, label: string) => ({ observation_id: o.observation_id, label, value: valueOf(o, label) });
    return reply([
      toolUse('finish_investigation', {
        verdict: unchanged ? 'reproduced' : 'not_reproduced',
        expected_behavior: 'The total increases when the quantity increases.',
        assumptions: ['The total should equal unit price times quantity.'],
        observed_behavior: unchanged ? 'Quantity rose but the total did not change.' : 'Quantity and total both rose.',
        evidence: [cite(before!, 'Quantity'), cite(before!, 'Total'), cite(observation, 'Quantity'), cite(observation, 'Total')],
        explanation: 'Compared quantity and total before and after one click.',
      }),
    ]);
  });
}

export async function startStore(fixture: Fixture): Promise<{ url: string; close: () => void }> {
  const server = createStoreServer(fixture);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

export function trackedLaunch(): { browsers: Browser[]; launch: () => Promise<Browser> } {
  const browsers: Browser[] = [];
  return {
    browsers,
    launch: async () => {
      const browser = await chromium.launch();
      browsers.push(browser);
      return browser;
    },
  };
}

export function testSettings(overrides: Partial<InvestigatorSettings> = {}): InvestigatorSettings {
  return {
    model: 'test-double-model',
    maxOutputTokens: 1234,
    maxBrowserToolCalls: LIMITS.maxBrowserToolCalls,
    deadlineMs: LIMITS.deadlineMs,
    maxProviderRetries: 2,
    ...overrides,
  };
}

export function tempRunsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'repro-test-'));
}
