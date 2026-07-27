import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { CommandArtifacts, TmuxBashConfig } from './types.js';

const execFileAsync = promisify(execFile);
export const STRUCTURAL_ARTIFACT_HEADROOM_BYTES = 32 * 1024;
// Covers the bounded manifest, exit/rotation markers, completion claim, temporary
// sentinel, and other fixed launch metadata in addition to the three scripts.
const STRUCTURAL_METADATA_OVERHEAD_BYTES = 8 * 1024;
const RUN_ARTIFACT_SUFFIXES = [
  '.command',
  '.sh',
  '.out',
  '.exit',
  '.exit.tmp',
  '.live',
  '.spool.mjs',
  '.rotated',
  '.rotated.tmp',
  '.completion.claim',
  '.manifest.json',
  '.stream',
] as const;

export interface DetachedCleanupOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  onError?: (error: Error) => void;
}

export function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function isRunArtifactFileName(name: string, runId: string): boolean {
  return RUN_ARTIFACT_SUFFIXES.some((suffix) => name === `${runId}${suffix}`);
}

export function artifactRunIdFromFileName(name: string): string | undefined {
  const suffix = RUN_ARTIFACT_SUFFIXES.find((candidate) => name.endsWith(candidate));
  if (!suffix) return undefined;
  const runId = name.slice(0, -suffix.length);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(runId) ? runId : undefined;
}

