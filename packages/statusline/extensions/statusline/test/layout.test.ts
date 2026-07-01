import { expect, test } from 'vitest';
import { visibleWidth } from '../src/ansi-utils.ts';
import {
  normalizeLayout,
  renderLayoutLine,
  renderLayoutLines,
  type StatuslineLayout,
} from '../src/layout.ts';

const values = new Map<string, string>([
  ['cwd', 'shell'],
  ['branch', 'main'],
  ['model', 'gpt'],
  ['statuses', 'x=ok'],
]);

const tokenText = (key: string): string | undefined => values.get(key);

test('normalizes flat layout as single footer line', () => {
  expect(normalizeLayout(['cwd', 'spacer', 'model'])).toEqual([['cwd', 'spacer', 'model']]);
});

test('normalizes nested layout as multiple lines', () => {
  expect(normalizeLayout([['cwd', 'spacer', 'branch'], ['model']])).toEqual([
    ['cwd', 'spacer', 'branch'],
    ['model'],
  ]);
});

test('rejects mixed layout shapes', () => {
  expect(normalizeLayout(['cwd', ['model']])).toBe(null);
});

test('renders spacer gap with width distribution', () => {
  const line = ['cwd', 'spacer', 'model']; // 4 + 1 + 4 visible + 4? not counting? fixed width 9
  const rendered = renderLayoutLine(line, tokenText, ' • ', 10);
  expect(rendered).toBe('shell  gpt');
  expect(visibleWidth(rendered)).toBe(10);
});

test('supports multiple spacers as centered flexible gaps', () => {
  const line = ['cwd', 'spacer', 'branch', 'spacer', 'model'];
  const rendered = renderLayoutLine(line, tokenText, '', 14);
  expect(rendered).toBe('shell main gpt');
  expect(visibleWidth(rendered)).toBe(14);
});

test('renders multiple layout rows', () => {
  const layout: StatuslineLayout = [['cwd', 'spacer', 'branch'], ['model']];
  const rendered = renderLayoutLines(layout, tokenText, '', 20);
  expect(rendered.length).toBe(2);
  expect(rendered[0]).toBe('shell           main');
  expect(rendered[1]).toBe('gpt');
  expect(visibleWidth(rendered[0])).toBe(20);
});

test('collapses empty-only lines', () => {
  const values = new Map<string, string>([
    ['cwd', 'shell'],
    ['model', 'gpt'],
  ]);
  const layout: StatuslineLayout = [['title'], ['cwd', 'model']];
  const rendered = renderLayoutLines(layout, (key) => values.get(key), ' • ', 80);
  expect(rendered).toEqual(['shell • gpt']);
});

test('collapses all-empty output into no rows', () => {
  const layout: StatuslineLayout = [['title'], ['branch']];
  const rendered = renderLayoutLines(layout, () => undefined, ' • ', 80);
  expect(rendered).toEqual([]);
});

test('drops empty leading segments in a line', () => {
  const rendered = renderLayoutLine(
    ['branch', 'changes', 'spacer', 'model'],
    (token) => {
      if (token === 'model') {
        return 'gpt';
      }
      return undefined;
    },
    ' • ',
    20,
  );
  expect(rendered).toBe('gpt');
});

test('handles ANSI-coded values safely while truncating', () => {
  const ansiValues = new Map<string, string>([['cwd', '\x1b[31mvery-long-project-path\x1b[0m']]);
  const ansiToken = (key: string): string | undefined => ansiValues.get(key);
  const rendered = renderLayoutLine(['cwd'], ansiToken, '', 10);
  expect(rendered.startsWith('\x1b[31m')).toBeTruthy();
  expect(visibleWidth(rendered)).toBe(10);
  expect(rendered.endsWith('\x1b[0m')).toBeTruthy();
});

test('counts wide symbols (emoji) when truncating', () => {
  const values = new Map<string, string>([
    ['cwd', '🤖super'],
    ['spacer', ' '],
  ]);
  const rendered = renderLayoutLine(['cwd'], (key) => values.get(key), '', 4);
  expect(visibleWidth(rendered)).toBe(3);
});

test('falls back to one item per line on narrow terminals', () => {
  const narrowLayout: StatuslineLayout = [['cwd', 'spacer', 'model', 'spacer', 'thinking']];
  const narrowValues = new Map<string, string>([
    ['cwd', 'shell'],
    ['model', 'gpt'],
    ['thinking', 'off'],
  ]);
  const rendered = renderLayoutLines(narrowLayout, (key) => narrowValues.get(key), ' • ', 6);
  expect(rendered).toEqual(['shell', 'gpt', 'off']);
  expect(visibleWidth(rendered[0])).toBe(5);
  expect(rendered.length).toBe(3);
});
