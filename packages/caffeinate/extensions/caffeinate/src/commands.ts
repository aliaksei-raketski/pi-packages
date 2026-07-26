import type { CaffeinateMode } from './inhibitors.ts';

export type CaffeinateCommand =
  | { kind: 'menu' }
  | { kind: 'status' | 'start' | 'stop' | 'enable' | 'disable' | 'help' }
  | { kind: 'mode'; mode: CaffeinateMode }
  | { kind: 'quiet'; enabled: boolean };

const CAFFEINATE_COMMANDS = [
  'status',
  'start',
  'stop',
  'enable',
  'disable',
  'display',
  'sleep',
  'quiet on',
  'quiet off',
  'help',
] as const;

export function parseCaffeinateCommand(args: string): CaffeinateCommand | undefined {
  const trimmed = args.trim();
  if (!trimmed) return { kind: 'menu' };
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    const token = tokens[0];
    if (
      token === 'status' ||
      token === 'start' ||
      token === 'stop' ||
      token === 'enable' ||
      token === 'disable' ||
      token === 'help'
    ) {
      return { kind: token };
    }
    if (token === 'display' || token === 'sleep') return { kind: 'mode', mode: token };
  }
  if (tokens.length === 2 && tokens[0] === 'quiet' && (tokens[1] === 'on' || tokens[1] === 'off')) {
    return { kind: 'quiet', enabled: tokens[1] === 'on' };
  }
  return undefined;
}

export function getCaffeinateCompletions(prefix: string): Array<{ value: string; label: string }> {
  const normalized = prefix.trimStart();
  return CAFFEINATE_COMMANDS.flatMap((value) =>
    value.startsWith(normalized) ? [{ value, label: value }] : [],
  );
}

export function caffeinateHelp(settingsPath: string): string {
  return [
    'Usage: /caffeinate [status|start|stop|enable|disable|display|sleep|quiet on|quiet off|help]',
    `Settings: ${settingsPath}`,
  ].join('\n');
}