export function artifactPaths(runDir: string, runId: string): CommandArtifacts {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid tmux-bash run ID.');
  }
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
  unsetEnvironment?: readonly string[];
  streamOutput?: boolean;
}): Promise<CommandArtifacts> {
  await mkdir(input.runDir, { recursive: true, mode: 0o700 });
  await chmod(input.runDir, 0o700);
  const artifacts = artifactPaths(input.runDir, input.runId);
  const environment = buildEnvironmentExports(
    input.env ?? process.env,
    new Set([...input.config.environmentDenylist, ...(input.unsetEnvironment ?? [])]),
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
  const spoolScript = buildSpoolScript();
  const structuralBytes =
    Buffer.byteLength(input.command) +
    1 +
    Buffer.byteLength(script) +
    Buffer.byteLength(spoolScript) +
    STRUCTURAL_METADATA_OVERHEAD_BYTES;
  if (structuralBytes > STRUCTURAL_ARTIFACT_HEADROOM_BYTES) {
    throw new Error(
      `tmux-bash launch artifacts exceed the ${STRUCTURAL_ARTIFACT_HEADROOM_BYTES}-byte structural limit.`,
    );
  }

  await Promise.all([
    writeFile(artifacts.commandFile, `${input.command}\n`, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.outputFile, '', { encoding: 'utf8', mode: 0o600 }),
    writeFile(artifacts.scriptFile, script, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.spoolFile, spoolScript, { encoding: 'utf8', mode: 0o600 }),
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
    if (!isRunArtifactFileName(name, runId)) continue;
    const path = join(runDir, name);
    const details = await lstat(path).catch(() => undefined);
    if (!details || (!details.isFile() && !details.isSymbolicLink() && !details.isFIFO())) continue;
    await rm(path, { force: true });
  }
}

export async function scheduleRunArtifactCleanup(
  runDir: string,
  runId: string,
  options: DetachedCleanupOptions = {},
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(runId))
    throw new Error('Invalid tmux-bash run ID.');
  const cleanup = (options.spawn ?? spawn)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.TMUX_BASH_RUN_DIR;
const runId = process.env.TMUX_BASH_RUN_ID;
const artifactNames = new Set(JSON.parse(process.env.TMUX_BASH_ARTIFACT_NAMES ?? '[]'));
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
  if (artifactNames.has(name)) await rm(join(root, name), { force: true });
}`,
    ],
    {
      detached: true,
      env: {
        TMUX_BASH_RUN_DIR: runDir,
        TMUX_BASH_RUN_ID: runId,
        TMUX_BASH_ARTIFACT_NAMES: JSON.stringify(
          RUN_ARTIFACT_SUFFIXES.map((suffix) => `${runId}${suffix}`),
        ),
      },
      stdio: 'ignore',
    },
  );
  await detachCleanupProcess(cleanup, options.onError);
}

export async function scheduleRunDirectoryCleanup(
  runDir: string,
  options: DetachedCleanupOptions = {},
): Promise<void> {
  const sentinel = join(runDir, '.cleanup-on-exit');
  await writeFile(sentinel, '', { encoding: 'utf8', mode: 0o600 });
  const cleanup = (options.spawn ?? spawn)(
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
  await detachCleanupProcess(cleanup, options.onError);
}

async function detachCleanupProcess(
  cleanup: ChildProcess,
  onError: ((error: Error) => void) | undefined,
): Promise<void> {
  const report = (error: Error) => onError?.(error);
  cleanup.on('error', report);
  cleanup.on('exit', (code, signal) => {
    if (code === 0) return;
    report(
      new Error(
        `Detached cleanup process failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}.`,
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      cleanup.off('error', failed);
      resolve();
    };
    const failed = (error: Error) => {
      cleanup.off('spawn', spawned);
      reject(error);
    };
    cleanup.once('spawn', spawned);
    cleanup.once('error', failed);
  });
  cleanup.unref();
}

export const PI_SESSION_ENVIRONMENT_VARIABLES = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
] as const;

export function createUserBashEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of PI_SESSION_ENVIRONMENT_VARIABLES) delete environment[name];
  return environment;
}

export function createPiSessionEnvironment(
  ctx: ExtensionContext,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = createUserBashEnvironment(baseEnvironment);

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
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';

const [outputFile, maximumText, rotationMarkerFile, streamFile] = process.argv.slice(2);
const maximum = Number(maximumText);
const notice = Buffer.from('[tmux-bash spool limit reached; earlier output truncated; showing bounded tail]\\n');
const boundedNotice = notice.subarray(0, Math.min(notice.length, maximum));
const tailBytes = Math.max(0, maximum - boundedNotice.length);
let file = await open(outputFile, 'a');
let position = (await file.stat()).size;
let rotated = false;
let ringWrite = 0;
let ringLength = 0;
let totalBytes = position;
let metadataGeneration = 0;
let stream = streamFile ? createWriteStream(streamFile) : undefined;
if (stream) {
  stream.on('error', () => {
    stream = undefined;
  });
  await once(stream, 'open').catch(() => {
    stream = undefined;
  });
}

async function rotate(chunk) {
  await writeRingMetadata(false, true);
  await file.close();
  const current = await readFile(outputFile).catch(() => Buffer.alloc(0));
  const combined = Buffer.concat([current, chunk]);
  const tail = combined.subarray(Math.max(0, combined.length - tailBytes));
  const next = maximum <= boundedNotice.length ? boundedNotice : Buffer.concat([boundedNotice, tail]);
  await writeFile(outputFile, next.subarray(0, maximum), { mode: 0o600 });
  file = await open(outputFile, 'r+');
  rotated = true;
  ringLength = tail.length;
  ringWrite = tailBytes === 0 ? 0 : ringLength % tailBytes;
  await writeRingMetadata(false);
}

async function writeRingMetadata(finalized, writing = false) {
  const temporaryMarker = rotationMarkerFile + '.tmp';
  metadataGeneration += 1;
  await writeFile(temporaryMarker, JSON.stringify({
    version: 2,
    generation: metadataGeneration,
    finalized,
    writing,
    noticeBytes: boundedNotice.length,
    tailBytes,
    ringWrite,
    ringLength,
    totalBytes,
  }), { mode: 0o600 });
  await rename(temporaryMarker, rotationMarkerFile);
}

async function appendRing(chunk) {
  if (tailBytes === 0) return;
  let value = chunk;
  if (value.length >= tailBytes) {
    value = value.subarray(value.length - tailBytes);
    await file.write(value, 0, value.length, boundedNotice.length);
    ringLength = tailBytes;
    ringWrite = 0;
    return;
  }
  let offset = 0;
  while (offset < value.length) {
    const amount = Math.min(value.length - offset, tailBytes - ringWrite);
    await file.write(value, offset, amount, boundedNotice.length + ringWrite);
    offset += amount;
    ringWrite = (ringWrite + amount) % tailBytes;
    ringLength = Math.min(tailBytes, ringLength + amount);
  }
}

for await (const value of process.stdin) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + chunk.length);
  if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  if (stream) {
    try {
      if (!stream.write(chunk)) await once(stream, 'drain');
    } catch {
      stream = undefined;
    }
  }
  if (!rotated && position + chunk.length > maximum) {
    await rotate(chunk);
  } else if (rotated) {
    await writeRingMetadata(false, true);
    await appendRing(chunk);
  } else {
    await file.write(chunk);
    position += chunk.length;
  }
  if (rotated) await writeRingMetadata(false);
}

if (rotated) {
  await writeRingMetadata(false, true);
  await file.close();
}
if (rotated && tailBytes > 0) {
  const current = await readFile(outputFile).catch(() => Buffer.alloc(0));
  const ring = current.subarray(boundedNotice.length, boundedNotice.length + tailBytes);
  const ordered = ringLength < tailBytes
    ? ring.subarray(0, ringLength)
    : Buffer.concat([ring.subarray(ringWrite), ring.subarray(0, ringWrite)]);
  await writeFile(outputFile, Buffer.concat([boundedNotice, ordered]).subarray(0, maximum), { mode: 0o600 });
  ringLength = ordered.length;
  ringWrite = 0;
}
if (rotated) await writeRingMetadata(true);
if (!rotated) await file.close();
if (stream) {
  try {
    stream.end();
    await once(stream, 'close');
  } catch {
    // A detached user-bash reader must not terminate the command spool.
  }
}
`;
}
