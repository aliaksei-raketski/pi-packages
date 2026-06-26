export const FAST_COMMAND = "fast";
export const FAST_FLAG = "fast";
export const FAST_STATUS_KEY = "fast";

export const FAST_ON_TEXT = "fast on";
export const FAST_OFF_TEXT = "fast off";

const FAST_SPEED = "fast";
const FAST_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const FAST_SERVICE_TIER = "priority";

const CLAUDE_PROVIDER = "anthropic";
const CLAUDE_API = "anthropic-messages";
const OPENAI_PROVIDER = "openai-codex";
const OPENAI_API = "openai-codex-responses";

export type FastModel = {
	provider: string;
	api?: string;
	id: string;
	headers?: Record<string, string>;
};

export type FastContext = {
	model?: FastModel;
	modelRegistry: {
		isUsingOAuth(model: FastModel): boolean;
	};
};

export type FastFeature = {
	provider: string;
	api: string;
	supportedModels: Set<string>;
	injectionKey: string;
	injectionValue: string;
	unsupportedModelMessage: string;
	isEligible?: (ctx: FastContext) => string | undefined;
};

export type FastModeState = {
	enabled: boolean;
};

export type CurrentModelStatus = {
	feature?: FastFeature;
	isSupported: boolean;
	reason?: string;
};

export type FastStatusView = {
	text: string;
	color: "accent" | "muted";
};

type PayloadRecord = Record<string, unknown>;

export const FEATURES: FastFeature[] = [
	{
		provider: CLAUDE_PROVIDER,
		api: CLAUDE_API,
		supportedModels: new Set(["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]),
		injectionKey: "speed",
		injectionValue: FAST_SPEED,
		unsupportedModelMessage: "Fast mode is only available for Claude Opus 4.6, 4.7, and 4.8",
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

export function createFastModeState(enabled = false): FastModeState {
	return { enabled };
}

export function getCurrentModelStatus(ctx: FastContext): CurrentModelStatus {
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

	const matchingFeature = featuresForBackend.find((feature) =>
		feature.supportedModels.has(model.id),
	);
	if (!matchingFeature) {
		return {
			isSupported: false,
			reason:
				featuresForBackend[0]?.unsupportedModelMessage ??
				"Current model does not support fast mode",
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

export function syncFeatureState(ctx: FastContext, state: FastModeState): CurrentModelStatus {
	const modelStatus = getCurrentModelStatus(ctx);
	syncClaudeBetaHeader(ctx, state, modelStatus);
	return modelStatus;
}

export function getStatusView(
	state: FastModeState,
	modelStatus: CurrentModelStatus,
): FastStatusView {
	return {
		text: state.enabled ? FAST_ON_TEXT : FAST_OFF_TEXT,
		color: state.enabled && modelStatus.isSupported ? "accent" : "muted",
	};
}

export function getFastPayload(
	payload: unknown,
	ctx: FastContext,
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

function syncClaudeBetaHeader(
	ctx: FastContext,
	state: FastModeState,
	modelStatus: CurrentModelStatus,
): void {
	const model = ctx.model;
	if (!model || model.provider !== CLAUDE_PROVIDER || model.api !== CLAUDE_API) return;

	const shouldEnable =
		state.enabled && modelStatus.isSupported && modelStatus.feature?.provider === CLAUDE_PROVIDER;
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

function splitBetaHeader(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}
