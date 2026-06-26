import assert from "node:assert/strict";
import test from "node:test";
import {
	createFastModeState,
	getCurrentModelStatus,
	getFastPayload,
	getStatusView,
	syncFeatureState,
	type FastContext,
	type FastModel,
} from "../src/core.ts";

function context(model?: FastModel, oauth = false): FastContext {
	return {
		model,
		modelRegistry: {
			isUsingOAuth: () => oauth,
		},
	};
}

test("unsupported current model keeps fast enabled but inactive", () => {
	const ctx = context({
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-sonnet-4-5",
	});
	const state = createFastModeState(true);
	const modelStatus = syncFeatureState(ctx, state);

	assert.equal(modelStatus.isSupported, false);
	assert.equal(getFastPayload({ model: "claude-sonnet-4-5" }, ctx, state, modelStatus), undefined);
	assert.deepEqual(getStatusView(state, modelStatus), { text: "fast on", color: "muted" });
});

test("status is muted when off and accent when enabled for a supported model", () => {
	const ctx = context({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-6" });
	const state = createFastModeState(false);
	const modelStatus = getCurrentModelStatus(ctx);

	assert.deepEqual(getStatusView(state, modelStatus), { text: "fast off", color: "muted" });

	state.enabled = true;
	assert.deepEqual(getStatusView(state, modelStatus), { text: "fast on", color: "accent" });
});

test("Claude fast mode injects speed and adds beta header", () => {
	const model: FastModel = {
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-opus-4-6",
		headers: {},
	};
	const ctx = context(model);
	const state = createFastModeState(true);
	const modelStatus = syncFeatureState(ctx, state);
	const payload = getFastPayload(
		{ model: "claude-opus-4-6", messages: [] },
		ctx,
		state,
		modelStatus,
	);

	assert.equal(modelStatus.isSupported, true);
	assert.equal(payload?.speed, "fast");
	assert.equal(model.headers?.["anthropic-beta"], "fast-mode-2026-02-01");
});

test("Claude fast mode preserves existing speed and does not replace payload", () => {
	const ctx = context({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-6" });
	const state = createFastModeState(true);
	const modelStatus = syncFeatureState(ctx, state);

	assert.equal(
		getFastPayload({ model: "claude-opus-4-6", speed: "standard" }, ctx, state, modelStatus),
		undefined,
	);
});

test("Claude fast beta is removed when fast mode is disabled", () => {
	const model: FastModel = {
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-opus-4-6",
		headers: { "anthropic-beta": "existing,fast-mode-2026-02-01" },
	};
	const ctx = context(model);
	const state = createFastModeState(false);

	syncFeatureState(ctx, state);

	assert.equal(model.headers?.["anthropic-beta"], "existing");
});

test("OpenAI fast mode requires OAuth", () => {
	const model: FastModel = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.4",
	};
	const state = createFastModeState(true);
	const apiKeyContext = context(model, false);
	const oauthContext = context(model, true);

	const apiKeyStatus = syncFeatureState(apiKeyContext, state);
	assert.equal(apiKeyStatus.isSupported, false);
	assert.equal(getFastPayload({ model: "gpt-5.4" }, apiKeyContext, state, apiKeyStatus), undefined);

	const oauthStatus = syncFeatureState(oauthContext, state);
	assert.equal(oauthStatus.isSupported, true);
	assert.deepEqual(getFastPayload({ model: "gpt-5.4" }, oauthContext, state, oauthStatus), {
		model: "gpt-5.4",
		service_tier: "priority",
	});
});

test("OpenAI fast mode preserves existing service tier", () => {
	const ctx = context(
		{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" },
		true,
	);
	const state = createFastModeState(true);
	const modelStatus = syncFeatureState(ctx, state);

	assert.equal(
		getFastPayload({ model: "gpt-5.5", service_tier: "default" }, ctx, state, modelStatus),
		undefined,
	);
});
