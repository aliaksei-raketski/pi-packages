import { expect, test } from 'vitest';
import {
  applyFastModeHeaders,
  createFastModeState,
  getCurrentModelStatus,
  getFastPayload,
  getStatusView,
  restoreFastModeState,
  syncFeatureState,
  type FastContext,
  type FastModel,
} from '../src/core.ts';

function context(model?: FastModel, oauth = false): FastContext {
  return {
    model,
    modelRegistry: {
      isUsingOAuth: () => oauth,
    },
  };
}

test('unsupported current model keeps fast enabled but inactive', () => {
  const ctx = context({
    provider: 'anthropic',
    api: 'anthropic-messages',
    id: 'claude-sonnet-4-5',
  });
  const state = createFastModeState(true);
  const modelStatus = syncFeatureState(ctx, state);

  expect(modelStatus.isSupported).toBe(false);
  expect(getFastPayload({ model: 'claude-sonnet-4-5' }, ctx, state, modelStatus)).toBe(undefined);
  expect(getStatusView(state, modelStatus)).toEqual({
    text: 'no fast',
    color: 'warning',
    state: 'unsupported',
    fallbackColor: 'warning',
  });
});

test('restores fast mode from latest session custom entry', () => {
  const state = restoreFastModeState(
    [
      { type: 'custom', customType: 'fast', data: { enabled: true } },
      { type: 'custom', customType: 'other', data: { enabled: false } },
      { type: 'custom', customType: 'fast', data: { enabled: false } },
    ],
    true,
  );

  expect(state.enabled).toBe(false);
});

test('uses launch default when session has no fast mode entry', () => {
  const state = restoreFastModeState([], true);

  expect(state.enabled).toBe(true);
});

test('status is muted when off and accent when enabled for a supported model', () => {
  const ctx = context({ provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-4-6' });
  const state = createFastModeState(false);
  const modelStatus = getCurrentModelStatus(ctx);

  expect(getStatusView(state, modelStatus)).toEqual({
    text: 'fast off',
    color: 'muted',
    state: 'off',
    fallbackColor: 'muted',
  });

  state.enabled = true;
  expect(getStatusView(state, modelStatus)).toEqual({
    text: 'fast on',
    color: 'accent',
    state: 'on',
    fallbackColor: 'accent',
  });
});

test('Claude fast mode injects speed and adds its beta only to outgoing headers', () => {
  const model: FastModel = {
    provider: 'anthropic',
    api: 'anthropic-messages',
    id: 'claude-opus-4-6',
    headers: { 'anthropic-beta': 'user-beta' },
  };
  const ctx = context(model);
  const state = createFastModeState(true);
  const modelStatus = syncFeatureState(ctx, state);
  const payload = getFastPayload(
    { model: 'claude-opus-4-6', messages: [] },
    ctx,
    state,
    modelStatus,
  );
  const outgoingHeaders: Record<string, string | null> = {
    'anthropic-beta': 'user-beta',
  };
  applyFastModeHeaders(outgoingHeaders, ctx, state, modelStatus);

  expect(modelStatus.isSupported).toBe(true);
  expect(payload?.speed).toBe('fast');
  expect(outgoingHeaders['anthropic-beta']).toBe('user-beta,fast-mode-2026-02-01');
  expect(model.headers).toEqual({ 'anthropic-beta': 'user-beta' });
});

test('Claude fast mode preserves existing speed and does not replace payload', () => {
  const ctx = context({ provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-4-6' });
  const state = createFastModeState(true);
  const modelStatus = syncFeatureState(ctx, state);

  expect(
    getFastPayload({ model: 'claude-opus-4-6', speed: 'standard' }, ctx, state, modelStatus),
  ).toBe(undefined);
});

test('disabled fast mode preserves a pre-existing fast beta token', () => {
  const model: FastModel = {
    provider: 'anthropic',
    api: 'anthropic-messages',
    id: 'claude-opus-4-6',
    headers: { 'anthropic-beta': 'existing,fast-mode-2026-02-01' },
  };
  const ctx = context(model);
  const state = createFastModeState(false);
  const outgoingHeaders: Record<string, string | null> = {
    'anthropic-beta': 'existing,fast-mode-2026-02-01',
  };

  const modelStatus = syncFeatureState(ctx, state);
  applyFastModeHeaders(outgoingHeaders, ctx, state, modelStatus);

  expect(model.headers?.['anthropic-beta']).toBe('existing,fast-mode-2026-02-01');
  expect(outgoingHeaders['anthropic-beta']).toBe('existing,fast-mode-2026-02-01');
});

test('Claude fast mode preserves mixed-case headers and adds OAuth betas once', () => {
  const model: FastModel = {
    provider: 'anthropic',
    api: 'anthropic-messages',
    id: 'claude-opus-4-6',
  };
  const ctx = context(model, true);
  const state = createFastModeState(true);
  const headers: Record<string, string | null> = { 'Anthropic-Beta': 'user-beta' };

  applyFastModeHeaders(headers, ctx, state);
  applyFastModeHeaders(headers, ctx, state);

  expect(headers).toEqual({
    'Anthropic-Beta': 'user-beta,claude-code-20250219,oauth-2025-04-20,fast-mode-2026-02-01',
  });
  expect(model.headers).toBeUndefined();
});

test.each(['gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])(
  'OpenAI fast mode supports upstream priority tier for %s',
  (modelId) => {
    const model: FastModel = {
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      id: modelId,
    };
    const ctx = context(model, true);
    const state = createFastModeState(true);
    const modelStatus = syncFeatureState(ctx, state);

    expect(modelStatus.isSupported).toBe(true);
    expect(getFastPayload({ model: modelId }, ctx, state, modelStatus)).toEqual({
      model: modelId,
      service_tier: 'priority',
    });
  },
);

test.each(['gpt-5.3-codex-spark', 'gpt-5.4-mini'])(
  'OpenAI model without an upstream priority tier stays unsupported: %s',
  (modelId) => {
    const model: FastModel = {
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      id: modelId,
    };
    const ctx = context(model, true);
    const state = createFastModeState(true);
    const modelStatus = syncFeatureState(ctx, state);

    expect(modelStatus.isSupported).toBe(false);
    expect(getFastPayload({ model: modelId }, ctx, state, modelStatus)).toBe(undefined);
  },
);

test('OpenAI fast mode requires OAuth', () => {
  const model: FastModel = {
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    id: 'gpt-5.4',
  };
  const state = createFastModeState(true);
  const apiKeyContext = context(model, false);
  const oauthContext = context(model, true);

  const apiKeyStatus = syncFeatureState(apiKeyContext, state);
  expect(apiKeyStatus.isSupported).toBe(false);
  expect(getFastPayload({ model: 'gpt-5.4' }, apiKeyContext, state, apiKeyStatus)).toBe(undefined);

  const oauthStatus = syncFeatureState(oauthContext, state);
  expect(oauthStatus.isSupported).toBe(true);
  expect(getFastPayload({ model: 'gpt-5.4' }, oauthContext, state, oauthStatus)).toEqual({
    model: 'gpt-5.4',
    service_tier: 'priority',
  });
});

test('OpenAI fast mode preserves existing service tier', () => {
  const ctx = context(
    { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-5.5' },
    true,
  );
  const state = createFastModeState(true);
  const modelStatus = syncFeatureState(ctx, state);

  expect(
    getFastPayload({ model: 'gpt-5.5', service_tier: 'default' }, ctx, state, modelStatus),
  ).toBe(undefined);
});
