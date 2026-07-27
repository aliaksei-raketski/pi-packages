import { Text } from '@earendil-works/pi-tui';

import type { BashInput, TmuxInput } from './schemas.js';
import { sanitizeTerminalText } from './sanitize.js';
import type { TmuxBashDetails, TmuxToolDetails } from './types.js';

export function renderBashCall(args: BashInput, theme: ThemeLike) {
  const safeCommand = sanitizeTerminalText(args.command);
  const command = safeCommand.length > 100 ? `${safeCommand.slice(0, 97)}...` : safeCommand;
  const mode = args.background ? ' bg' : '';
  const awaited = args.waitForCompletion ? ' awaited' : '';
  return new Text(
    `${theme.fg('toolTitle', theme.bold('$ '))}${theme.fg('accent', command)}${theme.fg('dim', `${mode}${awaited}`)}`,
    0,
    0,
  );
}

export function renderBashResult(
  result: { content: Array<{ type: string; text?: string }>; details?: TmuxBashDetails },
  options: { expanded: boolean; isPartial: boolean },
  theme: ThemeLike,
  displayLimits: CompletedDisplayLimits = {
    completedCompactDisplayLines: 5,
    completedExpandedDisplayLines: 20,
  },
) {
  if (options.isPartial) {
    const output = sanitizeTerminalText(
      result.content.find((item) => item.type === 'text')?.text ?? 'Running...',
    );
    return new Text(theme.fg('warning', compact(output, options.expanded ? 20 : 4)), 0, 0);
  }
  const details = result.details;
  if (!details) {
    const output = result.content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => sanitizeTerminalText(item.text ?? ''))
      .join('\n');
    return new Text(theme.fg(output ? 'error' : 'dim', output || 'No output'), 0, 0);
  }
  const color =
    details.state === 'completed' ? 'success' : details.state === 'running' ? 'warning' : 'error';
  let text = theme.fg(
    color,
    details.state === 'running'
      ? `running ${details.windowId ?? ''}`
      : `${details.state}${details.exitCode === undefined ? '' : ` (${details.exitCode})`}`,
  );
  if (details.awaited) text += theme.fg('warning', ' · awaited');
  const flags = [
    details.completionDelivery ? `completion=${details.completionDelivery}` : '',
    details.adopted ? 'adopted' : '',
    details.outputWasRotated ? 'output rotated' : '',
  ].filter(Boolean);
  if (flags.length > 0) text += theme.fg('dim', ` · ${flags.join(' · ')}`);
  const output = sanitizeTerminalText(
    result.content.find((item) => item.type === 'text')?.text ?? '',
  );
  if (output) {
    const displayLines = options.expanded
      ? displayLimits.completedExpandedDisplayLines
      : displayLimits.completedCompactDisplayLines;
    text += `\n${theme.fg('dim', compactCompletedOutput(output, displayLines, details.outputFile))}`;
  }
  return new Text(text, 0, 0);
}

export function renderTmuxCall(args: TmuxInput, theme: ThemeLike) {
  const target = args.windowId ? ` ${sanitizeTerminalText(args.windowId)}` : '';
  return new Text(
    `${theme.fg('toolTitle', theme.bold('tmux '))}${theme.fg('accent', args.action)}${theme.fg('dim', target)}`,
    0,
    0,
  );
}

export function renderTmuxResult(
  result: { content: Array<{ type: string; text?: string }>; details?: TmuxToolDetails },
  options: { expanded: boolean; isPartial: boolean },
  theme: ThemeLike,
) {
  const output = sanitizeTerminalText(
    result.content.find((item) => item.type === 'text')?.text ?? '',
  );
  return new Text(
    theme.fg(options.isPartial ? 'warning' : 'dim', compact(output, options.expanded ? 100 : 12)),
    0,
    0,
  );
}

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface CompletedDisplayLimits {
  completedCompactDisplayLines: number;
  completedExpandedDisplayLines: number;
}

function compact(value: string, maxLines: number): string {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return value;
  return `${lines.slice(-maxLines).join('\n')}\n…`;
}

function compactCompletedOutput(value: string, maxLines: number, outputFile: string): string {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return value;

  const modelTruncationNotice = lines[0]?.startsWith('[Output truncated:')
    ? lines.shift()
    : undefined;
  const metadataLines = 2;
  const tailLines = lines.slice(-(maxLines - metadataLines));
  const omittedLines = lines.length - tailLines.length;
  const notice = modelTruncationNotice ?? `Full output: ${outputFile}`;
  return [notice, `… ${omittedLines} earlier lines omitted from display …`, ...tailLines].join(
    '\n',
  );
}
