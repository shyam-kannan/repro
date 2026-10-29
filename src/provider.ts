import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_URL } from './config.ts';

export type ModelRequest = Anthropic.MessageCreateParamsNonStreaming;

// The investigator talks to a model only through this interface, so tests can
// substitute a clearly labeled test double for the real API.
export interface ModelProvider {
  readonly name: string;
  createMessage(
    request: ModelRequest,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<Anthropic.Message>;
}

// Explicit apiKey and baseURL: with these set, the SDK reads none of the
// ANTHROPIC_* credential or endpoint variables. SDK retries are off; the
// investigator retries itself so every attempt is logged and deadline-bound.
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, baseURL: ANTHROPIC_API_URL, maxRetries: 0 });
}

export function createAnthropicProvider(apiKey: string): ModelProvider {
  const client = createAnthropicClient(apiKey);
  return {
    name: `anthropic (${ANTHROPIC_API_URL})`,
    createMessage: (request, { signal, timeoutMs }) =>
      client.messages.create(request, { signal, timeout: timeoutMs, maxRetries: 0 }),
  };
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIUserAbortError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }
  return false;
}

export type ProviderErrorSummary = { kind: string; status?: number; message: string };

export function describeProviderError(error: unknown): ProviderErrorSummary {
  if (error instanceof Anthropic.APIError) {
    return {
      kind: error.constructor.name,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      message: error.message,
    };
  }
  if (error instanceof Error) return { kind: error.constructor.name, message: error.message };
  return { kind: 'Unknown', message: String(error) };
}
