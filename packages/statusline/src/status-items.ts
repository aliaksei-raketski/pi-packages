import { existsSync, readFileSync } from "node:fs";
import { relative, basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionContext, ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

export interface StatusValue {
	text: string;
	state?: string;
}

export type BuiltinStatusKey =
	| "cwd"
	| "branch"
	| "title"
	| "model"
	| "thinking"
	| "changes"
	| "context"
	| "tokens"
	| "cache"
	| "cost"
	| "project"
	| "statuses";

const BUILTIN_STATUS_KEYS: Set<string> = new Set([
	"cwd",
	"branch",
	"title",
	"model",
	"thinking",
	"changes",
	"context",
	"tokens",
	"cache",
	"cost",
	"project",
	"statuses",
]);

function isBuiltinStatusKey(key: string): key is BuiltinStatusKey {
	return BUILTIN_STATUS_KEYS.has(key);
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1000) {
		return `${(value / 1000).toFixed(1)}k`;
	}
	return `${Math.round(value)}`;
}

function formatContextWindow(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (value >= 1000) {
		return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	}
	return `${Math.round(value)}`;
}

function formatContextPercent(percent: number): string {
	return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

function shortPath(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		const suffix = cwd === home ? "" : relative(home, cwd);
		return `~${suffix ? `/${suffix}` : ""}`;
	}
	return basename(cwd);
}

function collectProjectValue(cwd: string): string {
	const packagePath = join(cwd, "package.json");
	if (!existsSync(packagePath)) {
		return basename(cwd);
	}

	try {
		const raw = readFileSync(packagePath, "utf-8");
		const parsed = JSON.parse(raw) as { name?: unknown };
		if (typeof parsed.name === "string" && parsed.name) {
			return parsed.name;
		}
	} catch {
		return basename(cwd);
	}

	return basename(cwd);
}

function collectUsageTotals(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") {
			continue;
		}

		const message = entry.message as {
			role?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			};
		};

		if (message.role !== "assistant" || !message.usage) {
			continue;
		}

		const usage = message.usage;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}

	return totals;
}

function parseAheadBehind(branchLine: string): { ahead: number; behind: number } {
	const openBracket = branchLine.indexOf("[");
	if (openBracket === -1) {
		return { ahead: 0, behind: 0 };
	}

	const closeBracket = branchLine.indexOf("]", openBracket);
	if (closeBracket === -1) {
		return { ahead: 0, behind: 0 };
	}

	const summary = branchLine.slice(openBracket + 1, closeBracket);
	const aheadMatch = /ahead (\d+)/.exec(summary);
	const behindMatch = /behind (\d+)/.exec(summary);

	return {
		ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
		behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
	};
}

function collectChangesValue(cwd: string): StatusValue | undefined {
	const result = spawnSync("git", ["status", "--short", "--branch", "--untracked-files=all"], {
		cwd,
		encoding: "utf-8",
		windowsHide: true,
		timeout: 2000,
		maxBuffer: 1024 * 1024,
	});

	if (result.error || result.status !== 0) {
		return undefined;
	}

	const raw = result.stdout;
	if (!raw) {
		return undefined;
	}

	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let conflicts = 0;
	let ahead = 0;
	let behind = 0;

	for (const line of raw.split(/\r?\n/)) {
		if (!line) {
			continue;
		}

		if (line.startsWith("## ")) {
			const aheadBehind = parseAheadBehind(line);
			ahead = aheadBehind.ahead;
			behind = aheadBehind.behind;
			continue;
		}

		if (line[0] === "?" && line[1] === "?") {
			untracked += 1;
			continue;
		}

		if (line[0] === "U" || line[1] === "U") {
			conflicts += 1;
			continue;
		}

		if (line[0] && line[0] !== " ") {
			staged += 1;
		}

		if (line[1] && line[1] !== " ") {
			unstaged += 1;
		}
	}

	const parts: string[] = [];
	if (conflicts > 0) {
		parts.push(`!${conflicts}`);
	}
	if (staged > 0) {
		parts.push(`+${staged}`);
	}
	if (unstaged > 0) {
		parts.push(`~${unstaged}`);
	}
	if (untracked > 0) {
		parts.push(`?${untracked}`);
	}
	if (ahead > 0) {
		parts.push(`↑${ahead}`);
	}
	if (behind > 0) {
		parts.push(`↓${behind}`);
	}

	if (parts.length === 0) {
		return undefined;
	}

	return { text: parts.join(" ") };
}

