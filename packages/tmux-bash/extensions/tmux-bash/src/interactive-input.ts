import type { InteractiveKey, TmuxBashConfig } from './types.js';

const KEYS = new Set<InteractiveKey>(['enter', 'escape', 'ctrl-c', 'ctrl-d']);

export function validateLiteralInput(config: TmuxBashConfig, text: string): void {
  if (!config.interactiveInputEnabled) throw new Error('Interactive tmux input is disabled.');
  if (text.includes('\0')) throw new Error('Interactive tmux input cannot contain NUL bytes.');
  const bytes = Buffer.byteLength(text);
  if (bytes > config.maxInputBytes) {
    throw new Error(`Interactive tmux input exceeds ${config.maxInputBytes} bytes.`);
  }
}

export function validateInteractiveKey(config: TmuxBashConfig, key: InteractiveKey): void {
  if (!config.interactiveInputEnabled) throw new Error('Interactive tmux input is disabled.');
  if (!KEYS.has(key)) throw new Error(`Unsupported interactive tmux key: ${String(key)}.`);
}
