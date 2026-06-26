import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type SimpleColorValue = "" | number | string;
export type ColorConfigValue = SimpleColorValue | Record<string, SimpleColorValue>;

export type ParsedSimpleColor =
	| { type: "none" }
	| { type: "theme"; value: ThemeColor }
	| { type: "hex"; value: string; r: number; g: number; b: number }
	| { type: "ansi256"; value: number };

const THEME_COLOR_TOKENS = new Set([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
]);
interface ThemeLike {
	fg: (color: ThemeColor, text: string) => string;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export const THEME_DEFAULT_COLORS = {
	cwd: "muted",
	branch: {
		clean: "success",
		dirty: "warning",
		default: "accent",
	},
	title: "muted",
	model: "toolTitle",
	thinking: {
		off: "thinkingOff",
		minimal: "thinkingMinimal",
		low: "thinkingLow",
		medium: "thinkingMedium",
		high: "thinkingHigh",
		xhigh: "thinkingXhigh",
		default: "accent",
	},
	context: {
		normal: "muted",
		warning: "warning",
		full: "error",
		default: "muted",
	},
	changes: "dim",
	tokens: "dim",
	cache: "dim",
	cost: "muted",
};

export function isThemeColor(value: string): value is ThemeColor {
	return THEME_COLOR_TOKENS.has(value);
}

export function isValidSimpleColorValue(value: unknown): value is SimpleColorValue {
	if (value === "") {
		return true;
	}

	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 0 && value <= 255;
	}

	if (typeof value !== "string") {
		return false;
	}

	if (isThemeColor(value) || HEX_COLOR_RE.test(value)) {
		return true;
	}

	return false;
}

function parseHex(value: string): { r: number; g: number; b: number } {
	const normalized = value.replace(/^#/, "");
	if (normalized.length === 3) {
		const r = Number.parseInt(normalized[0] + normalized[0], 16);
		const g = Number.parseInt(normalized[1] + normalized[1], 16);
		const b = Number.parseInt(normalized[2] + normalized[2], 16);
		return { r, g, b };
	}

	const r = Number.parseInt(normalized.slice(0, 2), 16);
	const g = Number.parseInt(normalized.slice(2, 4), 16);
	const b = Number.parseInt(normalized.slice(4, 6), 16);
	return { r, g, b };
}

export function parseSimpleColor(value: SimpleColorValue): ParsedSimpleColor {
	if (value === "") {
		return { type: "none" };
	}

	if (typeof value === "number") {
		return { type: "ansi256", value };
	}

	if (isThemeColor(value)) {
		return { type: "theme", value };
	}

	if (HEX_COLOR_RE.test(value)) {
		const rgb = parseHex(value);
		return { type: "hex", value, ...rgb };
	}

	return { type: "none" };
}

export function normalizeColorMap(value: unknown): Record<string, ColorConfigValue> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	const result: Record<string, ColorConfigValue> = {};
	for (const [key, rawColor] of Object.entries(value)) {
		if (typeof rawColor === "string" || typeof rawColor === "number") {
			if (!isValidSimpleColorValue(rawColor)) {
				return null;
			}
			result[key] = rawColor;
			continue;
		}
		if (rawColor && typeof rawColor === "object" && !Array.isArray(rawColor)) {
			const stateMap: Record<string, SimpleColorValue> = {};
			for (const [state, stateValue] of Object.entries(rawColor as Record<string, unknown>)) {
				if (!isValidSimpleColorValue(stateValue)) {
					return null;
				}
				stateMap[state] = stateValue as SimpleColorValue;
			}
			result[key] = stateMap;
			continue;
		}

		return null;
	}

	return result;
}

function mergeColorEntries(
	base: ColorConfigValue,
	override: ColorConfigValue,
): ColorConfigValue {
	if (typeof override === "string" || typeof override === "number") {
		return override;
	}
	if (typeof base === "string" || typeof base === "number") {
		if (typeof override === "object") {
			return { ...override };
		}
		return override;
	}

	if (typeof override !== "object") {
		return base;
	}

	return { ...base, ...override };
}

export function mergeColorMaps(
	base: Record<string, ColorConfigValue> = {},
	override: Record<string, ColorConfigValue> = {},
): Record<string, ColorConfigValue> {
	const merged: Record<string, ColorConfigValue> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (merged[key] === undefined) {
			merged[key] = value;
			continue;
		}
		merged[key] = mergeColorEntries(merged[key] as ColorConfigValue, value);
	}
	return merged;
}

export function resolveColorValue(
	colors: Record<string, ColorConfigValue> = {},
	key: string,
	state?: string,
): string {
	const configured = colors[key];
	if (configured !== undefined) {
		if (typeof configured === "string" || typeof configured === "number") {
			return String(configured);
		}
		if (
			state !== undefined &&
			typeof (configured as Record<string, unknown>)[state] === "string"
		) {
			return String((configured as Record<string, unknown>)[state] as string);
		}
		if (state !== undefined && typeof (configured as Record<string, unknown>)[state] === "number") {
			return String((configured as Record<string, unknown>)[state] as number);
		}
		if (typeof configured.default === "string" || typeof configured.default === "number") {
			return String(configured.default);
		}
	}

	const fallback = THEME_DEFAULT_COLORS[key as keyof typeof THEME_DEFAULT_COLORS];
	if (typeof fallback === "string" || typeof fallback === "number") {
		return String(fallback);
	}
	if (typeof fallback === "object") {
		const fallbackMap = fallback as Record<string, string | number>;
		if (state && typeof fallbackMap[state] === "string") {
			return fallbackMap[state] as string;
		}
		if (typeof fallbackMap.default === "string") {
			return fallbackMap.default as string;
		}
	}

	return "";
}

export function colorize(text: string, colorValue: SimpleColorValue, theme: ThemeLike): string {
	if (!text) {
		return text;
	}
	if (!isValidSimpleColorValue(colorValue)) {
		return text;
	}
	const parsed = parseSimpleColor(colorValue as SimpleColorValue);

	if (parsed.type === "none") {
		return text;
	}

	if (parsed.type === "theme") {
		return theme.fg(parsed.value, text);
	}

	if (parsed.type === "ansi256") {
		return `\x1b[38;5;${parsed.value}m${text}\x1b[0m`;
	}

	const { r, g, b } = parsed;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}