function collectContextValue(ctx: ExtensionContext): StatusValue | undefined {
	const contextUsage = ctx.getContextUsage();
	if (!contextUsage || contextUsage.tokens === null || contextUsage.percent === null) {
		return undefined;
	}

	const percent = contextUsage.percent;
	const value = `${formatContextPercent(percent)}/${formatContextWindow(contextUsage.contextWindow)}`;

	let state: string;
	if (percent >= 90) {
		state = "full";
	} else if (percent >= 70) {
		state = "warning";
	} else {
		state = "normal";
	}

	return { text: value, state };
}

function collectModelValue(ctx: ExtensionContext): StatusValue | undefined {
	const model = ctx.model;
	if (!model) {
		return { text: "unknown" };
	}

	const modelData = model as { id?: string; modelId?: string };
	const modelId =
		typeof modelData.id === "string"
			? modelData.id
			: typeof modelData.modelId === "string"
				? modelData.modelId
				: "unknown";

	return { text: modelId };
}

function collectThinkingValue(pi: ExtensionAPI): StatusValue {
	const level = pi.getThinkingLevel();
	return { text: level, state: level };
}

export function collectStatusItems(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: ReadonlyFooterDataProvider,
	requestedKeys: Set<string> = new Set(),
): Map<string, StatusValue> {
	const items = new Map<string, StatusValue>();
	const should = (key: string): boolean => requestedKeys.size === 0 || requestedKeys.has(key);

	if (should("cwd")) {
		items.set("cwd", { text: shortPath(ctx.cwd) });
	}

	if (should("branch")) {
		const branch = footerData.getGitBranch();
		if (branch) {
			items.set("branch", { text: branch, state: "normal" });
		}
	}

	if (should("title")) {
		const sessionName = ctx.sessionManager.getSessionName();
		if (sessionName) {
			items.set("title", { text: sessionName });
		}
	}

	if (should("model")) {
		const model = collectModelValue(ctx);
		if (model) {
			items.set("model", model);
		}
	}

	if (should("thinking")) {
		items.set("thinking", collectThinkingValue(pi));
	}

	if (should("changes")) {
		const changes = collectChangesValue(ctx.cwd);
		if (changes) {
			items.set("changes", changes);
		}
	}

	if (should("project")) {
		items.set("project", { text: collectProjectValue(ctx.cwd) });
	}

	if (should("context")) {
		const contextValue = collectContextValue(ctx);
		if (contextValue) {
			items.set("context", contextValue);
		}
	}

	const includeUsage = should("tokens") || should("cache") || should("cost");
	if (includeUsage) {
		const usageTotals = collectUsageTotals(ctx);

		if (should("tokens")) {
			const tokensValue = `${formatNumber(usageTotals.input)}↑ ${formatNumber(usageTotals.output)}↓`;
			items.set("tokens", { text: tokensValue });
		}

		if (should("cache")) {
			const totalCache = usageTotals.cacheRead + usageTotals.cacheWrite;
			const cacheHitPercent = totalCache > 0 ? Math.round((usageTotals.cacheRead / totalCache) * 100) : 0;
			items.set("cache", { text: `${formatNumber(usageTotals.cacheRead)}/${formatNumber(usageTotals.cacheWrite)} ${cacheHitPercent}%` });
		}

		if (should("cost")) {
			items.set("cost", { text: `$${usageTotals.cost.toFixed(2)}` });
		}
	}

	const customStatusKeys = Array.from(requestedKeys).filter(
		(key) => !isBuiltinStatusKey(key) && key !== "spacer",
	);

	if (should("statuses") || customStatusKeys.length > 0) {
		const statuses = footerData.getExtensionStatuses();
		if (should("statuses") && statuses.size > 0) {
			const entries = Array.from(statuses.entries()).map(([name, text]) => `${name}: ${text}`);
			items.set("statuses", { text: entries.join(" • ") });
		}

		for (const key of customStatusKeys) {
			const status = statuses.get(key);
			if (status !== undefined) {
				items.set(key, { text: status });
			}
		}
	}

	return items;
}
