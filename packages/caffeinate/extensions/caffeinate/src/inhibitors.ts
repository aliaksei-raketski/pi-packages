export type CaffeinateMode = 'display' | 'sleep';

export interface InhibitorCandidate {
  id: string;
  command: string;
  args: string[];
  kind: 'macos' | 'systemd' | 'caffeinate' | 'powershell';
  mode: CaffeinateMode;
}

export interface PlatformInfo {
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  pathSeparator?: string;
  executableSuffixes?: readonly string[];
}

export const WINDOWS_SLEEP_FLAGS = 0x80000001;
export const WINDOWS_DISPLAY_FLAGS = 0x80000003;
export const WINDOWS_CLEAR_FLAGS = 0x80000000;

/** The script deliberately owns the request for the lifetime of stdin. */
export const POWERSHELL_INHIBITOR_SCRIPT = `
$ErrorActionPreference = 'Stop'
$flags = [uint32]{{FLAGS}}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PiCaffeinatePower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
try {
  [PiCaffeinatePower]::SetThreadExecutionState($flags) | Out-Null
  while ($null -ne [Console]::In.ReadLine()) {
    [PiCaffeinatePower]::SetThreadExecutionState($flags) | Out-Null
  }
} finally {
  [PiCaffeinatePower]::SetThreadExecutionState([uint32]0x80000000) | Out-Null
}
`.trim();

export function powerShellScript(mode: CaffeinateMode): string {
  return POWERSHELL_INHIBITOR_SCRIPT.replace(
    '{{FLAGS}}',
    String(mode === 'display' ? WINDOWS_DISPLAY_FLAGS : WINDOWS_SLEEP_FLAGS),
  );
}

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || /microsoft/i.test(env.OS ?? ''));
}

export function getPowerShellCommands(info: PlatformInfo = {}): string[] {
  const suffixes =
    info.executableSuffixes ?? (info.platform === 'win32' || isWsl(info.env) ? ['.exe'] : ['']);
  const names = ['powershell', 'pwsh'];
  return names.map((name) => `${name}${suffixes[0] ?? ''}`);
}

/**
 * Build candidates without probing or spawning. Missing executables are handled by the process
 * layer, which can advance to the next candidate after a spawn error or early exit.
 */
export function buildInhibitorCandidates(
  info: PlatformInfo = {},
  mode: CaffeinateMode = 'display',
) {
  const platform = info.platform ?? process.platform;
  if (platform === 'darwin') {
    return [
      {
        id: `macos-caffeinate-${mode}`,
        command: 'caffeinate',
        args: mode === 'sleep' ? ['-ims'] : ['-dimsu'],
        kind: 'macos' as const,
        mode,
      },
    ];
  }

  if (platform === 'win32' || (platform === 'linux' && isWsl(info.env))) {
    return getPowerShellCommands(info).map((command, index) => ({
      id: `powershell-${index}`,
      command,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powerShellScript(mode)],
      kind: 'powershell' as const,
      mode,
    }));
  }

  if (platform === 'linux') {
    return [
      {
        id: 'systemd-inhibit',
        command: 'systemd-inhibit',
        args: [
          `--what=${mode === 'sleep' ? 'sleep' : 'idle:sleep'}`,
          '--who=pi-caffeinate',
          '--mode=block',
          '--why=Keep the computer awake while Pi is active',
          'sleep',
          'infinity',
        ],
        kind: 'systemd' as const,
        mode,
      },
      {
        id: 'caffeinate-fallback',
        command: 'caffeinate',
        args: mode === 'sleep' ? ['-ims'] : ['-dimsu'],
        kind: 'caffeinate' as const,
        mode,
      },
    ];
  }

  return [];
}

export function candidatePathNames(command: string, info: PlatformInfo = {}): string[] {
  const separator = info.pathSeparator ?? (info.platform === 'win32' ? ';' : ':');
  const suffixes = info.executableSuffixes ?? (info.platform === 'win32' ? ['.exe', ''] : ['']);
  return command.split(separator).flatMap((entry) => suffixes.map((suffix) => `${entry}${suffix}`));
}
