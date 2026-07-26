const STRING_SEQUENCE_INTRODUCERS = new Set([']', 'P', 'X', '^', '_']);
const C1_STRING_SEQUENCE_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

/** Remove terminal control sequences and display-hostile control characters from untrusted text. */
export function sanitizeTerminalText(value: string): string {
  const characters = Array.from(value);
  let sanitized = '';

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    const code = character.codePointAt(0);
    if (code === undefined) continue;

    if (code === 0x1b) {
      const introducer = characters[index + 1];
      if (introducer === '[') {
        index = consumeControlSequence(characters, index + 2);
      } else if (introducer && STRING_SEQUENCE_INTRODUCERS.has(introducer)) {
        index = consumeStringSequence(characters, index + 2);
      } else if (introducer !== undefined) {
        index += 1;
      }
      continue;
    }

    if (code === 0x9b) {
      index = consumeControlSequence(characters, index + 1);
      continue;
    }
    if (C1_STRING_SEQUENCE_INTRODUCERS.has(code)) {
      index = consumeStringSequence(characters, index + 1);
      continue;
    }

    if (
      code === 0x7f ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x80 && code <= 0x9f) ||
      (code >= 0xfff9 && code <= 0xfffb)
    ) {
      continue;
    }

    sanitized += character;
  }

  return sanitized.replace(/\r/g, '');
}

function consumeControlSequence(characters: string[], start: number): number {
  for (let index = start; index < characters.length; index += 1) {
    const code = characters[index]?.codePointAt(0);
    if (code !== undefined && code >= 0x40 && code <= 0x7e) return index;
  }
  return characters.length - 1;
}

function consumeStringSequence(characters: string[], start: number): number {
  for (let index = start; index < characters.length; index += 1) {
    const code = characters[index]?.codePointAt(0);
    if (code === 0x07 || code === 0x9c) return index;
    if (code === 0x1b && characters[index + 1] === '\\') return index + 1;
  }
  return characters.length - 1;
}
