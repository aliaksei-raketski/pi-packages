import { formatSize, truncateTail, type TruncationResult } from '@earendil-works/pi-coding-agent';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

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

interface RotationMetadata {
  version: 2;
  generation: number;
  finalized: boolean;
  writing: boolean;
  noticeBytes: number;
  tailBytes: number;
  ringWrite: number;
  ringLength: number;
  totalBytes: number;
}

export async function readOutput(path: string, maxBytes: number): Promise<OutputTail> {
  return readOutputSnapshot(path, maxBytes, 0);
}

async function readOutputSnapshot(
  path: string,
  maxBytes: number,
  attempt: number,
): Promise<OutputTail> {
  const rotation = await readRotationMetadata(path);
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('Command output artifact is not a regular file.');
    if (rotation && !rotation.finalized) {
      if (rotation.writing) {
        if (attempt < 2) return readOutputSnapshot(path, maxBytes, attempt + 1);
        throw new Error('Command output rotation is still being written.');
      }
      let result: OutputTail;
      try {
        result = await readLiveRing(file, stats.size, rotation, maxBytes);
      } catch (error) {
        if (attempt < 2) return readOutputSnapshot(path, maxBytes, attempt + 1);
        throw error;
      }
      const current = await readRotationMetadata(path);
      if (
        !current ||
        current.finalized ||
        current.writing ||
        current.generation !== rotation.generation
      ) {
        if (attempt < 2) return readOutputSnapshot(path, maxBytes, attempt + 1);
      } else {
        return result;
      }
      throw new Error('Command output changed during a bounded live-tail read.');
    }
    const { size } = stats;
    const readBytes = Math.min(size, Math.max(1, Math.floor(maxBytes)));
    const buffer = Buffer.allocUnsafe(readBytes);
    const { bytesRead } = await file.read(buffer, 0, readBytes, size - readBytes);
    const completeUtf8 = trimIncompleteUtf8Prefix(buffer.subarray(0, bytesRead));
    return {
      content: completeUtf8.toString('utf8'),
      totalBytes: rotation?.finalized ? Math.max(rotation.totalBytes, size) : size,
      readBytes: bytesRead,
      truncated: (rotation?.finalized ? Math.max(rotation.totalBytes, size) : size) > bytesRead,
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

async function readRotationMetadata(path: string): Promise<RotationMetadata | undefined> {
  if (!path.endsWith('.out')) return undefined;
  const markerPath = `${path.slice(0, -'.out'.length)}.rotated`;
  let marker;
  try {
    marker = await open(
      markerPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stats = await marker.stat();
    if (!stats.isFile() || stats.size > 1024) return undefined;
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await marker.read(buffer, 0, buffer.length, 0);
    const value = JSON.parse(
      buffer.subarray(0, bytesRead).toString('utf8'),
    ) as Partial<RotationMetadata>;
    const { noticeBytes, tailBytes, ringWrite, ringLength, totalBytes } = value;
    if (
      value.version !== 2 ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      typeof value.finalized !== 'boolean' ||
      typeof value.writing !== 'boolean' ||
      typeof noticeBytes !== 'number' ||
      typeof tailBytes !== 'number' ||
      typeof ringWrite !== 'number' ||
      typeof ringLength !== 'number' ||
      typeof totalBytes !== 'number' ||
      !Number.isSafeInteger(noticeBytes) ||
      !Number.isSafeInteger(tailBytes) ||
      !Number.isSafeInteger(ringWrite) ||
      !Number.isSafeInteger(ringLength) ||
      !Number.isSafeInteger(totalBytes) ||
      noticeBytes < 0 ||
      tailBytes < 0 ||
      ringWrite < 0 ||
      ringLength < 0 ||
      totalBytes < 0 ||
      ringWrite > tailBytes ||
      ringLength > tailBytes
    ) {
      return undefined;
    }
    return {
      version: 2,
      generation: value.generation,
      finalized: value.finalized,
      writing: value.writing,
      noticeBytes,
      tailBytes,
      ringWrite,
      ringLength,
      totalBytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    return undefined;
  } finally {
    await marker?.close();
  }
}

async function readLiveRing(
  file: Awaited<ReturnType<typeof open>>,
  size: number,
  rotation: RotationMetadata,
  maxBytes: number,
): Promise<OutputTail> {
  const limit = Math.max(1, Math.floor(maxBytes));
  if (
    rotation.noticeBytes + rotation.tailBytes > size ||
    rotation.ringLength > rotation.tailBytes ||
    rotation.ringWrite > rotation.tailBytes
  ) {
    throw new Error('Command output rotation metadata is inconsistent.');
  }
  const tailToRead = Math.min(rotation.ringLength, limit);
  const ring = Buffer.alloc(tailToRead);
  if (tailToRead > 0 && rotation.tailBytes > 0) {
    const start =
      rotation.ringLength < rotation.tailBytes
        ? rotation.ringLength - tailToRead
        : (rotation.ringWrite + rotation.ringLength - tailToRead) % rotation.tailBytes;
    const first = Math.min(tailToRead, rotation.tailBytes - start);
    await file.read(ring, 0, first, rotation.noticeBytes + start);
    if (first < tailToRead) {
      await file.read(ring, first, tailToRead - first, rotation.noticeBytes);
    }
  }
  const noticeLength = Math.min(rotation.noticeBytes, limit);
  const notice = Buffer.alloc(noticeLength);
  if (noticeLength > 0)
    await file.read(notice, 0, noticeLength, rotation.noticeBytes - noticeLength);
  const logical = Buffer.concat([notice, ring]);
  const bounded = logical.subarray(Math.max(0, logical.length - limit));
  const completeUtf8 = trimIncompleteUtf8Prefix(bounded);
  return {
    content: completeUtf8.toString('utf8'),
    totalBytes: Math.max(rotation.totalBytes, size),
    readBytes: completeUtf8.length,
    truncated: rotation.totalBytes > completeUtf8.length,
  };
}

export async function readExitCode(path: string): Promise<number | undefined> {
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('Command exit sentinel is not a regular file.');
    if (stats.size > 16) throw new Error('Command exit sentinel exceeds 16 bytes.');
    const buffer = Buffer.alloc(17);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16) throw new Error('Command exit sentinel exceeds 16 bytes.');
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^\d{1,3}$/.test(value)) throw new Error('Command exit sentinel is malformed.');
    const exitCode = Number(value);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new Error('Command exit sentinel is outside the 0-255 range.');
    }
    return exitCode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
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
