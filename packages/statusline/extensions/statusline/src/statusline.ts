import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { sanitizeFooterText } from './ansi-utils.ts';
import { colorize, resolveColorValue } from './colors.ts';
import { collectStatusItems } from './status-items.ts';
import { createProtocolStatusRegistry } from './statuses/protocol.ts';
import { loadStatuslineConfig, type StatuslineConfig } from './config.ts';
import { GitStatusCache, type GitStatusSource } from './git-status.ts';
import { renderLayoutLines } from './layout.ts';
import type { StatuslineStatus } from '@aliaksei-raketski/pi-statusline-protocol';

interface FooterState {
  requestRender: () => void;
  dispose: () => void;
}

const FOOTER_STATE = new WeakMap<object, FooterState>();

function getActiveState(ctx: ExtensionContext): FooterState | undefined {
  return FOOTER_STATE.get(ctx.sessionManager);
}

function requestFooterRender(ctx: ExtensionContext): void {
  const state = getActiveState(ctx);
  state?.requestRender();
}

function shouldCollectGitItems(requestedKeys: Set<string>): boolean {
  return (
    requestedKeys.size === 0 ||
    requestedKeys.has('branch') ||
    requestedKeys.has('changes') ||
    requestedKeys.has('pr')
  );
}

export function renderFooter(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  config: StatuslineConfig,
  gitStatusSource: GitStatusSource,
  width: number,
  protocolStatuses: Map<string, StatuslineStatus>,
): string[] {
  const separator = colorize(sanitizeFooterText(config.separator), config.separatorColor, theme);
  const requestedKeys = new Set(config.layout.flat().filter((token) => token !== 'spacer'));
  const items = collectStatusItems(
    ctx,
    pi,
    footerData,
    requestedKeys,
    gitStatusSource,
    protocolStatuses,
  );

  const tokenText = (key: string): string | undefined => {
    const value = items.get(key);
    if (!value) {
      return undefined;
    }

    const prefix = sanitizeFooterText(config.prefix[key] ?? '');
    const valueText = sanitizeFooterText(value.text);
    const itemText = prefix
      ? `${prefix.endsWith(' ') ? prefix : `${prefix} `}${valueText}`
      : valueText;
    const color = resolveColorValue(config.colors, key, value.state);
    return colorize(itemText, color, theme);
  };

  return renderLayoutLines(config.layout, tokenText, separator, width);
}

export default function statusline(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== 'tui') {
      return;
    }

    const protocolRegistry = createProtocolStatusRegistry(pi, () => requestFooterRender(ctx));
    protocolRegistry.requestSnapshot();

    const configResult = loadStatuslineConfig({
      cwd: ctx.cwd,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      writeDefaultConfig: true,
    });
    for (const message of configResult.diagnostics) {
      ctx.ui.notify(`statusline: ${message}`, 'warning');
    }

    const config = configResult.config;
    const requestedKeys = new Set(config.layout.flat().filter((token) => token !== 'spacer'));
    const includeGitStatus = shouldCollectGitItems(requestedKeys);
    const includePullRequest = requestedKeys.has('pr');

    const statusCache = includeGitStatus
      ? new GitStatusCache({
          cwd: () => ctx.cwd,
          includeGitStatus,
          includePullRequest,
          onChange: () => {
            requestFooterRender(ctx);
          },
        })
      : undefined;

    ctx.ui.setFooter(
      (
        tui: { requestRender: () => void },
        theme: Theme,
        footerData: ReadonlyFooterDataProvider,
      ) => {
        const state: FooterState = {
          requestRender: () => {
            tui.requestRender();
          },
          dispose: () => {
            FOOTER_STATE.delete(ctx.sessionManager);
          },
        };

        FOOTER_STATE.set(ctx.sessionManager, state);

        const offBranchChange = footerData.onBranchChange(() => {
          statusCache?.invalidate();
          void statusCache?.refresh();
          state.requestRender();
        });

        return {
          render(width: number) {
            return renderFooter(
              ctx,
              pi,
              theme,
              footerData,
              config,
              statusCache?.getGitInfo() ?? {},
              width,
              protocolRegistry.statuses,
            );
          },
          invalidate() {
            return;
          },
          dispose() {
            offBranchChange();
            statusCache?.dispose();
            protocolRegistry.dispose();
            state.dispose();
          },
        };
      },
    );
  });

  const rerender = (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== 'tui') {
      return;
    }
    requestFooterRender(ctx);
  };

  pi.on('model_select', rerender);
  pi.on('thinking_level_select', rerender);
  pi.on('turn_end', rerender);
  pi.on('session_tree', rerender);
  pi.on('session_compact', rerender);
  pi.on('message_end', rerender);

  pi.on('session_shutdown', (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== 'tui') {
      return;
    }
    ctx.ui.setFooter(undefined);
  });
}
