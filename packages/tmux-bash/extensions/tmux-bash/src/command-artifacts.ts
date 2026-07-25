import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  });

  await Promise.all([
    writeFile(artifacts.commandFile, `${input.command}\n`, { encoding: 'utf8', mode: 0o700 }),
    writeFile(artifacts.outputFile, '', { encoding: 'utf8', mode: 0o600 }),
    writeFile(artifacts.scriptFile, script, { encoding: 'utf8', mode: 0o700 }),
  ]);
  await Promise.all([chmod(artifacts.commandFile, 0o700), chmod(artifacts.scriptFile, 0o700)]);
  return artifacts;
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
  return Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        typeof entry[1] === 'string' &&
        !denylist.has(entry[0]),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
}

function buildWrapperScript(
  input: CommandArtifacts & { displayCommand: string; environment: string[] },
): string {
  const header = `$ ${input.displayCommand}\n`;
  return `#!/usr/bin/env bash
set +e
umask 077
${input.environment.join('\n')}
output_file=${shellQuote(input.outputFile)}
command_file=${shellQuote(input.commandFile)}
exit_file=${shellQuote(input.exitCodeFile)}
exit_tmp=${shellQuote(input.temporaryExitCodeFile)}
printf %s ${shellQuote(header)} > "$output_file"
shell_binary="${'${SHELL:-/bin/bash}'}"
"$shell_binary" "$command_file" 2>&1 | tee -a "$output_file"
status=${'${PIPESTATUS[0]}'}
printf '%s\\n' "$status" > "$exit_tmp"
mv -f "$exit_tmp" "$exit_file"
exit "$status"
`;
}
