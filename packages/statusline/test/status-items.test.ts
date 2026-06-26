import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { ExtensionContext, ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { collectStatusItems } from "../src/status-items.ts";

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		model: { provider: "test-provider", modelId: "test-model" },
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => [],
			getSessionName: () => "test session",
		},
	} as unknown as ExtensionContext;
}

const pi: ExtensionAPI = {
	getThinkingLevel: () => "off",
} as ExtensionAPI;

function createFooterProvider(overrides: Partial<ReadonlyFooterDataProvider>): ReadonlyFooterDataProvider {
	return {
		getExtensionStatuses: () => new Map(),
		getGitBranch: () => null,
		...overrides,
	} as ReadonlyFooterDataProvider;
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr ?? "git command failed");
	}
	return result.stdout ?? "";
}

test("collectStatusItems only queries requested keys", () => {
	const ctx = createContext("/tmp");
	const footerData = createFooterProvider({
		getGitBranch: () => {
			throw new Error("git branch should not be requested");
		},
		getExtensionStatuses: () => {
			throw new Error("statuses should not be requested");
		},
	});

	const items = collectStatusItems(ctx, pi, footerData, new Set(["cwd", "model", "thinking"]));
	assert.equal(items.has("statuses"), false);
	assert.equal(items.has("branch"), false);
	assert.equal(items.get("model")?.text, "test-model");
	assert.equal(items.get("thinking")?.text, "off");
	assert.equal(items.get("cwd")?.text, "tmp");
});

test("collectStatusItems exposes extension statuses when explicitly requested", () => {
	const ctx = createContext("/tmp");
	const footerData = createFooterProvider({
		getExtensionStatuses: () => new Map([ ["lsp", "ready"] ]),
	});

	const items = collectStatusItems(ctx, pi, footerData, new Set(["statuses"]));
	assert.equal(items.get("statuses")?.text, "lsp: ready");
});

test("collectStatusItems formats context as percent/context-window", () => {
	const ctx = createContext("/tmp");
	(ctx as ExtensionContext & { getContextUsage: () => unknown }).getContextUsage = () => ({
		tokens: 64000,
		percent: 52.5,
		contextWindow: 128000,
	});

	const items = collectStatusItems(ctx, pi, createFooterProvider({}), new Set(["context"]));
	assert.equal(items.get("context")?.text, "52.5%/128k");
});

test("collectStatusItems builds changes using git-style symbols", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-changes-"));
	try {
		runGit(cwd, ["init"]);
		runGit(cwd, ["config", "user.name", "pi-statusline"]);
		runGit(cwd, ["config", "user.email", "test@example.com"]);
		writeFileSync(join(cwd, "a.txt"), "first\n", "utf-8");
		runGit(cwd, ["add", "a.txt"]);
		runGit(cwd, ["commit", "-m", "init"],);

		writeFileSync(join(cwd, "a.txt"), "first\nsecond\n", "utf-8");
		runGit(cwd, ["add", "a.txt"]);
		writeFileSync(join(cwd, "a.txt"), "first\nsecond\nthird\n", "utf-8");
		writeFileSync(join(cwd, "b.txt"), "new\n", "utf-8");

		const ctx = createContext(cwd);
		const items = collectStatusItems(ctx, pi, createFooterProvider({}), new Set(["changes"]));
		assert.equal(items.get("changes")?.text, "+1 ~1 ?1");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectStatusItems counts untracked files, including nested entries", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-changes-all-"));
	try {
		runGit(cwd, ["init"]);
		runGit(cwd, ["config", "user.name", "pi-statusline"]);
		runGit(cwd, ["config", "user.email", "test@example.com"]);

		mkdirSync(join(cwd, "u"));
		writeFileSync(join(cwd, "u", "a.txt"), "one\n", "utf-8");
		writeFileSync(join(cwd, "u", "b.txt"), "two\n", "utf-8");

		const ctx = createContext(cwd);
		const items = collectStatusItems(ctx, pi, createFooterProvider({}), new Set(["changes"]));
		assert.equal(items.get("changes")?.text, "?2");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
