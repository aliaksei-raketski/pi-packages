const ANSI_RESET = '\x1b[0m';

interface ExtractedAnsi {
  readonly code: string;
  readonly length: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ZERO_WIDTH_REGEX =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const LEADING_NON_PRINTING_REGEX =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/u;
const CJK_SCRIPT_REGEX =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

function couldBeEmoji(segment: string): boolean {
  if (segment.includes('\uFE0F')) {
    return true;
  }
  if (segment.length > 2) {
    return true;
  }
  return /\p{Extended_Pictographic}/u.test(segment);
}

function graphemeWidth(segment: string): number {
  if (segment === '\t') {
    return 3;
  }

  if (ZERO_WIDTH_REGEX.test(segment)) {
    return 0;
  }

  if (couldBeEmoji(segment)) {
    return 2;
  }

  const base = segment.replace(LEADING_NON_PRINTING_REGEX, '');
  if (!base) {
    return 0;
  }

  const cp = base.codePointAt(0);
  if (cp === undefined) {
    return 0;
  }

  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    return 2;
  }

  if (CJK_SCRIPT_REGEX.test(segment)) {
    return 2;
  }

  return 1;
}

export function extractAnsiCode(text: string, offset: number): ExtractedAnsi | null {
  if (offset >= text.length || text[offset] !== '\x1b') return null;

  const next = text[offset + 1];
  if (next === undefined) return null;

  if (next === '[') {
    let i = offset + 2;
    while (i < text.length) {
      const ch = text[i];
      if (ch !== undefined && ((ch >= '@' && ch <= '~') || ch === 'm')) {
        return { code: text.slice(offset, i + 1), length: i + 1 - offset };
      }
      i++;
    }
    return null;
  }

  if (next === ']') {
    let i = offset + 2;
    while (i < text.length) {
      if (text[i] === '\u0007') {
        return { code: text.slice(offset, i + 1), length: i + 1 - offset };
      }
      if (text[i] === '\x1b' && text[i + 1] === '\\') {
        return { code: text.slice(offset, i + 2), length: i + 2 - offset };
      }
      i++;
    }
    return null;
  }

  if (next === '_') {
    let i = offset + 2;
    while (i < text.length) {
      if (text[i] === '\u0007') {
        return { code: text.slice(offset, i + 1), length: i + 1 - offset };
      }
      if (text[i] === '\x1b' && text[i + 1] === '\\') {
        return { code: text.slice(offset, i + 2), length: i + 2 - offset };
      }
      i++;
    }
    return null;
  }

  return null;
}

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }

  return true;
}

export function visibleWidth(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  if (isPrintableAscii(text)) {
    return text.length;
  }

  let width = 0;
  let normalized = text;
  if (text.includes('\t')) {
    normalized = normalized.replace(/\t/g, '   ');
  }

  if (normalized.includes('\x1b')) {
    let stripped = '';
    let i = 0;
    while (i < normalized.length) {
      const ansi = extractAnsiCode(normalized, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      stripped += normalized[i];
      i++;
    }
    normalized = stripped;
  }

  for (const { segment } of graphemeSegmenter.segment(normalized)) {
    width += graphemeWidth(segment);
  }

  return width;
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
  if (maxWidth <= 0 || !text) {
    return { text: '', width: 0 };
  }

  if (isPrintableAscii(text)) {
    const clipped = text.slice(0, maxWidth);
    return { text: clipped, width: clipped.length };
  }

  const hasAnsi = text.includes('\x1b');
  const hasTabs = text.includes('\t');
  if (!hasAnsi && !hasTabs) {
    let result = '';
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const w = graphemeWidth(segment);
      if (width + w > maxWidth) {
        break;
      }
      result += segment;
      width += w;
    }
    return { text: result, width };
  }

  let result = '';
  let width = 0;
  let i = 0;
  let pendingAnsi = '';

  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }

    if (text[i] === '\t') {
      if (width + 3 > maxWidth) {
        break;
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = '';
      }
      result += '\t';
      width += 3;
      i++;
      continue;
    }

    let end = i;
    while (end < text.length && text[end] !== '\t') {
      const nextAnsi = extractAnsiCode(text, end);
      if (nextAnsi) {
        break;
      }
      end++;
    }
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const w = graphemeWidth(segment);
      if (width + w > maxWidth) {
        return { text: result, width };
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = '';
      }
      result += segment;
      width += w;
    }
    i = end;
  }

  return { text: result, width };
}

export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis = '...',
  pad = false,
): string {
  if (maxWidth <= 0) {
    return '';
  }

  if (!text) {
    return pad ? ' '.repeat(maxWidth) : '';
  }

  const ellipsisWidth = visibleWidth(ellipsis);
  const textWidth = visibleWidth(text);

  if (textWidth <= maxWidth) {
    return pad ? `${text}${' '.repeat(Math.max(0, maxWidth - textWidth))}` : text;
  }

  if (ellipsisWidth >= maxWidth) {
    const clipped = truncateFragmentToWidth(ellipsis, maxWidth);
    const prefix = `${clipped.text}`;
    return pad ? `${prefix}${' '.repeat(Math.max(0, maxWidth - clipped.width))}` : prefix;
  }

  const targetWidth = maxWidth - ellipsisWidth;
  const clipped = truncateFragmentToWidth(text, targetWidth);
  const base = `${clipped.text}${ANSI_RESET}${ellipsis}${ANSI_RESET}`;

  if (!pad) {
    return base;
  }

  const baseWidth = clipped.width + ellipsisWidth;
  return `${base}${' '.repeat(Math.max(0, maxWidth - baseWidth))}`;
}
