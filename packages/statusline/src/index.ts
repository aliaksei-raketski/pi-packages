import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { colorize, resolveColorValue } from "./colors.ts";
import { collectStatusItems } from "./status-items.ts";
import { loadStatuslineConfig, type StatuslineConfig } from "./config.ts";
import { renderLayoutLines } from "./layout.ts";

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

function renderFooter(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	config: StatuslineConfig,
	width: number,
): string[] {
	const separator = colorize(config.separator, config.separatorColor, theme);
	const requestedKeys = new Set(config.layout.flat().filter((token) => token !== "spacer"));
	const items = collectStatusItems(ctx, pi, footerData, requestedKeys);

	const tokenText = (key: string): string | undefined => {
		const value = items.get(key);
		if (!value) {
			return undefined;
		}

		const prefix = config.prefix[key];
		const itemText = prefix ? `${prefix.endsWith(" ") ? prefix : `${prefix} `}${value.text}` : value.text;
		const color = resolveColorValue(config.colors, key, value.state);
		return colorize(itemText, color, theme);
	};

	return renderLayoutLines(config.layout, tokenText, separator, width);
}

export default function statusline(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			return;
		}

		const configResult = loadStatuslineConfig({
			cwd: ctx.cwd,
			isProjectTrusted: () => ctx.isProjectTrusted(),
			writeDefaultConfig: true,
		});
		for (const message of configResult.diagnostics) {
			ctx.ui.notify(`statusline: ${message}`, "warning");
		}

		const config = configResult.config;

		ctx.ui.setFooter((tui: { requestRender: () => void }, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			const state: FooterState = {
				requestRender: () => {
					tui.requestRender();
				},
				dispose: () => {
					FOOTER_STATE.delete(ctx.sessionManager);
				},
			};

			const offBranchChange = footerData.onBranchChange(() => {
				state.requestRender();
			});

			FOOTER_STATE.set(ctx.sessionManager, state);

			return {
				render(width: number) {
					return renderFooter(ctx, pi, theme, footerData, config, width);
				},
				invalidate() {},
				dispose() {
					offBranchChange();
					state.dispose();
				},
			};
		});
	});

	const rerender = (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			return;
		}
		requestFooterRender(ctx);
	};

	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("turn_end", rerender);
	pi.on("session_tree", rerender);
	pi.on("session_compact", rerender);
	pi.on("message_end", rerender);

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			return;
		}
		ctx.ui.setFooter(undefined);
	});
}
