import assert from "node:assert/strict";
import test from "node:test";
import {
	formatGitStatusChanges,
	formatPullRequest,
	GitStatusCache,
	parseGitStatusPorcelainV2,
} from "../src/git-status.ts";

test("parseGitStatusPorcelainV2 parses branches, ahead/behind, and counts", () => {
	const status = parseGitStatusPorcelainV2(
		"# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 abc def file.txt\n1 MM N... 100644 100644 100644 abc def file2.txt\nu D... 100644 100644 000000000 0000000 9990000 other\n? new.txt\n",
	);

	assert.equal(status.branch, "main");
	assert.equal(status.staged, 2);
	assert.equal(status.unstaged, 1);
	assert.equal(status.untracked, 1);
	assert.equal(status.conflict, 1);
	assert.equal(status.ahead, 2);
	assert.equal(status.behind, 1);
	assert.equal(formatGitStatusChanges(status), "!1 +2 ~1 ?1 ↑2 ↓1");
});

test("formatPullRequest accepts numbers and numeric strings", () => {
	assert.equal(formatPullRequest({ number: 42 }), "PR #42");
	assert.equal(formatPullRequest({ number: "99" }), "PR #99");
	assert.equal(formatPullRequest({ number: "123" }), "PR #123");
	assert.equal(formatPullRequest({ number: "abc" }), undefined);
});

test("GitStatusCache clears stale snapshots when invalidated", async () => {
	const cache = new GitStatusCache({
		cwd: () => "/tmp",
		includeGitStatus: true,
		includePullRequest: false,
		refreshIntervalMs: 100,
		runner: async () => ({
			stdout: "# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 abc def file.txt\n",
			stderr: "",
			exitCode: 0,
		}),
	});

	await cache.refresh();
	assert.equal(cache.getGitInfo().gitStatus?.staged, 1);

	cache.invalidate();
	assert.equal(cache.getGitInfo().gitStatus, undefined);
	assert.equal(cache.getGitInfo().pullRequest, undefined);

	cache.dispose();
});

test("GitStatusCache refreshes and deduplicates snapshots", async () => {
	const clock = {
		setInterval: () => Symbol("timer"),
		clearInterval: () => {
			// no-op
		},
	};
	const gitOutputs = [
		"# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n",
		"# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n",
		"# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 abc def file.txt\n",
		"# branch.oid 222\n# branch.head feature\n# branch.ab +0 -0\n",
	];
	const prOutputs = [
		'{"number":101}\n',
		'{"number":101}\n',
		'{"number":101}\n',
		"\n",
	];
	let gitIndex = 0;
	let prIndex = 0;
	let changeCount = 0;

	const cache = new GitStatusCache({
		cwd: () => "/tmp",
		includeGitStatus: true,
		includePullRequest: true,
		refreshIntervalMs: 60_000,
		runner: async (command, _args, _options) => {
			if (command === "git") {
				const output = gitOutputs[gitIndex++];
				if (!output) {
					throw new Error("Unexpected git command");
				}
				return {
					stdout: output,
					stderr: "",
					exitCode: 0,
				};
			}

			const output = prOutputs[prIndex++];
			if (!output && command === "gh") {
				return {
					stdout: "",
					stderr: "",
					exitCode: 1,
				};
			}
			return {
				stdout: output,
				stderr: "",
				exitCode: 0,
			};
		},
		clock,
		onChange: () => {
			changeCount += 1;
		},
	});

	await cache.refresh();
	const first = cache.getGitInfo();
	assert.equal(first.gitStatus?.branch, "main");
	assert.equal(first.pullRequest?.number, 101);
	assert.equal(changeCount, 1);

	await cache.refresh();
	assert.equal(changeCount, 1, "unchanged snapshots should not trigger callback");

	await cache.refresh();
	assert.equal(cache.getGitInfo().gitStatus?.staged, 1);
	assert.equal(changeCount, 2);

	await cache.refresh();
	assert.equal(cache.getGitInfo().gitStatus?.branch, "feature");
	assert.equal(cache.getGitInfo().pullRequest, undefined);
	assert.equal(changeCount, 3);

	cache.dispose();
});
