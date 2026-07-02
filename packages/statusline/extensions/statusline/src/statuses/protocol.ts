import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  parseClearEvent,
  parseSnapshotEvent,
  parseStatusEvent,
  type StatuslineStatus,
  STATUSLINE_STATUS_CLEAR_EVENT,
  STATUSLINE_STATUS_SET_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT,
} from '@aliaksei-raketski/pi-statusline-protocol';

const DEFAULT_SOURCE = 'statusline-protocol';

export interface ProtocolStatusRegistry {
  statuses: Map<string, StatuslineStatus>;
  requestSnapshot: () => void;
  dispose: () => void;
}

function rebuildMergedStatusMap(
  sourceMaps: Map<string, StatuslineStatus[]>,
): Map<string, StatuslineStatus> {
  const merged = new Map<string, StatuslineStatus>();
  for (const statuses of sourceMaps.values()) {
    for (const status of statuses) {
      merged.set(status.key, status);
    }
  }
  return merged;
}

export function createProtocolStatusRegistry(
  pi: ExtensionAPI,
  onChange: () => void,
): ProtocolStatusRegistry {
  const sourceMaps = new Map<string, StatuslineStatus[]>();
  let currentStatuses = new Map<string, StatuslineStatus>();

  const applyChange = (): void => {
    currentStatuses = rebuildMergedStatusMap(sourceMaps);
    onChange();
  };

  const handleSet = (payload: unknown): void => {
    const event = parseStatusEvent(payload);
    if (!event) {
      return;
    }

    const source = event.source ?? DEFAULT_SOURCE;
    const existing = sourceMaps.get(source) ?? [];
    const update = existing.filter((status) => status.key !== event.key);
    update.push({
      key: event.key,
      text: event.text,
      state: event.state,
      fallbackColor: event.fallbackColor,
    });

    sourceMaps.set(source, update);
    applyChange();
  };

  const handleClear = (payload: unknown): void => {
    const event = parseClearEvent(payload);
    if (!event) {
      return;
    }

    let changed = false;
    if (event.source) {
      const existing = sourceMaps.get(event.source);
      if (existing) {
        const next = existing.filter((status) => status.key !== event.key);
        if (next.length !== existing.length) {
          sourceMaps.set(event.source, next);
          changed = true;
        }
      }
    } else {
      for (const [source, existing] of sourceMaps) {
        const next = existing.filter((status) => status.key !== event.key);
        if (next.length !== existing.length) {
          sourceMaps.set(source, next);
          changed = true;
        }
      }
    }

    if (changed) {
      applyChange();
    }
  };

  const handleSnapshot = (payload: unknown): void => {
    const snapshot = parseSnapshotEvent(payload);
    if (!snapshot || !snapshot.statuses) {
      return;
    }

    const source = snapshot.source ?? DEFAULT_SOURCE;
    const items = snapshot.statuses.map((status: StatuslineStatus) => ({
      key: status.key,
      text: status.text,
      state: status.state,
      fallbackColor: status.fallbackColor,
    }));

    sourceMaps.set(source, items);
    applyChange();
  };

  const offSet = pi.events.on(STATUSLINE_STATUS_SET_EVENT, handleSet);
  const offClear = pi.events.on(STATUSLINE_STATUS_CLEAR_EVENT, handleClear);
  const offSnapshot = pi.events.on(STATUSLINE_STATUS_SNAPSHOT_EVENT, handleSnapshot);

  return {
    get statuses() {
      return currentStatuses;
    },
    requestSnapshot: () => {
      pi.events.emit(STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT, undefined);
    },
    dispose: () => {
      offSet();
      offClear();
      offSnapshot();
      sourceMaps.clear();
      currentStatuses = new Map();
    },
  };
}
