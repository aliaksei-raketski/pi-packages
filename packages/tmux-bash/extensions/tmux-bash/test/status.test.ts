import { describe, expect, it } from 'vitest';

import { collectTmuxBashStatus } from '../src/status.js';
import type { CommandRun } from '../src/types.js';

function run(overrides: Partial<CommandRun> = {}): CommandRun {
  return {
    runId: 'run-12345678',
    completionId: 'completion-12345678',
    sessionId: 'session',
    scope: { kind: 'git-root', root: '/repo', hash: '12345678', displayName: 'repo' },
    cwd: '/repo',
    tmuxSession: 'pi-repo',
    windowId: '@1',
    command: 'sleep 1',
    displayCommand: 'sleep 1',
    commandFile: '/tmp/run.command',
    scriptFile: '/tmp/run.sh',
    outputFile: '/tmp/run.out',
    exitCodeFile: '/tmp/run.exit',
    temporaryExitCodeFile: '/tmp/run.exit.tmp',
    liveFile: '/tmp/run.live',
    spoolFile: '/tmp/run.spool.mjs',
    cleanupSentinelFile: '/tmp/.cleanup-on-exit',
    rotationMarkerFile: '/tmp/run.rotated',
    manifestPath: '/tmp/run.manifest.json',
    startedAt: 1,
    mode: 'background',
    state: 'running',
    backgroundReady: true,
    awaited: false,
    continuationDomain: 'default',
    completionDelivery: 'model',
    deliveryState: 'pending',
    completionDelivered: false,
    completionClaimed: false,
    completionDeliveryFailures: 0,
    completionDeliveryFailed: false,
    killed: false,
    adopted: false,
    outputWasRotated: false,
    ...overrides,
  };
}

describe('tmux-bash status', () => {
  it('counts active background and awaited commands', () => {
    expect(collectTmuxBashStatus([run()])).toMatchObject({
      text: '1 bg job',
      state: 'running',
      fallbackColor: 'accent',
    });
    expect(
      collectTmuxBashStatus([run(), run({ runId: 'two-12345678', gateId: 'tmux:two' })]),
    ).toMatchObject({
      text: '2 bg jobs · 1 awaited',
      state: 'awaiting',
      fallbackColor: 'warning',
    });
  });

  it('keeps an idle indicator after ignoring foreground, completed, and killed commands', () => {
    expect(collectTmuxBashStatus([])).toMatchObject({
      text: '0 bg jobs',
      state: 'idle',
      fallbackColor: 'muted',
    });
    expect(
      collectTmuxBashStatus([
        run({ mode: 'foreground' }),
        run({ endedAt: 2, exitCode: 0 }),
        run({ killed: true }),
      ]),
    ).toMatchObject({
      text: '0 bg jobs',
      state: 'idle',
      fallbackColor: 'muted',
    });
  });
});
