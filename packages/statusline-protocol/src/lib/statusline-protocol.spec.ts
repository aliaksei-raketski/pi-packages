import { describe, expect, it, vi } from 'vitest';
import {
  STATUSLINE_STATUS_CLEAR_EVENT,
  STATUSLINE_STATUS_SET_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_EVENT,
  type StatuslineUICtx,
  clearStatus,
  parseClearEvent,
  parseSnapshotEvent,
  parseStatusEvent,
  publishStatus,
  registerStatusProvider,
  type StatuslineStatus,
  type StatuslineProtocolHost,
  STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT,
} from './statusline-protocol.js';

describe('statuslineProtocol', () => {
  it('publishes colored status to setStatus and structured status event', () => {
    const setStatus = vi.fn();
    const emit = vi.fn();
    const ui: StatuslineUICtx = {
      setStatus,
      theme: {
        fg: (color, text) => `<${color}>${text}</${color}>`,
      },
    };
    const host: StatuslineProtocolHost = {
      events: {
        emit,
        on: () => () => undefined,
      },
    };

    const status: StatuslineStatus = {
      key: 'fast',
      text: 'fast on',
      state: 'on',
      fallbackColor: 'accent',
    };

    publishStatus(host, ui, status);
    expect(setStatus).toHaveBeenCalledWith('fast', '<accent>fast on</accent>');
    expect(emit).toHaveBeenCalledWith(STATUSLINE_STATUS_SET_EVENT, {
      key: 'fast',
      text: 'fast on',
      state: 'on',
      fallbackColor: 'accent',
      source: undefined,
    });
  });

  it('clears status and emits structured clear event', () => {
    const setStatus = vi.fn();
    const emit = vi.fn();
    const host: StatuslineProtocolHost = {
      events: {
        emit,
        on: () => () => undefined,
      },
    };
    const ui: StatuslineUICtx = {
      setStatus,
      theme: {
        fg: (color, text) => `<${color}>${text}</${color}>`,
      },
    };

    clearStatus(host, ui, 'fast ');
    expect(setStatus).toHaveBeenCalledWith('fast', undefined);
    expect(emit).toHaveBeenCalledWith(STATUSLINE_STATUS_CLEAR_EVENT, {
      key: 'fast',
      source: undefined,
    });
  });

  it('parses set event payload from plain and structured values', () => {
    expect(parseStatusEvent({ key: 'fast', text: 'fast on', state: 'on' })).toMatchObject({
      key: 'fast',
      text: 'fast on',
      state: 'on',
    });
    expect(parseStatusEvent(undefined)).toBeUndefined();
  });

  it('registers for snapshot request and publishes snapshot payload', () => {
    const emit = vi.fn();
    const events = {
      emit,
      on: vi.fn(),
    };
    const host: StatuslineProtocolHost = {
      events,
    };
    let snapshotHandler: ((payload: unknown) => void) | undefined;
    events.on = vi.fn().mockImplementation((_, handler) => {
      snapshotHandler = handler;
      return () => undefined;
    });

    registerStatusProvider(
      host,
      () => [
        {
          key: 'fast',
          text: 'fast on',
          state: 'on',
          fallbackColor: 'accent',
        },
      ],
      'fast-mode',
    );

    expect(events.on).toHaveBeenCalledWith(
      STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT,
      expect.any(Function),
    );
    expect(snapshotHandler).toBeTypeOf('function');
    snapshotHandler?.(undefined);
    expect(emit).toHaveBeenCalledWith(STATUSLINE_STATUS_SNAPSHOT_EVENT, {
      source: 'fast-mode',
      statuses: [{ key: 'fast', text: 'fast on', state: 'on', fallbackColor: 'accent' }],
    });
  });

  it('validates clear event parsing', () => {
    expect(parseClearEvent({ key: 'fast' })).toEqual({ key: 'fast', source: undefined });
    expect(parseClearEvent(' fast ')).toEqual({ key: 'fast', source: undefined });
    expect(parseClearEvent({ key: '' })).toBeUndefined();
  });

  it('validates snapshot parsing from array payload', () => {
    expect(
      parseSnapshotEvent([
        { key: 'fast', text: 'fast on', state: 'on' },
        { key: 'build', text: 'ok' },
      ]),
    ).toEqual({
      source: undefined,
      statuses: [
        { key: 'fast', text: 'fast on', state: 'on' },
        { key: 'build', text: 'ok', state: undefined, fallbackColor: undefined },
      ],
    });

    expect(
      parseSnapshotEvent({
        source: 'fast-mode',
        statuses: [{ key: 'fast', text: 'fast off' }],
      }),
    ).toEqual({
      source: 'fast-mode',
      statuses: [{ key: 'fast', text: 'fast off', state: undefined, fallbackColor: undefined }],
    });
  });
});
