import { expect, test } from 'vitest';
import {
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
  expect(getStatusView(state, modelStatus)).toEqual({ text: 'fast on', color: 'muted' });
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

  expect(getStatusView(state, modelStatus)).toEqual({ text: 'fast off', color: 'muted' });

  state.enabled = true;
  expect(getStatusView(state, modelStatus)).toEqual({ text: 'fast on', color: 'accent' });
});

test('Claude fast mode injects speed and adds beta header', () => {
  const model: FastModel = {
    provider: 'anthropic',
    api: 'anthropic-messages',
    id: 'claude-opus-4-6',
    headers: {},
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

  expect(modelStatus.isSupported).toBe(true);
  expect(payload?.speed).toBe('fast');
  expect(model.headers?.['anthropic-beta']).toBe('fast-mode-2026-02-01');
});

test('Claude fast mode preserves existing speed and does not replace payload', () => {
  const ctx = context({ provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-4-6' });
  const state = createFastModeState(true);
  const modelStatus = syncFeatureState(ctx, state);

  expect(
    getFastPayload({ model: 'claude-opus-4-6', speed: 'standard' }, ctx, state, modelStatus),
  ).toBe(undefined);
});

test('Claude fast beta is removed when fast mode is disabled', () => {
  const model: FastModel = {
    provider: 'anthropic',
    api: 'anthropic-messages',
    id: 'claude-opus-4-6',
    headers: { 'anthropic-beta': 'existing,fast-mode-2026-02-01' },
  };
  const ctx = context(model);
  const state = createFastModeState(false);

  syncFeatureState(ctx, state);

  expect(model.headers?.['anthropic-beta']).toBe('existing');
});

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
