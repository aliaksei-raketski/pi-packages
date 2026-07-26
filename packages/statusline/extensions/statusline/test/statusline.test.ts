import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearStatus, publishStatus } from '@aliaksei-raketski/pi-statusline-protocol';

import { createProtocolStatusRegistry } from '../src/statuses/protocol.js';
import { renderFooter } from '../src/statusline.js';

const directories: string[] = [];

const theme = {
  fg: (_color: string, text: string) => text,
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('statusline protocol sources', () => {
  it('preserves another source when a producer clears the same key', () => {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const events = {
      emit(name: string, payload: unknown) {
        for (const handler of handlers.get(name) ?? []) handler(payload);
      },
      on(name: string, handler: (payload: unknown) => void) {
        const listeners = handlers.get(name) ?? new Set();
        listeners.add(handler);
        handlers.set(name, listeners);
        return () => listeners.delete(handler);
      },
    };
    const host = { events } as never;
    const ui = { setStatus: () => undefined, theme } as never;
    const registry = createProtocolStatusRegistry(host, () => undefined);

    publishStatus(host, ui, { key: 'shared', text: 'from A' }, 'source-a');
    publishStatus(host, ui, { key: 'shared', text: 'from B' }, 'source-b');
    expect(registry.statuses.get('shared')?.text).toBe('from B');

    clearStatus(host, ui, 'shared', 'source-b');
    expect(registry.statuses.get('shared')?.text).toBe('from A');
    registry.dispose();
  });
});

describe('statusline footer safety', () => {
  it('removes terminal and bidi controls from every footer text source before rendering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statusline-safe-'));
    directories.push(root);
    const cwd = join(root, 'cwd\u001b[31m-red');
    await mkdir(cwd);
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'project\u001b]52;c;YXR0YWNrZXI=\u0007-tail' }),
    );

    const lines = renderFooter(
      {
        cwd,
        sessionManager: {
          getSessionName: () => 'title\u0000\u202e-hidden-tail',
        },
      } as never,
      {} as never,
      theme as never,
      {
        getExtensionStatuses: () =>
          new Map([['extension', 'extension\u001bPpayload\u001b\\-tail']]),
      } as never,
      {
        layout: [['project', 'cwd', 'title', 'protocol', 'extension']],
        separator: ' |\u0007 ',
        separatorColor: '',
        prefix: { project: 'project-prefix\n' },
        colors: {},
      },
      {},
      1_000,
      new Map([
        [
          'protocol',
          {
            key: 'protocol',
            text: 'protocol\u009d52;c;YXR0YWNrZXI=\u009c-tail',
          } as never,
        ],
      ]),
    );
    const output = lines.join('\n');

    expect(output).toContain('project-prefix project-tail');
    expect(output).toContain('cwd-red');
    expect(output).toContain('title-hidden-tail');
    expect(output).toContain('protocol-tail');
    expect(output).toContain('extension-tail');
    expect(
      Array.from(output).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
      }),
    ).toBe(false);
    expect(output).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
    expect(output).not.toContain('YXR0YWNrZXI=');
    expect(output).not.toContain('payload');
  });
});
