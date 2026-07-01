import { expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STATUSLINE_CONFIG, loadStatuslineConfig } from '../src/config.ts';

function withTempFiles(files: Record<string, unknown>): {
  cwd: string;
  paths: { user: string; project: string };
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-statusline-config-'));
  const user = join(cwd, 'user.json');
  const project = join(cwd, 'project.json');

  for (const [pathKey, content] of Object.entries(files)) {
    const path = pathKey === 'user' ? user : project;
    writeFileSync(path, JSON.stringify(content), 'utf-8');
  }

  return {
    cwd,
    paths: { user, project },
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}
test('loads defaults when no config files exist', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-statusline-default-'));
  const result = loadStatuslineConfig({
    cwd,
    isProjectTrusted: () => true,
    paths: {
      user: join(cwd, 'user.json'),
      project: join(cwd, 'project.json'),
    },
  });
  expect(result.diagnostics.length).toBe(0);
  expect(result.config.layout).toEqual(DEFAULT_STATUSLINE_CONFIG.layout);
  expect(result.config.separator).toBe(DEFAULT_STATUSLINE_CONFIG.separator);
  expect(result.config.separatorColor).toBe(DEFAULT_STATUSLINE_CONFIG.separatorColor);
  rmSync(cwd, { recursive: true, force: true });
});

test('writes default config file when requested', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-statusline-default-write-'));
  const user = join(cwd, 'user.json');
  const project = join(cwd, 'project.json');

  const result = loadStatuslineConfig({
    cwd,
    isProjectTrusted: () => true,
    writeDefaultConfig: true,
    paths: {
      user,
      project,
    },
  });

  expect(result.diagnostics.length).toBe(0);
  expect(existsSync(user)).toBeTruthy();
  const written = JSON.parse(readFileSync(user, 'utf-8'));
  expect(written.layout).toEqual(DEFAULT_STATUSLINE_CONFIG.layout);
  expect(written.separator).toBe(DEFAULT_STATUSLINE_CONFIG.separator);
  expect(written.separatorColor).toBe(DEFAULT_STATUSLINE_CONFIG.separatorColor);
  expect(written.prefix).toEqual(DEFAULT_STATUSLINE_CONFIG.prefix);
  expect(written.colors).toEqual(DEFAULT_STATUSLINE_CONFIG.colors);

  rmSync(cwd, { recursive: true, force: true });
});

test('accepts a flat layout and merges user config', () => {
  const { cwd, paths, cleanup } = withTempFiles({
    user: {
      layout: ['cwd', 'spacer', 'model'],
      separator: ' | ',
      separatorColor: '#8aadf4',
      prefix: {
        cwd: '🏠',
      },
      colors: {
        cost: 120,
      },
    },
  });
  const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
  expect(result.diagnostics.length).toBe(0);
  expect(result.config.layout).toEqual([['cwd', 'spacer', 'model']]);
  expect(result.config.separator).toBe(' | ');
  expect(result.config.separatorColor).toBe('#8aadf4');
  expect(result.config.prefix.cwd).toBe('🏠');
  expect(result.config.colors.cost).toBe(120);
  cleanup();
});

test('accepts deprecated icons alias', () => {
  const { cwd, paths, cleanup } = withTempFiles({
    user: {
      icons: {
        cwd: '🏠',
      },
    },
  });
  const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
  expect(result.diagnostics.length).toBe(0);
  expect(result.config.prefix.cwd).toBe('🏠');
  cleanup();
});

test('supports nested layouts from project config when trusted', () => {
  const { cwd, paths, cleanup } = withTempFiles({
    user: { layout: ['cwd', 'spacer', 'branch'] },
    project: { layout: [['cwd'], ['model']] },
  });
  const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
  expect(result.diagnostics.length).toBe(0);
  expect(result.config.layout).toEqual([['cwd'], ['model']]);
  cleanup();
});

test('rejects mixed layout shapes and falls back to defaults', () => {
  const { cwd, paths, cleanup } = withTempFiles({
    user: { layout: ['cwd', ['branch']] },
  });
  const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
  expect(result.diagnostics.length > 0).toBeTruthy();
  expect(result.diagnostics.some((message) => message.includes('layout'))).toBeTruthy();
  expect(result.config.layout).toEqual(DEFAULT_STATUSLINE_CONFIG.layout);
  cleanup();
});

test('ignores project config when project is not trusted', () => {
  const user = mkdtempSync(join(tmpdir(), 'pi-statusline-untrusted-'));
  const userPath = join(user, 'user.json');
  const projectPath = join(user, 'project.json');
  writeFileSync(userPath, JSON.stringify({ layout: ['cwd'] }), 'utf-8');
  writeFileSync(projectPath, JSON.stringify({ layout: ['model'] }), 'utf-8');

  const result = loadStatuslineConfig({
    cwd: user,
    isProjectTrusted: () => false,
    paths: {
      user: userPath,
      project: projectPath,
    },
  });

  expect(result.config.layout[0]?.[0]).toBe('cwd');
  expect(result.config.layout).toEqual([['cwd']]);
  expect(result.diagnostics.length).toBe(0);
  rmSync(user, { recursive: true, force: true });
});

test('merges explicit project config over valid user config', () => {
  const { cwd, paths, cleanup } = withTempFiles({
    user: { separator: ' a ', separatorColor: 'muted' },
    project: { separator: ' b ' },
  });
  const result = loadStatuslineConfig({ cwd, isProjectTrusted: () => true, paths });
  expect(result.config.separator).toBe(' b ');
  expect(result.config.separatorColor).toBe('muted');
  cleanup();
});
