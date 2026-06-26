import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FAST_COMMAND,
	FAST_FLAG,
	FAST_STATUS_KEY,
	createFastModeState,
	getFastPayload,
	getStatusView,
	syncFeatureState,
	type FastContext,
	type FastModeState,
	type FastModel,
	type CurrentModelStatus,
} from "./core.ts";

const sessionStates = new WeakMap<object, FastModeState>();

function getSessionState(ctx: ExtensionContext): FastModeState {
	let state = sessionStates.get(ctx.sessionManager);
	if (!state) {
		state = createFastModeState();
		sessionStates.set(ctx.sessionManager, state);
	}
	return state;
}

function toFastContext(ctx: ExtensionContext): FastContext {
	return {
		model: ctx.model as FastModel | undefined,
		modelRegistry: {
			isUsingOAuth: (model) =>
				ctx.modelRegistry.isUsingOAuth(model as NonNullable<typeof ctx.model>),
		},
	};
}

function updateStatus(
	ctx: ExtensionContext,
	state: FastModeState,
	modelStatus: CurrentModelStatus,
): void {
	if (!ctx.hasUI) return;

	const status = getStatusView(state, modelStatus);
	ctx.ui.setStatus(FAST_STATUS_KEY, ctx.ui.theme.fg(status.color, status.text));
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
		const modelStatus = syncFeatureState(toFastContext(ctx), state);
		updateStatus(ctx, state, modelStatus);
	});

	pi.on("model_select", (_event, ctx) => {
		const state = getSessionState(ctx);
		const modelStatus = syncFeatureState(toFastContext(ctx), state);
		updateStatus(ctx, state, modelStatus);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = getSessionState(ctx);
		const fastContext = toFastContext(ctx);
		const modelStatus = syncFeatureState(fastContext, state);
		updateStatus(ctx, state, modelStatus);
		return getFastPayload(event.payload, fastContext, state, modelStatus);
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

			const modelStatus = syncFeatureState(toFastContext(ctx), state);
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
