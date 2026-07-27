export interface StructuredTmuxCommand {
  binary: string;
  args: string[];
  display: string;
}

export function buildAttachCommand(input: {
  binary: string;
  sessionName: string;
  windowId: string;
  insideTmux?: boolean;
}): StructuredTmuxCommand {
  assertBinary(input.binary);
  assertWindowId(input.windowId);
  assertSafeValue(input.sessionName, 'tmux session name');

  const args = input.insideTmux
    ? ['switch-client', '-t', input.sessionName, ';', 'select-window', '-t', input.windowId]
    : ['attach-session', '-t', input.sessionName, ';', 'select-window', '-t', input.windowId];
  return {
    binary: input.binary,
    args,
    display: [input.binary, ...args].map(shellQuote).join(' '),
  };
}

export function shellQuote(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function assertWindowId(windowId: string): void {
  if (!/^@\d+$/.test(windowId)) throw new Error(`Invalid tmux window ID: ${windowId}.`);
}

function assertBinary(value: string): void {
  assertSafeValue(value, 'tmux binary');
  if (/\s/.test(value)) throw new Error('Tmux binary must not contain whitespace.');
}

function assertSafeValue(value: string, label: string): void {
  if (!value || value.includes('\0') || Buffer.byteLength(value) > 4096) {
    throw new Error(`Invalid ${label}.`);
  }
}
