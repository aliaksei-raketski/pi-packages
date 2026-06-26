import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ColorConfigValue } from "./colors.ts";
import { mergeColorMaps, normalizeColorMap } from "./colors.ts";
import { normalizeLayout, type StatuslineLayout } from "./layout.ts";

export const STATUSLINE_CONFIG_FILE = "statusline.json";

export interface RawStatuslineConfig {
	layout?: unknown;
	separator?: unknown;
	separatorColor?: unknown;
	prefix?: unknown;
	// Backward-compatible alias for existing configs.
	icons?: unknown;
	colors?: unknown;
}

export interface StatuslineConfig {
	layout: StatuslineLayout;
	separator: string;
	separatorColor: string;
	prefix: Record<string, string>;
	colors: Record<string, ColorConfigValue>;
}

export interface StatuslineConfigLoadResult {
	config: StatuslineConfig;
	diagnostics: string[];
}

export interface ConfigLoadContext {
	cwd: string;
	isProjectTrusted(): boolean;
	notify?(message: string): void;
	/**
	 * If true, write a default config file to user config path when missing.
	 */
	writeDefaultConfig?: boolean;
	paths?: {
		user?: string;
		project?: string;
	};
}

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
	layout: [
		["branch", "changes", "spacer", "project"],
		["context", "cache", "cost", "spacer", "model", "thinking"],
		["title"],
		["cwd"],
	],
	separator: " • ",
	separatorColor: "dim",
	prefix: {
		cwd: "⌂",
		branch: "⎇",
		project: "◯",
		title: "✎",
		model: "◉",
		thinking: "◐",
		changes: "±",
		context: "◔",
		tokens: "◈",
		cache: "↻",
		cost: "$",
		statuses: "◍",
	},
	colors: {
		cwd: "muted",
		branch: {
			normal: "accent",
		},
		title: "muted",
		project: "muted",
		model: "toolTitle",
		thinking: {
			off: "thinkingOff",
			minimal: "thinkingMinimal",
			low: "thinkingLow",
			medium: "thinkingMedium",
			high: "thinkingHigh",
			xhigh: "thinkingXhigh",
		},
		changes: "dim",
		context: {
			normal: "muted",
			warning: "warning",
			full: "error",
			default: "muted",
		},
		tokens: "muted",
		cache: "muted",
		cost: "muted",
	},
};

function isStringRecord(raw: unknown): raw is Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return false;
	}
	for (const value of Object.values(raw)) {
		if (typeof value !== "string") {
			return false;
		}
	}
	return true;
}

function readConfigFile(path: string, diagnostics: string[]): unknown | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const file = readFileSync(path, "utf-8");
		return JSON.parse(file);
	} catch (error) {
		diagnostics.push(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

const DEFAULT_STATUSLINE_CONFIG_JSON = JSON.stringify(DEFAULT_STATUSLINE_CONFIG, null, 2);

function ensureDefaultConfig(path: string, diagnostics: string[]): void {
	if (existsSync(path)) {
		return;
	}
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${DEFAULT_STATUSLINE_CONFIG_JSON}\n`, "utf-8");
	} catch (error) {
		diagnostics.push(
			`Could not create default config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseConfig(raw: unknown, source: string, diagnostics: string[]): Partial<StatuslineConfig> | null {
	if (!raw || typeof raw !== "object") {
		if (raw !== undefined) {
			diagnostics.push(`Ignoring invalid ${source} config: expected object.`);
		}
		return null;
	}

	const candidate = raw as RawStatuslineConfig;
	const result: Partial<StatuslineConfig> = {};

	if (candidate.layout !== undefined) {
		const normalized = normalizeLayout(candidate.layout);
		if (normalized === null) {
			diagnostics.push(`Ignoring invalid ${source} layout: expected array of strings or nested arrays.`);
		} else {
			result.layout = normalized;
		}
	}

	if (typeof candidate.separator === "string") {
		result.separator = candidate.separator;
	}

	if (candidate.separatorColor !== undefined) {
		if (typeof candidate.separatorColor === "string") {
			result.separatorColor = candidate.separatorColor;
		} else {
			diagnostics.push(`Ignoring invalid ${source} separatorColor: expected string.`);
		}
	}

	if (candidate.prefix !== undefined) {
		if (isStringRecord(candidate.prefix)) {
			result.prefix = candidate.prefix;
		} else {
			diagnostics.push(`Ignoring invalid ${source} prefix: expected string map.`);
		}
	}
	if (candidate.icons !== undefined && candidate.prefix === undefined) {
		if (isStringRecord(candidate.icons)) {
			result.prefix = candidate.icons;
		} else {
			diagnostics.push(`Ignoring invalid ${source} icons (deprecated alias): expected string map.`);
		}
	}

	if (candidate.colors !== undefined) {
		const colors = normalizeColorMap(candidate.colors);
		if (colors) {
			result.colors = colors;
		} else {
			diagnostics.push(`Ignoring invalid ${source} colors: expected string or string/number state maps.`);
		}
	}

	return result;
}

function mergeConfig(base: StatuslineConfig, patch: Partial<StatuslineConfig> | null): StatuslineConfig {
	if (!patch) {
		return { ...base };
	}
	return {
		layout: patch.layout ?? base.layout,
		separator: patch.separator ?? base.separator,
		separatorColor: patch.separatorColor ?? base.separatorColor,
		prefix: {
			...base.prefix,
			...(patch.prefix ?? {}),
		},
		colors: patch.colors
			? mergeColorMaps(base.colors, patch.colors)
			: { ...base.colors },
	};
}

const CONFIG_DIR_NAME = ".pi";

function getHomeConfigDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
	return join(home, CONFIG_DIR_NAME);
}

function defaultConfigPaths(cwd: string): { user: string; project: string } {
	return {
		user: join(getHomeConfigDir(), STATUSLINE_CONFIG_FILE),
		project: join(cwd, CONFIG_DIR_NAME, STATUSLINE_CONFIG_FILE),
	};
}

export function loadStatuslineConfig(context: ConfigLoadContext): StatuslineConfigLoadResult {
	const diagnostics: string[] = [];
	const resolvedPaths = {
		user: context.paths?.user ?? defaultConfigPaths(context.cwd).user,
		project: context.paths?.project ?? defaultConfigPaths(context.cwd).project,
	};

	let config = {
		...DEFAULT_STATUSLINE_CONFIG,
		prefix: { ...DEFAULT_STATUSLINE_CONFIG.prefix },
		colors: { ...DEFAULT_STATUSLINE_CONFIG.colors },
	};

	if (context.writeDefaultConfig === true) {
		ensureDefaultConfig(resolvedPaths.user, diagnostics);
	}

	const userRaw = readConfigFile(resolvedPaths.user, diagnostics);
	if (userRaw !== undefined) {
		const parsed = parseConfig(userRaw, "user", diagnostics);
		config = mergeConfig(config, parsed);
	}

	if (context.isProjectTrusted()) {
		const projectRaw = readConfigFile(resolvedPaths.project, diagnostics);
		if (projectRaw !== undefined) {
			const parsed = parseConfig(projectRaw, "project", diagnostics);
			config = mergeConfig(config, parsed);
		}
	}

	if (context.notify) {
		for (const message of diagnostics) {
			context.notify(`statusline: ${message}`);
		}
	}

	return { config, diagnostics };
}
