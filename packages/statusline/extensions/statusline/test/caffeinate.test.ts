import { describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent';
import {
  clearStatus,
  publishStatus,
  registerStatusProvider,
  type StatuslineStatus,
} from '@aliaksei-raketski/pi-statusline-protocol';
import { DEFAULT_STATUSLINE_CONFIG } from '../src/config.ts';
import { collectStatusItems } from '../src/status-items.ts';
import { createProtocolStatusRegistry } from '../src/statuses/protocol.ts';

function createHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    events: {
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        const current = listeners.get(event) ?? new Set();
        current.add(listener);
        listeners.set(event, current);
        return () => current.delete(listener);
      }),
      emit: vi.fn((event: string, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      }),
    },
  };
}

const caffeinateStatus: StatuslineStatus = {
  key: 'caffeinate',
  text: 'awake · 2 waiting',
  state: 'waiting',
  fallbackColor: 'warning',
};

const ui = {
  setStatus: vi.fn(),
  theme: { fg: vi.fn((_color: string, text: string) => text) },
};

function collect(protocolStatuses = new Map<string, StatuslineStatus>()) {
  const context = {
    cwd: '/tmp',
    model: { provider: 'test', modelId: 'test' },
    getContextUsage: () => null,
    sessionManager: { getBranch: () => [], getSessionName: () => undefined },
  } as unknown as ExtensionContext;
  const pi = { getThinkingLevel: () => 'off' } as ExtensionAPI;
  const footer = {
    getExtensionStatuses: () => new Map(),
    getGitBranch: () => null,
  } as unknown as ReadonlyFooterDataProvider;
  return collectStatusItems(context, pi, footer, new Set(['caffeinate']), {}, protocolStatuses);
}

describe('caffeinate statusline integration', () => {
  it('includes the direct token, prefix, and state colors in fresh defaults', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.layout.flat()).toContain('caffeinate');
    expect(DEFAULT_STATUSLINE_CONFIG.prefix.caffeinate).toBe('☕');
    expect(DEFAULT_STATUSLINE_CONFIG.colors.caffeinate).toEqual({
      active: 'accent',
      waiting: 'warning',
      error: 'error',
      default: 'muted',
    });
  });

  it('renders a direct protocol item and omits it cleanly when absent', () => {
    expect(collect(new Map([['caffeinate', caffeinateStatus]])).get('caffeinate')).toMatchObject({
      text: 'awake · 2 waiting',
      state: 'waiting',
      source: 'protocol',
    });
    expect(collect().has('caffeinate')).toBe(false);
  });

  it('recovers when the producer loads before the statusline consumer', () => {
    const host = createHost();
    registerStatusProvider(host, () => [caffeinateStatus], 'pi-caffeinate');
    const registry = createProtocolStatusRegistry(host as unknown as ExtensionAPI, vi.fn());

    registry.requestSnapshot();

    expect(registry.statuses.get('caffeinate')).toEqual(caffeinateStatus);
  });

  it('observes live publication when the statusline consumer loads first', () => {
    const host = createHost();
    const registry = createProtocolStatusRegistry(host as unknown as ExtensionAPI, vi.fn());

    publishStatus(host, ui, caffeinateStatus, 'pi-caffeinate');

    expect(registry.statuses.get('caffeinate')).toEqual(caffeinateStatus);
  });

  it('clears only the caffeinate source from the protocol registry', () => {
    const host = createHost();
    const registry = createProtocolStatusRegistry(host as unknown as ExtensionAPI, vi.fn());
    publishStatus(
      host,
      ui,
      { key: 'caffeinate', text: 'other producer', state: 'active' },
      'other-source',
    );
    publishStatus(host, ui, caffeinateStatus, 'pi-caffeinate');

    clearStatus(host, ui, 'caffeinate', 'pi-caffeinate');

    expect(registry.statuses.get('caffeinate')?.text).toBe('other producer');
  });
});
