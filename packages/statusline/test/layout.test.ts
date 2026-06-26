import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "../src/ansi-utils.ts";
import { normalizeLayout, renderLayoutLine, renderLayoutLines, type StatuslineLayout } from "../src/layout.ts";

const values = new Map<string, string>([
	["cwd", "shell"],
	["branch", "main"],
	["model", "gpt"],
	["statuses", "x=ok"],
]);

const tokenText = (key: string): string | undefined => values.get(key);

test("normalizes flat layout as single footer line", () => {
	assert.deepEqual(normalizeLayout(["cwd", "spacer", "model"]), [["cwd", "spacer", "model"]]);
});

test("normalizes nested layout as multiple lines", () => {
	assert.deepEqual(normalizeLayout([["cwd", "spacer", "branch"], ["model"]]), [
		["cwd", "spacer", "branch"],
		["model"],
	]);
});

test("rejects mixed layout shapes", () => {
	assert.equal(normalizeLayout(["cwd", ["model"]]), null);
});

test("renders spacer gap with width distribution", () => {
	const line = ["cwd", "spacer", "model"]; // 4 + 1 + 4 visible + 4? not counting? fixed width 9
	const rendered = renderLayoutLine(line, tokenText, " • ", 10);
	assert.equal(rendered, "shell  gpt");
	assert.equal(visibleWidth(rendered), 10);
});

test("supports multiple spacers as centered flexible gaps", () => {
	const line = ["cwd", "spacer", "branch", "spacer", "model"];
	const rendered = renderLayoutLine(line, tokenText, "", 14);
	assert.equal(rendered, "shell main gpt");
	assert.equal(visibleWidth(rendered), 14);
});

test("renders multiple layout rows", () => {
	const layout: StatuslineLayout = [["cwd", "spacer", "branch"], ["model"]];
	const rendered = renderLayoutLines(layout, tokenText, "", 20);
	assert.equal(rendered.length, 2);
	assert.equal(rendered[0], "shell           main");
	assert.equal(rendered[1], "gpt");
	assert.equal(visibleWidth(rendered[0]), 20);
});

test("collapses empty-only lines", () => {
	const values = new Map<string, string>([
		["cwd", "shell"],
		["model", "gpt"],
	]);
	const layout: StatuslineLayout = [["title"], ["cwd", "model"]];
	const rendered = renderLayoutLines(layout, (key) => values.get(key), " • ", 80);
	assert.deepEqual(rendered, ["shell • gpt"]);
});

test("collapses all-empty output into no rows", () => {
	const layout: StatuslineLayout = [["title"], ["branch"]];
	const rendered = renderLayoutLines(layout, () => undefined, " • ", 80);
	assert.deepEqual(rendered, []);
});

test("drops empty leading segments in a line", () => {
	const rendered = renderLayoutLine(
		["branch", "changes", "spacer", "model"],
		(token) => {
			if (token === "model") {
				return "gpt";
			}
			return undefined;
		},
		" • ",
		20,
	);
	assert.equal(rendered, "gpt");
});

test("handles ANSI-coded values safely while truncating", () => {
	const ansiValues = new Map<string, string>([
		["cwd", "\x1b[31mvery-long-project-path\x1b[0m"],
	]);
	const ansiToken = (key: string): string | undefined => ansiValues.get(key);
	const rendered = renderLayoutLine(["cwd"], ansiToken, "", 10);
	assert.ok(rendered.startsWith("\x1b[31m"));
	assert.equal(visibleWidth(rendered), 10);
	assert.ok(rendered.endsWith("\x1b[0m"));
});

test("counts wide symbols (emoji) when truncating", () => {
	const values = new Map<string, string>([["cwd", "🤖super"], ["spacer", " "]]);
	const rendered = renderLayoutLine(["cwd"], (key) => values.get(key), "", 4);
	assert.equal(visibleWidth(rendered), 3);
});

test("falls back to one item per line on narrow terminals", () => {
	const narrowLayout: StatuslineLayout = [["cwd", "spacer", "model", "spacer", "thinking"]];
	const narrowValues = new Map<string, string>([
		["cwd", "shell"],
		["model", "gpt"],
		["thinking", "off"],
	]);
	const rendered = renderLayoutLines(narrowLayout, (key) => narrowValues.get(key), " • ", 6);
	assert.deepEqual(rendered, ["shell", "gpt", "off"]);
	assert.equal(visibleWidth(rendered[0]), 5);
	assert.equal(rendered.length, 3);
});
