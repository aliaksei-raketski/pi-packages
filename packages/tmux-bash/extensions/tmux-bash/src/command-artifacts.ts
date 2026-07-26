import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CommandArtifacts, TmuxBashConfig } from './types.js';

export function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function artifactPaths(runDir: string, runId: string): CommandArtifacts {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid tmux-bash run ID.');
  return {
    commandFile: join(runDir, `${runId}.command`),
    scriptFile: join(runDir, `${runId}.sh`),
    outputFile: join(runDir, `${runId}.out`),
    exitCodeFile: join(runDir, `${runId}.exit`),
    temporaryExitCodeFile: join(runDir, `${runId}.exit.tmp`),
    liveFile: join(runDir, `${runId}.live`),
    spoolFile: join(runDir, `${runId}.spool.mjs`),
    cleanupSentinelFile: join(runDir, '.cleanup-on-exit'),
  };
}

export async function createCommandArtifacts(input: {
  runDir: string;
  runId: string;
  command: string;
  displayCommand: string;
  config: TmuxBashConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandArtifacts> {
  await mkdir(input.runDir, { recursive: true, mode: 0o700 });
  await chmod(input.runDir, 0o700);
  const artifacts = artifactPaths(input.runDir, input.runId);
  const environment = buildEnvironmentExports(
    input.env ?? process.env,
    new Set(input.config.environmentDenylist),
  );
  const script = buildWrapperScript({
    ...artifacts,
    displayCommand: input.displayCommand,
    environment,
    maxSpoolBytes: input.config.maxSpoolBytes,
    preserveOutputFiles: input.config.preserveOutputFiles,
  });

  await Promise.all([
    writeFile(artifacts.commandFile, `${input.command}\n`, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.outputFile, '', { encoding: 'utf8', mode: 0o600 }),
    writeFile(artifacts.scriptFile, script, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.spoolFile, buildSpoolScript(), { encoding: 'utf8', mode: 0o600 }),
    writeFile(artifacts.liveFile, '', { encoding: 'utf8', mode: 0o600 }),
  ]);
  await Promise.all([chmod(artifacts.commandFile, 0o700), chmod(artifacts.scriptFile, 0o700)]);
  return artifacts;
}

export async function scheduleRunDirectoryCleanup(runDir: string): Promise<void> {
  const sentinel = join(runDir, '.cleanup-on-exit');
  await writeFile(sentinel, '', { encoding: 'utf8', mode: 0o600 });
  const cleanup = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.TMUX_BASH_RUN_DIR;
if (!root) process.exit(1);
for (;;) {
  const names = await readdir(root).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (names === null) process.exit(0);
  if (!names.some((name) => name.endsWith('.live'))) break;
  await delay(250);
}
await rm(root, { recursive: true, force: true });`,
    ],
    {
      detached: true,
      env: { TMUX_BASH_RUN_DIR: runDir },
      stdio: 'ignore',
    },
  );
  cleanup.unref();
}

export function createPiSessionEnvironment(
  ctx: ExtensionContext,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of [
    'PI_SESSION_ID',
    'PI_SESSION_FILE',
    'PI_PROVIDER',
    'PI_MODEL',
    'PI_REASONING_LEVEL',
  ]) {
    delete environment[name];
  }

  environment.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) environment.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    environment.PI_PROVIDER = ctx.model.provider;
    environment.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) environment.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return environment;
}

export function buildEnvironmentExports(
  environment: NodeJS.ProcessEnv,
  denylist: ReadonlySet<string>,
): string[] {
  const validName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  const unsets = [...denylist]
    .filter(validName)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `unset ${name}`);
  const exports = Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        validName(entry[0]) && typeof entry[1] === 'string' && !denylist.has(entry[0]),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  return [...unsets, ...exports];
}

function buildWrapperScript(
  input: CommandArtifacts & {
    displayCommand: string;
    environment: string[];
    maxSpoolBytes: number;
    preserveOutputFiles: boolean;
  },
): string {
  const header = `$ ${input.displayCommand}\n`;
  return `#!/usr/bin/env bash
set +e
umask 077
${input.environment.join('\n')}
run_dir=${shellQuote(dirname(input.outputFile))}
output_file=${shellQuote(input.outputFile)}
command_file=${shellQuote(input.commandFile)}
script_file=${shellQuote(input.scriptFile)}
spool_file=${shellQuote(input.spoolFile)}
live_file=${shellQuote(input.liveFile)}
cleanup_sentinel=${shellQuote(input.cleanupSentinelFile)}
exit_file=${shellQuote(input.exitCodeFile)}
exit_tmp=${shellQuote(input.temporaryExitCodeFile)}
printf %s ${shellQuote(header)} | head -c ${input.maxSpoolBytes} > "$output_file"
shell_binary="${'${BASH:-/bin/bash}'}"
"$shell_binary" "$command_file" 2>&1 | \
  ${shellQuote(process.execPath)} "$spool_file" "$output_file" ${input.maxSpoolBytes}
status=${'${PIPESTATUS[0]}'}
printf '%s\\n' "$status" > "$exit_tmp"
mv -f "$exit_tmp" "$exit_file"
rm -f "$live_file"
if [ -f "$cleanup_sentinel" ]; then
  if ! find "$run_dir" -name '*.live' -print -quit | grep -q .; then
    rm -rf "$run_dir"
  fi
elif [ ${input.preserveOutputFiles ? 'true' : 'false'} != true ]; then
  rm -f "$command_file" "$script_file" "$spool_file"
fi
exit "$status"
`;
}

function buildSpoolScript(): string {
  return `import { open } from 'node:fs/promises';
import { once } from 'node:events';

const [outputFile, maximumText] = process.argv.slice(2);
const maximum = Number(maximumText);
const notice = Buffer.from('\\n[tmux-bash spool limit reached; further output discarded]\\n');
const file = await open(outputFile, 'r+');
let position = (await file.stat()).size;
let truncated = position >= maximum;
if (truncated) {
  const initialNotice = notice.subarray(Math.max(0, notice.length - maximum));
  const initialNoticePosition = maximum - initialNotice.length;
  await file.write(initialNotice, 0, initialNotice.length, initialNoticePosition);
  await file.truncate(maximum);
  position = maximum;
}

for await (const value of process.stdin) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  if (truncated) continue;

  const available = maximum - position;
  if (chunk.length <= available) {
    await file.write(chunk, 0, chunk.length, position);
    position += chunk.length;
    continue;
  }

  const noticeBytes = notice.subarray(Math.max(0, notice.length - maximum));
  const noticePosition = maximum - noticeBytes.length;
  if (position < noticePosition) {
    const dataLength = Math.min(chunk.length, noticePosition - position);
    await file.write(chunk, 0, dataLength, position);
  }
  await file.write(noticeBytes, 0, noticeBytes.length, noticePosition);
  await file.truncate(maximum);
  position = maximum;
  truncated = true;
}

await file.close();
`;
}
