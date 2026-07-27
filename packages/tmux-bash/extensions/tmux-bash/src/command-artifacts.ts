import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { CommandArtifacts, TmuxBashConfig } from './types.js';

const execFileAsync = promisify(execFile);

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
    rotationMarkerFile: join(runDir, `${runId}.rotated`),
    manifestPath: join(runDir, `${runId}.manifest.json`),
    streamFile: join(runDir, `${runId}.stream`),
  };
}

export async function createCommandArtifacts(input: {
  runDir: string;
  runId: string;
  command: string;
  displayCommand: string;
  config: TmuxBashConfig;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
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
    maxArtifactBytesPerRun: Math.min(
      input.config.maxArtifactBytesPerRun,
      input.config.maxSpoolBytes,
    ),
    streamFile: input.streamOutput ? artifacts.streamFile : undefined,
  });

  await Promise.all([
    writeFile(artifacts.commandFile, `${input.command}\n`, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.outputFile, '', { encoding: 'utf8', mode: 0o600 }),
    writeFile(artifacts.scriptFile, script, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.spoolFile, buildSpoolScript(), { encoding: 'utf8', mode: 0o600 }),
    writeFile(artifacts.liveFile, '', { encoding: 'utf8', mode: 0o600 }),
  ]);
  await Promise.all([chmod(artifacts.commandFile, 0o700), chmod(artifacts.scriptFile, 0o700)]);
  if (input.streamOutput && artifacts.streamFile) {
    const created = await execFileAsync('mkfifo', ['-m', '600', artifacts.streamFile]);
    if (created.stderr) throw new Error(`Failed to create user bash stream: ${created.stderr}`);
  }
  return artifacts;
}

export async function removeUncommittedArtifacts(runDir: string, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(runId)) {
    throw new Error('Invalid tmux-bash run ID for artifact rollback.');
  }
  const names = await readdir(runDir).catch(() => []);
  for (const name of names) {
    if (name !== runId && !name.startsWith(`${runId}.`)) continue;
    const path = join(runDir, name);
    const details = await lstat(path).catch(() => undefined);
    if (!details || (!details.isFile() && !details.isSymbolicLink() && !details.isFIFO())) continue;
    await rm(path, { force: true });
  }
}

export async function scheduleRunArtifactCleanup(runDir: string, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(runId)) throw new Error('Invalid tmux-bash run ID.');
  const cleanup = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.TMUX_BASH_RUN_DIR;
const runId = process.env.TMUX_BASH_RUN_ID;
if (!root || !runId) process.exit(1);
const live = join(root, runId + '.live');
while (await lstat(live).then(() => true, (error) => {
  if (error?.code === 'ENOENT') return false;
  throw error;
})) await delay(250);
const names = await readdir(root).catch((error) => {
  if (error?.code === 'ENOENT') return [];
  throw error;
});
for (const name of names) {
  if (name === runId || name.startsWith(runId + '.')) await rm(join(root, name), { force: true });
}`,
    ],
    {
      detached: true,
      env: { TMUX_BASH_RUN_DIR: runDir, TMUX_BASH_RUN_ID: runId },
      stdio: 'ignore',
    },
  );
  cleanup.unref();
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

export function createUserBashEnvironment(
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
  return environment;
}

export function createPiSessionEnvironment(
  ctx: ExtensionContext,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = createUserBashEnvironment(baseEnvironment);
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

function buildEnvironmentExports(
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
    maxArtifactBytesPerRun: number;
    streamFile?: string;
  },
): string {
  const header = `$ ${input.displayCommand}\n`;
  const headerWasTruncated = Buffer.byteLength(header) > input.maxArtifactBytesPerRun;
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
printf %s ${shellQuote(header)} | head -c ${input.maxArtifactBytesPerRun} > "$output_file"
${headerWasTruncated ? `: > ${shellQuote(input.rotationMarkerFile)}` : ''}
shell_binary="${'${BASH:-/bin/bash}'}"
"$shell_binary" "$command_file" 2>&1 | \
  ${shellQuote(process.execPath)} "$spool_file" "$output_file" ${input.maxArtifactBytesPerRun} ${shellQuote(input.rotationMarkerFile)} ${shellQuote(input.streamFile ?? '')}
status=${'${PIPESTATUS[0]}'}
printf '%s\\n' "$status" > "$exit_tmp"
mv -f "$exit_tmp" "$exit_file"
rm -f "$live_file"
if [ -f "$cleanup_sentinel" ]; then
  if ! find "$run_dir" -name '*.live' -print -quit | grep -q .; then
    rm -rf "$run_dir"
  fi
fi
exit "$status"
`;
}

function buildSpoolScript(): string {
  return `import { createWriteStream } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';

const [outputFile, maximumText, rotationMarkerFile, streamFile] = process.argv.slice(2);
const maximum = Number(maximumText);
const notice = Buffer.from('[tmux-bash spool limit reached; earlier output truncated; showing bounded tail]\\n');
let file = await open(outputFile, 'a');
let position = (await file.stat()).size;
const stream = streamFile ? createWriteStream(streamFile) : undefined;
if (stream) await once(stream, 'open');

async function rotate(chunk) {
  await file.close();
  const current = await readFile(outputFile).catch(() => Buffer.alloc(0));
  const tailBytes = Math.max(0, maximum - notice.length);
  const combined = Buffer.concat([current, chunk]);
  const tail = combined.subarray(Math.max(0, combined.length - tailBytes));
  const boundedNotice = notice.subarray(0, Math.min(notice.length, maximum));
  const next = maximum <= notice.length ? boundedNotice : Buffer.concat([boundedNotice, tail]);
  await writeFile(outputFile, next.subarray(0, maximum), { mode: 0o600 });
  await writeFile(rotationMarkerFile, '', { mode: 0o600 });
  file = await open(outputFile, 'a');
  position = (await file.stat()).size;
}

for await (const value of process.stdin) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  if (stream && !stream.write(chunk)) await once(stream, 'drain');
  if (position + chunk.length > maximum) {
    await rotate(chunk);
  } else {
    await file.write(chunk);
    position += chunk.length;
  }
}

await file.close();
if (stream) {
  stream.end();
  await once(stream, 'close');
}
`;
}
