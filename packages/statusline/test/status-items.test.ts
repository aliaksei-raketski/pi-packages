import assert from "node:assert/strict";
import { basename } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext, ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { collectStatusItems } from "../src/status-items.ts";
import type { GitStatusSnapshot } from "../src/git-status.ts";

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

function createGitStatus(status: Partial<GitStatusSnapshot>): GitStatusSnapshot {
	return {
		branch: undefined,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflict: 0,
		ahead: 0,
		behind: 0,
		...status,
	};
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

test("collectStatusItems exposes extension status keys by token", () => {
	const ctx = createContext("/tmp");
	const footerData = createFooterProvider({
		getExtensionStatuses: () => new Map([ ["lsp", "ready"], ["build", "pass"] ]),
	});

	const items = collectStatusItems(ctx, pi, footerData, new Set(["cwd", "lsp", "build"]));
	assert.equal(items.get("lsp")?.text, "ready");
	assert.equal(items.get("build")?.text, "pass");
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

test("collectStatusItems marks branch as clean when git state is clean", () => {
	const ctx = createContext("/tmp");
	const items = collectStatusItems(
		ctx,
		pi,
		createFooterProvider({
			getGitBranch: () => "main",
		}),
		new Set(["branch"]),
		{
			gitStatus: createGitStatus({
				branch: "main",
			}),
		},
	);
	assert.equal(items.get("branch")?.state, "clean");
});

test("collectStatusItems marks branch as dirty when git state has changes", () => {
	const ctx = createContext("/tmp");
	const items = collectStatusItems(
		ctx,
		pi,
		createFooterProvider({
			getGitBranch: () => "main",
		}),
		new Set(["branch"]),
		{
			gitStatus: createGitStatus({
				branch: "main",
				unstaged: 1,
			}),
		},
	);
	assert.equal(items.get("branch")?.state, "dirty");
});

test("collectStatusItems exposes pull request number as separate token", () => {
	const ctx = createContext("/tmp");
	const items = collectStatusItems(
		ctx,
		pi,
		createFooterProvider({
			getGitBranch: () => "main",
		}),
		new Set(["pr"]),
		{
			gitStatus: createGitStatus({
				branch: "main",
			}),
			pullRequest: {
				number: 123,
			},
		},
	);
	assert.equal(items.get("pr")?.text, "PR #123");
});

test("collectStatusItems uses package.json name for project", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-project-"));
	try {
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({ name: "my-statusline-project" }),
			"utf-8",
		);

		const ctx = createContext(cwd);
		const items = collectStatusItems(ctx, pi, createFooterProvider({}), new Set(["project"]));
		assert.equal(items.get("project")?.text, "my-statusline-project");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectStatusItems falls back to directory name for project", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-project-fallback-"));
	try {
		const ctx = createContext(cwd);
		const items = collectStatusItems(ctx, pi, createFooterProvider({}), new Set(["project"]));
		assert.equal(items.get("project")?.text, basename(cwd));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectStatusItems builds changes using git-style symbols", () => {
	const ctx = createContext("/tmp");
	const items = collectStatusItems(
		ctx,
		pi,
		createFooterProvider({
			getGitBranch: () => "main",
		}),
		new Set(["changes"]),
		{
			gitStatus: createGitStatus({
				branch: "main",
				staged: 1,
				unstaged: 1,
				untracked: 1,
			}),
		},
	);
	assert.equal(items.get("changes")?.text, "+1 ~1 ?1");
});

test("collectStatusItems counts untracked files, including nested entries", () => {
	const ctx = createContext("/tmp");
	const items = collectStatusItems(
		ctx,
		pi,
		createFooterProvider({
			getGitBranch: () => "main",
		}),
		new Set(["changes"]),
		{
			gitStatus: createGitStatus({
				branch: "main",
				untracked: 2,
			}),
		},
	);
	assert.equal(items.get("changes")?.text, "?2");
});
