import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_STATUSLINE_CONFIG,
	loadStatuslineConfig,
} from "../src/config.ts";

function withTempFiles(files: Record<string, unknown>): {
	cwd: string;
	paths: { user: string; project: string };
	cleanup: () => void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-config-"));
	const user = join(cwd, "user.json");
	const project = join(cwd, "project.json");

	for (const [pathKey, content] of Object.entries(files)) {
		const path = pathKey === "user" ? user : project;
		writeFileSync(path, JSON.stringify(content), "utf-8");
	}

	return {
		cwd,
		paths: { user, project },
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}
test("loads defaults when no config files exist", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-default-"));
	const result = loadStatuslineConfig({
		cwd,
		isProjectTrusted: () => true,
		paths: {
			user: join(cwd, "user.json"),
			project: join(cwd, "project.json"),
		},
	});
	assert.equal(result.diagnostics.length, 0);
	assert.deepEqual(result.config.layout, DEFAULT_STATUSLINE_CONFIG.layout);
	assert.equal(result.config.separator, DEFAULT_STATUSLINE_CONFIG.separator);
	assert.equal(result.config.separatorColor, DEFAULT_STATUSLINE_CONFIG.separatorColor);
	rmSync(cwd, { recursive: true, force: true });
});

test("accepts a flat layout and merges user config", () => {
	const { cwd, paths, cleanup } = withTempFiles({
		user: {
			layout: ["cwd", "spacer", "model"],
			separator: " | ",
			separatorColor: "#8aadf4",
			prefix: {
				cwd: "🏠",
			},
			colors: {
				cost: 120,
			},
		},
	});
	const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
	assert.equal(result.diagnostics.length, 0);
	assert.deepEqual(result.config.layout, [["cwd", "spacer", "model"]]);
	assert.equal(result.config.separator, " | ");
	assert.equal(result.config.separatorColor, "#8aadf4");
	assert.equal(result.config.prefix.cwd, "🏠");
	assert.equal(result.config.colors.cost, 120);
	cleanup();
});

test("accepts deprecated icons alias", () => {
	const { cwd, paths, cleanup } = withTempFiles({
		user: {
			icons: {
				cwd: "🏠",
			},
		},
	});
	const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
	assert.equal(result.diagnostics.length, 0);
	assert.equal(result.config.prefix.cwd, "🏠");
	cleanup();
});

test("supports nested layouts from project config when trusted", () => {
	const { cwd, paths, cleanup } = withTempFiles({
		user: { layout: ["cwd", "spacer", "branch"] },
		project: { layout: [["cwd"], ["model"]] },
	});
	const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
	assert.equal(result.diagnostics.length, 0);
	assert.deepEqual(result.config.layout, [["cwd"], ["model"]]);
	cleanup();
});

test("rejects mixed layout shapes and falls back to defaults", () => {
	const { cwd, paths, cleanup } = withTempFiles({
		user: { layout: ["cwd", ["branch"]] },
	});
	const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
	assert.ok(result.diagnostics.length > 0);
	assert.ok(result.diagnostics.some((message) => message.includes("layout")));
	assert.deepEqual(result.config.layout, DEFAULT_STATUSLINE_CONFIG.layout);
	cleanup();
});

test("ignores project config when project is not trusted", () => {
	const user = mkdtempSync(join(tmpdir(), "pi-statusline-untrusted-"));
	const userPath = join(user, "user.json");
	const projectPath = join(user, "project.json");
	writeFileSync(userPath, JSON.stringify({ layout: ["cwd"] }), "utf-8");
	writeFileSync(projectPath, JSON.stringify({ layout: ["model"] }), "utf-8");

	const result = loadStatuslineConfig({
		cwd: user,
		isProjectTrusted: () => false,
		paths: {
			user: userPath,
			project: projectPath,
		},
	});

	assert.equal(result.config.layout[0]?.[0], "cwd");
	assert.deepEqual(result.config.layout, [["cwd"]]);
	assert.equal(result.diagnostics.length, 0);
	rmSync(user, { recursive: true, force: true });
});


test("merges explicit project config over valid user config", () => {
	const { cwd, paths, cleanup } = withTempFiles({
		user: { separator: " a ", separatorColor: "muted" },
		project: { separator: " b " },
	});
	const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
	assert.equal(result.config.separator, " b ");
	assert.equal(result.config.separatorColor, "muted");
	cleanup();
});
