import { expect, test } from 'vitest';
import {
  formatGitStatusChanges,
  formatPullRequest,
  GitStatusCache,
  parseGitStatusPorcelainV2,
} from '../src/git-status.ts';

test('parseGitStatusPorcelainV2 parses branches, ahead/behind, and counts', () => {
  const status = parseGitStatusPorcelainV2(
    '# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 abc def file.txt\n1 MM N... 100644 100644 100644 abc def file2.txt\nu D... 100644 100644 000000000 0000000 9990000 other\n? new.txt\n',
  );

  expect(status.branch).toBe('main');
  expect(status.staged).toBe(2);
  expect(status.unstaged).toBe(1);
  expect(status.untracked).toBe(1);
  expect(status.conflict).toBe(1);
  expect(status.ahead).toBe(2);
  expect(status.behind).toBe(1);
  expect(formatGitStatusChanges(status)).toBe('!1 +2 ~1 ?1 ↑2 ↓1');
});

test('formatPullRequest accepts numbers and numeric strings', () => {
  expect(formatPullRequest({ number: 42 })).toBe('PR #42');
  expect(formatPullRequest({ number: '99' })).toBe('PR #99');
  expect(formatPullRequest({ number: '123' })).toBe('PR #123');
  expect(formatPullRequest({ number: 'abc' })).toBe(undefined);
});

test('GitStatusCache clears stale snapshots when invalidated', async () => {
  const cache = new GitStatusCache({
    cwd: () => '/tmp',
    includeGitStatus: true,
    includePullRequest: false,
    refreshIntervalMs: 100,
    runner: async () => ({
      stdout:
        '# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 abc def file.txt\n',
      stderr: '',
      exitCode: 0,
    }),
  });

  await cache.refresh();
  expect(cache.getGitInfo().gitStatus?.staged).toBe(1);

  cache.invalidate();
  expect(cache.getGitInfo().gitStatus).toBe(undefined);
  expect(cache.getGitInfo().pullRequest).toBe(undefined);

  cache.dispose();
});

test('GitStatusCache refreshes and deduplicates snapshots', async () => {
  const clock = {
    setInterval: () => Symbol('timer'),
    clearInterval: () => {
      // no-op
    },
  };
  const gitOutputs = [
    '# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n',
    '# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n',
    '# branch.oid 111\n# branch.head main\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 abc def file.txt\n',
    '# branch.oid 222\n# branch.head feature\n# branch.ab +0 -0\n',
  ];
  const prOutputs = ['{"number":101}\n', '{"number":101}\n', '{"number":101}\n', '\n'];
  let gitIndex = 0;
  let prIndex = 0;
  let changeCount = 0;

  const cache = new GitStatusCache({
    cwd: () => '/tmp',
    includeGitStatus: true,
    includePullRequest: true,
    refreshIntervalMs: 60_000,
    runner: async (command, _args, _options) => {
      if (command === 'git') {
        const output = gitOutputs[gitIndex++];
        if (!output) {
          throw new Error('Unexpected git command');
        }
        return {
          stdout: output,
          stderr: '',
          exitCode: 0,
        };
      }

      const output = prOutputs[prIndex++];
      if (!output && command === 'gh') {
        return {
          stdout: '',
          stderr: '',
          exitCode: 1,
        };
      }
      return {
        stdout: output,
        stderr: '',
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
  expect(first.gitStatus?.branch).toBe('main');
  expect(first.pullRequest?.number).toBe(101);
  expect(changeCount).toBe(1);

  await cache.refresh();
  expect(changeCount).toBe(1);

  await cache.refresh();
  expect(cache.getGitInfo().gitStatus?.staged).toBe(1);
  expect(changeCount).toBe(2);

  await cache.refresh();
  expect(cache.getGitInfo().gitStatus?.branch).toBe('feature');
  expect(cache.getGitInfo().pullRequest).toBe(undefined);
  expect(changeCount).toBe(3);

  cache.dispose();
});
