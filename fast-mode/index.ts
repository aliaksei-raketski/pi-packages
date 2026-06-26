import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_COMMAND = "fast";
const FAST_FLAG = "fast";
const FAST_STATUS_KEY = "fast";

const FAST_ON_TEXT = "fast on";
const FAST_OFF_TEXT = "fast off";

const FAST_SPEED = "fast";
const FAST_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const FAST_SERVICE_TIER = "priority";

const CLAUDE_PROVIDER = "anthropic";
const CLAUDE_API = "anthropic-messages";
const OPENAI_PROVIDER = "openai-codex";
const OPENAI_API = "openai-codex-responses";

type FastFeature = {
	provider: string;
	api: string;
	supportedModels: Set<string>;
	injectionKey: string;
	injectionValue: string;
	unsupportedModelMessage: string;
	isEligible?: (ctx: ExtensionContext) => string | undefined;
};

type FastModeState = {
	enabled: boolean;
};

type CurrentModelStatus = {
	feature?: FastFeature;
	isSupported: boolean;
	reason?: string;
};

type PayloadRecord = Record<string, unknown>;

type HeaderModel = {
	headers?: Record<string, string>;
};

const FEATURES: FastFeature[] = [
	{
		provider: CLAUDE_PROVIDER,
		api: CLAUDE_API,
		supportedModels: new Set(["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]),
		injectionKey: "speed",
		injectionValue: FAST_SPEED,
		unsupportedModelMessage:
			"Fast mode is only available for Claude Opus 4.6, 4.7, and 4.8",
	},
	{
		provider: OPENAI_PROVIDER,
		api: OPENAI_API,
		supportedModels: new Set(["gpt-5.4", "gpt-5.5"]),
		injectionKey: "service_tier",
		injectionValue: FAST_SERVICE_TIER,
		unsupportedModelMessage: "Fast mode is only available for GPT-5.4 and GPT-5.5",
		isEligible: (ctx) =>
			ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model)
				? undefined
				: "ChatGPT OAuth auth is required; API-key auth is intentionally not used",
	},
];

const sessionStates = new WeakMap<object, FastModeState>();

function getSessionState(ctx: ExtensionContext): FastModeState {
	let state = sessionStates.get(ctx.sessionManager);
	if (!state) {
		state = { enabled: false };
		sessionStates.set(ctx.sessionManager, state);
	}
	return state;
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function splitBetaHeader(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function getCurrentModelStatus(ctx: ExtensionContext): CurrentModelStatus {
	const model = ctx.model;
	if (!model) {
		return {
			isSupported: false,
			reason: "No model is selected",
		};
	}

	const modelKey = `${model.provider}/${model.id}`;
	const featuresForBackend = FEATURES.filter(
		(feature) => feature.provider === model.provider && feature.api === model.api,
	);

	if (featuresForBackend.length === 0) {
		return {
			isSupported: false,
			reason: `Current model (${modelKey}) does not support fast mode`,
		};
	}

	const matchingFeature = featuresForBackend.find((feature) => feature.supportedModels.has(model.id));
	if (!matchingFeature) {
		return {
			isSupported: false,
			reason: featuresForBackend[0]?.unsupportedModelMessage ?? "Current model does not support fast mode",
		};
	}

	if (matchingFeature.isEligible) {
		const reason = matchingFeature.isEligible(ctx);
		if (reason) {
			return {
				feature: matchingFeature,
				isSupported: false,
				reason,
			};
		}
	}

	return {
		feature: matchingFeature,
		isSupported: true,
	};
}

function syncClaudeBetaHeader(
	ctx: ExtensionContext,
	state: FastModeState,
	modelStatus: CurrentModelStatus,
): void {
	const model = ctx.model as (typeof ctx.model & HeaderModel) | undefined;
	if (!model || model.provider !== CLAUDE_PROVIDER || model.api !== CLAUDE_API) return;

	const shouldEnable = state.enabled && modelStatus.isSupported && modelStatus.feature?.provider === CLAUDE_PROVIDER;
	const headers = { ...(model.headers ?? {}) };
	const existing = splitBetaHeader(headers["anthropic-beta"] ?? headers["Anthropic-Beta"]);
	const requiredBase = ctx.modelRegistry.isUsingOAuth(model) ? CLAUDE_CODE_OAUTH_BETAS : [];
	const next = shouldEnable
		? Array.from(new Set([...existing, ...requiredBase, FAST_BETA]))
		: existing.filter((beta) => beta !== FAST_BETA);

	delete headers["Anthropic-Beta"];
	if (next.length > 0) {
		headers["anthropic-beta"] = next.join(",");
	} else {
		delete headers["anthropic-beta"];
	}
	model.headers = headers;
}

function syncFeatureState(ctx: ExtensionContext, state: FastModeState): CurrentModelStatus {
	const modelStatus = getCurrentModelStatus(ctx);
	syncClaudeBetaHeader(ctx, state, modelStatus);
	return modelStatus;
}

function updateStatus(ctx: ExtensionContext, state: FastModeState, modelStatus: CurrentModelStatus): void {
	if (!ctx.hasUI) return;

	const statusText = state.enabled ? FAST_ON_TEXT : FAST_OFF_TEXT;
	const isActiveForCurrentModel = state.enabled && modelStatus.isSupported;
	ctx.ui.setStatus(
		FAST_STATUS_KEY,
		ctx.ui.theme.fg(isActiveForCurrentModel ? "accent" : "muted", statusText),
	);
}

function getFastPayload(
	payload: unknown,
	ctx: ExtensionContext,
	state: FastModeState,
	modelStatus: CurrentModelStatus,
): PayloadRecord | undefined {
	if (!state.enabled) return undefined;
	if (!modelStatus.isSupported || !modelStatus.feature) return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== ctx.model?.id) return undefined;
	if (modelStatus.feature.injectionKey in payload) return undefined;

	return {
		...payload,
		[modelStatus.feature.injectionKey]: modelStatus.feature.injectionValue,
	};
}

export default function fastMode(pi: ExtensionAPI) {
	pi.registerFlag(FAST_FLAG, {
		description: "Start with fast mode enabled",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", (_event, ctx) => {
		const state = getSessionState(ctx);
		state.enabled = pi.getFlag(FAST_FLAG) === true;
		const modelStatus = syncFeatureState(ctx, state);
		updateStatus(ctx, state, modelStatus);
	});

	pi.on("model_select", (_event, ctx) => {
		const state = getSessionState(ctx);
		const modelStatus = syncFeatureState(ctx, state);
		updateStatus(ctx, state, modelStatus);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = getSessionState(ctx);
		const modelStatus = syncFeatureState(ctx, state);
		updateStatus(ctx, state, modelStatus);
		return getFastPayload(event.payload, ctx, state, modelStatus);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(FAST_STATUS_KEY, undefined);
	});

	pi.registerCommand(FAST_COMMAND, {
		description: "Toggle fast mode",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "warning");
				return;
			}

			const state = getSessionState(ctx);
			state.enabled = !state.enabled;

			const modelStatus = syncFeatureState(ctx, state);
			updateStatus(ctx, state, modelStatus);

			ctx.ui.notify(`Fast mode is now ${state.enabled ? "on" : "off"}.`, "info");

			if (state.enabled && !modelStatus.isSupported) {
				const detail = modelStatus.reason ? ` (${modelStatus.reason})` : "";
				ctx.ui.notify(
					`Current model is not supported for fast mode${detail}. Fast mode will apply automatically once you switch to a supported model.`,
					"warning",
				);
			}
		},
	});
}
