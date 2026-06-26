import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	THEME_DEFAULT_COLORS,
	colorize,
	isThemeColor,
	isValidSimpleColorValue,
	mergeColorMaps,
	normalizeColorMap,
	parseSimpleColor,
	resolveColorValue,
} from "../src/colors.ts";

const fakeTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

test("accepts theme/hex/256/simple values", () => {
	assert.equal(isThemeColor("muted"), true);
	assert.equal(isThemeColor("#abc"), false);
	assert.equal(isValidSimpleColorValue("#ff0000"), true);
	assert.equal(isValidSimpleColorValue(240), true);
	assert.equal(isValidSimpleColorValue(""), true);
	assert.equal(isValidSimpleColorValue(999), false);
	assert.equal(isValidSimpleColorValue("unknown"), false);
});

test("parses theme and ANSI values", () => {
	const parsedTheme = parseSimpleColor("warning");
	assert.equal(parsedTheme.type, "theme");
	assert.equal(parsedTheme.type === "theme" ? parsedTheme.value : "", "warning");

	const parsedHex = parseSimpleColor("#336699");
	assert.equal(parsedHex.type, "hex");
	assert.equal(parsedHex.r, 51);
	assert.equal(parsedHex.g, 102);
	assert.equal(parsedHex.b, 153);

	const parsedAnsi = parseSimpleColor(42);
	assert.equal(parsedAnsi.type, "ansi256");
	assert.equal(parsedAnsi.type === "ansi256" ? parsedAnsi.value : 0, 42);
});

test("resolves stateful color values with fallback", () => {
	const colors = {
		context: {
			warning: "warning",
		},
		thinking: {
			off: "dim",
		},
	};
	const fromState = resolveColorValue(colors, "context", "warning");
	const fromFallback = resolveColorValue(colors, "context", "full");
	assert.equal(fromState, "warning");
	assert.equal(fromFallback, THEME_DEFAULT_COLORS.context.full);
	assert.equal(resolveColorValue({}, "model", "off"), THEME_DEFAULT_COLORS.model);
	assert.equal(resolveColorValue({}, "branch", "clean"), THEME_DEFAULT_COLORS.branch.clean);
	assert.equal(resolveColorValue({}, "branch", "dirty"), THEME_DEFAULT_COLORS.branch.dirty);
});

test("normalizes color maps with string-number values", () => {
	const parsed = normalizeColorMap({
		cwd: "#aabbcc",
		cache: 128,
		context: {
			warning: "warning",
			full: 196,
		},
		thinking: {
			off: "thinkingOff",
		},
	});
	assert.deepEqual(parsed, {
		cwd: "#aabbcc",
		cache: 128,
		context: {
			warning: "warning",
			full: 196,
		},
		thinking: {
			off: "thinkingOff",
		},
	});
});

test("merges configured colors and objects", () => {
	const merged = mergeColorMaps(
		{ cwd: "muted", thinking: { off: "muted", default: "warning" } },
		{ thinking: { off: "thinkingOff" }, cache: "dim" },
	);
	assert.deepEqual(merged, {
		cwd: "muted",
		thinking: { off: "thinkingOff", default: "warning" },
		cache: "dim",
	});
});

test("applies ANSI and theme colors via colorize", () => {
	assert.equal(colorize("hello", "#336699", fakeTheme), "\x1b[38;2;51;102;153mhello\x1b[0m");
	assert.equal(colorize("hello", 31, fakeTheme), "\x1b[38;5;31mhello\x1b[0m");
	assert.equal(colorize("hello", "warning", fakeTheme), "<warning>hello</warning>");
	assert.equal(colorize("hello", "", fakeTheme), "hello");
	assert.equal(colorize("hello", "bad", fakeTheme), "hello");
});
