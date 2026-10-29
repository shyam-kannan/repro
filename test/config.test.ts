import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANTHROPIC_API_URL, loadConfig } from '../src/config.ts';
import { createAnthropicClient } from '../src/provider.ts';

test('loadConfig reads only REPRO_* variables and applies the fixed limits', () => {
  const missing = loadConfig({ ANTHROPIC_API_KEY: 'sk-session-key', ANTHROPIC_BASE_URL: 'http://session-proxy' });
  assert.deepEqual(missing, { ok: false, problems: ['REPRO_ANTHROPIC_API_KEY is not set', 'REPRO_MODEL is not set'] });

  const loaded = loadConfig({ REPRO_ANTHROPIC_API_KEY: 'repro-key', REPRO_MODEL: 'some-model', REPRO_MAX_OUTPUT_TOKENS: '2048' });
  assert.ok(loaded.ok);
  assert.equal(loaded.config.apiKey, 'repro-key');
  assert.deepEqual(loaded.config.settings, {
    model: 'some-model',
    maxOutputTokens: 2048,
    maxBrowserToolCalls: 15,
    deadlineMs: 90_000,
    maxProviderRetries: 2,
  });
});

test('loadConfig rejects an invalid output-token limit', () => {
  const result = loadConfig({ REPRO_ANTHROPIC_API_KEY: 'k', REPRO_MODEL: 'm', REPRO_MAX_OUTPUT_TOKENS: '-5' });
  assert.deepEqual(result, { ok: false, problems: ['REPRO_MAX_OUTPUT_TOKENS must be a positive integer'] });
});

test('the API client ignores inherited ANTHROPIC_* endpoint and credentials', () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_BASE_URL = 'http://inherited-session-endpoint.invalid';
  process.env.ANTHROPIC_API_KEY = 'inherited-key';
  process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-token';
  try {
    const client = createAnthropicClient('repro-key');
    assert.equal(client.baseURL, ANTHROPIC_API_URL);
    assert.equal(client.apiKey, 'repro-key');
    assert.equal(client.authToken, null);
    assert.equal(client.maxRetries, 0);
  } finally {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
