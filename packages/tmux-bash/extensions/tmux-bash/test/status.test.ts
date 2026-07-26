import { describe, expect, it } from 'vitest';

import { collectTmuxBashStatus } from '../src/status.js';
import type { CommandRun } from '../src/types.js';

function run(overrides: Partial<CommandRun> = {}): CommandRun {
  return {
    runId: 'run',
    sessionId: 'session',
    gitRoot: '/repo',
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
    startedAt: 1,
    mode: 'background',
    backgroundReady: true,
    completionDelivered: false,
    completionClaimed: false,
    completionDeliveryFailures: 0,
    completionDeliveryFailed: false,
    killed: false,
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
    expect(collectTmuxBashStatus([run(), run({ runId: 'two', gateId: 'tmux:two' })])).toMatchObject(
      {
        text: '2 bg jobs · 1 awaited',
        state: 'awaiting',
        fallbackColor: 'warning',
      },
    );
  });

  it('ignores foreground, completed, and killed commands', () => {
    expect(
      collectTmuxBashStatus([
        run({ mode: 'foreground' }),
        run({ endedAt: 2, exitCode: 0 }),
        run({ killed: true }),
      ]),
    ).toBeUndefined();
  });
});
