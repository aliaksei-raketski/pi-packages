import { formatSize, truncateTail, type TruncationResult } from '@earendil-works/pi-coding-agent';
import { open, readFile } from 'node:fs/promises';

import { sanitizeTerminalText } from './sanitize.js';

export interface OutputTail {
  content: string;
  totalBytes: number;
  readBytes: number;
  truncated: boolean;
}

export interface FormattedOutput {
  text: string;
  raw: string;
  truncation?: TruncationResult;
}

export async function readOutput(path: string, maxBytes: number): Promise<OutputTail> {
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const readBytes = Math.min(size, Math.max(1, Math.floor(maxBytes)));
    const buffer = Buffer.allocUnsafe(readBytes);
    const { bytesRead } = await file.read(buffer, 0, readBytes, size - readBytes);
    const completeUtf8 = trimIncompleteUtf8Prefix(buffer.subarray(0, bytesRead));
    return {
      content: completeUtf8.toString('utf8'),
      totalBytes: size,
      readBytes: bytesRead,
      truncated: size > bytesRead,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: '', totalBytes: 0, readBytes: 0, truncated: false };
    }
    throw error;
  } finally {
    await file?.close();
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
  output: string | OutputTail,
  options: { maxLines: number; maxBytes: number; fullOutputPath: string },
): FormattedOutput {
  const source =
    typeof output === 'string'
      ? {
          content: output,
          totalBytes: Buffer.byteLength(output),
          readBytes: Buffer.byteLength(output),
          truncated: false,
        }
      : output;
  const sanitized = sanitizeTerminalText(source.content);
  const boundedTail = truncateTail(sanitized, {
    maxLines: options.maxLines,
    maxBytes: options.maxBytes,
  });
  const truncation: TruncationResult = source.truncated
    ? {
        ...boundedTail,
        truncated: true,
        truncatedBy: 'bytes',
        totalBytes: source.totalBytes,
      }
    : boundedTail;
  if (!truncation.truncated) {
    return { text: truncation.content, raw: sanitized };
  }

  const omittedBytes = Math.max(0, source.totalBytes - truncation.outputBytes);
  const notice = source.truncated
    ? `[Output truncated: showing a bounded tail (${formatSize(truncation.outputBytes)} of ${formatSize(source.totalBytes)}); ${formatSize(omittedBytes)} omitted. Full output: ${options.fullOutputPath}]`
    : `[Output truncated: showing the last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}); ${truncation.totalLines - truncation.outputLines} lines/${formatSize(omittedBytes)} omitted. Full output: ${options.fullOutputPath}]`;
  return {
    text: `${notice}\n${truncation.content}`,
    raw: sanitized,
    truncation,
  };
}

function trimIncompleteUtf8Prefix(buffer: Buffer): Buffer {
  let offset = 0;
  while (offset < Math.min(buffer.length, 3)) {
    const byte = buffer[offset];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    offset += 1;
  }
  return buffer.subarray(offset);
}
