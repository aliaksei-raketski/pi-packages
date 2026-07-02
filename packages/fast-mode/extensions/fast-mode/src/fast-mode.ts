import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  clearStatus,
  publishStatus,
  type StatuslineStatus,
  registerStatusProvider,
} from '@aliaksei-raketski/pi-statusline-protocol';
import {
  FAST_COMMAND,
  FAST_FLAG,
  FAST_STATE_CUSTOM_TYPE,
  FAST_STATUS_KEY,
  createFastModeState,
  createFastStateEntryData,
  getFastPayload,
  getCurrentModelStatus,
  getStatusPayload,
  restoreFastModeState,
  syncFeatureState,
  type FastContext,
  type FastModeState,
} from './core.ts';

const FAST_STATUS_SOURCE = 'fast-mode';

type FastModeRuntime = FastModeState & {
  clearProvider: (() => void) | undefined;
};

const sessionStates = new WeakMap<object, FastModeRuntime>();

function getSessionState(ctx: ExtensionContext): FastModeRuntime {
  let state = sessionStates.get(ctx.sessionManager);
  if (!state) {
    state = { ...createFastModeState(), clearProvider: undefined };
    sessionStates.set(ctx.sessionManager, state);
  }
  return state;
}

function restoreSessionState(ctx: ExtensionContext, defaultEnabled: boolean): FastModeRuntime {
  const restored = restoreFastModeState(ctx.sessionManager.getBranch(), defaultEnabled);
  const state = getSessionState(ctx);
  state.enabled = restored.enabled;
  return state;
}

function toFastContext(ctx: ExtensionContext): FastContext {
  return {
    model: ctx.model as FastContext['model'],
    modelRegistry: {
      isUsingOAuth: (model) =>
        ctx.modelRegistry.isUsingOAuth(model as NonNullable<typeof ctx.model>),
    },
  };
}

function createStatusContext(ctx: ExtensionContext) {
  return {
    setStatus: (key: string, text: string | undefined) => ctx.ui.setStatus(key, text),
    theme: ctx.ui.theme,
  };
}

function collectStatusPayload(ctx: ExtensionContext, state: FastModeState): StatuslineStatus {
  const modelStatus = getCurrentModelStatus(toFastContext(ctx));
  return {
    key: FAST_STATUS_KEY,
    ...getStatusPayload(state, modelStatus),
  };
}

function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const state = getSessionState(ctx);
  publishStatus(pi, createStatusContext(ctx), collectStatusPayload(ctx, state), FAST_STATUS_SOURCE);
}

function toggleFastMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = getSessionState(ctx);
  state.enabled = !state.enabled;
  pi.appendEntry(FAST_STATE_CUSTOM_TYPE, createFastStateEntryData(state));

  const modelStatus = syncFeatureState(toFastContext(ctx), state);
  updateStatus(pi, ctx);

  ctx.ui.notify(`Fast mode is now ${state.enabled ? 'on' : 'off'}.`, 'info');

  if (state.enabled && !modelStatus.isSupported) {
    const detail = modelStatus.reason ? ` (${modelStatus.reason})` : '';
    ctx.ui.notify(
      `Current model is not supported for fast mode${detail}. Fast mode will apply automatically once you switch to a supported model.`,
      'warning',
    );
  }
}

export default function fastMode(pi: ExtensionAPI) {
  pi.registerFlag(FAST_FLAG, {
    description: 'Start with fast mode enabled',
    type: 'boolean',
    default: false,
  });

  pi.on('session_start', (_event, ctx) => {
    const state = restoreSessionState(ctx, pi.getFlag(FAST_FLAG) === true);
    syncFeatureState(toFastContext(ctx), state);

    state.clearProvider?.();

    const provider = registerStatusProvider(
      pi,
      () => [collectStatusPayload(ctx, getSessionState(ctx))],
      FAST_STATUS_SOURCE,
    );
    state.clearProvider = provider.dispose;

    updateStatus(pi, ctx);
  });

  pi.on('model_select', (_event, ctx) => {
    const state = getSessionState(ctx);
    syncFeatureState(toFastContext(ctx), state);
    updateStatus(pi, ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    const state = restoreSessionState(ctx, pi.getFlag(FAST_FLAG) === true);
    syncFeatureState(toFastContext(ctx), state);
    updateStatus(pi, ctx);
  });

  pi.on('before_provider_request', (event, ctx) => {
    const state = getSessionState(ctx);
    const fastContext = toFastContext(ctx);
    const modelStatus = syncFeatureState(fastContext, state);
    updateStatus(pi, ctx);
    return getFastPayload(event.payload, fastContext, state, modelStatus);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const state = sessionStates.get(ctx.sessionManager);
    state?.clearProvider?.();
    if (state) {
      state.clearProvider = undefined;
    }

    if (!ctx.hasUI) return;

    clearStatus(pi, createStatusContext(ctx), FAST_STATUS_KEY);
  });

  pi.registerCommand(FAST_COMMAND, {
    description: 'Toggle fast mode',
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('Usage: /fast', 'warning');
        return;
      }
      toggleFastMode(pi, ctx);
    },
  });

  pi.registerShortcut('f3', {
    description: 'Toggle fast mode',
    handler: async (ctx) => {
      toggleFastMode(pi, ctx);
    },
  });
}
