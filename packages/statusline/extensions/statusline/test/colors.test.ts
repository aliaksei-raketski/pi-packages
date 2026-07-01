import { expect, test } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
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
