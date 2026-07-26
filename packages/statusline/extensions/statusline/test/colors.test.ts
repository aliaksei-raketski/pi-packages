import { expect, test } from 'vitest';
import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import {
  THEME_DEFAULT_COLORS,
  colorize,
  isThemeColor,
  isValidSimpleColorValue,
  mergeColorMaps,
  normalizeColorMap,
  parseSimpleColor,
  resolveColorValue,
} from '../src/colors.ts';

const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

const CURRENT_THEME_COLORS = {
  accent: true,
  border: true,
  borderAccent: true,
  borderMuted: true,
  success: true,
  error: true,
  warning: true,
  muted: true,
  dim: true,
  text: true,
  thinkingText: true,
  userMessageText: true,
  customMessageText: true,
  customMessageLabel: true,
  toolTitle: true,
  toolOutput: true,
  mdHeading: true,
  mdLink: true,
  mdLinkUrl: true,
  mdCode: true,
  mdCodeBlock: true,
  mdCodeBlockBorder: true,
  mdQuote: true,
  mdQuoteBorder: true,
  mdHr: true,
  mdListBullet: true,
  toolDiffAdded: true,
  toolDiffRemoved: true,
  toolDiffContext: true,
  syntaxComment: true,
  syntaxKeyword: true,
  syntaxFunction: true,
  syntaxVariable: true,
  syntaxString: true,
  syntaxNumber: true,
  syntaxType: true,
  syntaxOperator: true,
  syntaxPunctuation: true,
  thinkingOff: true,
  thinkingMinimal: true,
  thinkingLow: true,
  thinkingMedium: true,
  thinkingHigh: true,
  thinkingXhigh: true,
  thinkingMax: true,
  bashMode: true,
} satisfies Record<ThemeColor, true>;

type ThinkingLevel = NonNullable<ExtensionContext['thinkingLevel']>;
const CURRENT_THINKING_LEVELS = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ThinkingLevel, true>;

test('accepts every current Pi theme color and configures every thinking level', () => {
  expect(Object.keys(CURRENT_THEME_COLORS).every(isThemeColor)).toBe(true);
  const thinkingColors = THEME_DEFAULT_COLORS.thinking;
  for (const level of Object.keys(CURRENT_THINKING_LEVELS)) {
    expect(thinkingColors[level as keyof typeof thinkingColors]).toBeDefined();
  }
  expect(thinkingColors.max).toBe('thinkingMax');
});

test('accepts theme/hex/256/simple values', () => {
  expect(isThemeColor('muted')).toBe(true);
  expect(isThemeColor('#abc')).toBe(false);
  expect(isValidSimpleColorValue('#ff0000')).toBe(true);
  expect(isValidSimpleColorValue(240)).toBe(true);
  expect(isValidSimpleColorValue('')).toBe(true);
  expect(isValidSimpleColorValue(999)).toBe(false);
  expect(isValidSimpleColorValue('unknown')).toBe(false);
});

test('parses theme and ANSI values', () => {
  const parsedTheme = parseSimpleColor('warning');
  expect(parsedTheme.type).toBe('theme');
  expect(parsedTheme.type === 'theme' ? parsedTheme.value : '').toBe('warning');

  const parsedHex = parseSimpleColor('#336699');
  expect(parsedHex.type).toBe('hex');
  if (parsedHex.type === 'hex') {
    expect(parsedHex.r).toBe(51);
    expect(parsedHex.g).toBe(102);
    expect(parsedHex.b).toBe(153);
  }

  const parsedAnsi = parseSimpleColor(42);
  expect(parsedAnsi.type).toBe('ansi256');
  expect(parsedAnsi.type === 'ansi256' ? parsedAnsi.value : 0).toBe(42);
});

test('resolves stateful color values with fallback', () => {
  const colors = {
    context: {
      warning: 'warning',
    },
    thinking: {
      off: 'dim',
    },
  };
  const fromState = resolveColorValue(colors, 'context', 'warning');
  const fromFallback = resolveColorValue(colors, 'context', 'full');
  expect(fromState).toBe('warning');
  expect(fromFallback).toBe(THEME_DEFAULT_COLORS.context.full);
  expect(resolveColorValue({}, 'model', 'off')).toBe(THEME_DEFAULT_COLORS.model);
  expect(resolveColorValue({}, 'branch', 'clean')).toBe(THEME_DEFAULT_COLORS.branch.clean);
  expect(resolveColorValue({}, 'branch', 'dirty')).toBe(THEME_DEFAULT_COLORS.branch.dirty);
});

test('normalizes color maps with string-number values', () => {
  const parsed = normalizeColorMap({
    cwd: '#aabbcc',
    cache: 128,
    context: {
      warning: 'warning',
      full: 196,
    },
    thinking: {
      off: 'thinkingOff',
    },
  });
  expect(parsed).toEqual({
    cwd: '#aabbcc',
    cache: 128,
    context: {
      warning: 'warning',
      full: 196,
    },
    thinking: {
      off: 'thinkingOff',
    },
  });
});

test('merges configured colors and objects', () => {
  const merged = mergeColorMaps(
    { cwd: 'muted', thinking: { off: 'muted', default: 'warning' } },
    { thinking: { off: 'thinkingOff' }, cache: 'dim' },
  );
  expect(merged).toEqual({
    cwd: 'muted',
    thinking: { off: 'thinkingOff', default: 'warning' },
    cache: 'dim',
  });
});

test('applies ANSI and theme colors via colorize', () => {
  expect(colorize('hello', '#336699', fakeTheme)).toBe('\x1b[38;2;51;102;153mhello\x1b[0m');
  expect(colorize('hello', 31, fakeTheme)).toBe('\x1b[38;5;31mhello\x1b[0m');
  expect(colorize('hello', 'warning', fakeTheme)).toBe('<warning>hello</warning>');
  expect(colorize('hello', '', fakeTheme)).toBe('hello');
  expect(colorize('hello', 'bad', fakeTheme)).toBe('hello');
});
