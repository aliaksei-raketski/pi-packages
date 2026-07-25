import { formatSize, truncateTail, type TruncationResult } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';

export interface FormattedOutput {
  text: string;
  raw: string;
  truncation?: TruncationResult;
}

export async function readOutput(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function readExitCode(path: string): Promise<number | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    if (!/^-?\d+$/.test(value)) return undefined;
    const exitCode = Number(value);
    return Number.isSafeInteger(exitCode) ? exitCode : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function formatOutput(
  raw: string,
  options: { maxLines: number; maxBytes: number; fullOutputPath: string },
): FormattedOutput {
  const truncation = truncateTail(raw, {
    maxLines: options.maxLines,
    maxBytes: options.maxBytes,
  });
  if (!truncation.truncated) return { text: truncation.content, raw };

  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  const notice = `[Output truncated: showing the last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}); ${omittedLines} lines/${formatSize(omittedBytes)} omitted. Full output: ${options.fullOutputPath}]`;
  return {
    text: `${notice}\n${truncation.content}`,
    raw,
    truncation,
  };
}

export function tailLines(output: string, lineCount: number): string {
  const lines = output.split('\n');
  return lines.slice(-Math.max(1, lineCount)).join('\n');
}
