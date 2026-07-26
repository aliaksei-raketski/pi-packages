export const STATUSLINE_STATUS_SET_EVENT = 'pi-statusline:status:set';
export const STATUSLINE_STATUS_CLEAR_EVENT = 'pi-statusline:status:clear';
export const STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT = 'pi-statusline:status:snapshot-request';
export const STATUSLINE_STATUS_SNAPSHOT_EVENT = 'pi-statusline:status:snapshot';

export interface StatuslineStatus {
  key: string;
  text: string;
  state?: string;
  fallbackColor?: string;
}

export interface StatuslineStatusEvent extends StatuslineStatus {
  source?: string;
}

export interface StatuslineStatusSnapshot {
  source?: string;
  statuses: StatuslineStatus[];
}

export interface StatuslineStatusClearEvent {
  key: string;
  source?: string;
}

export interface StatuslineUICtx {
  setStatus(key: string, text: string | undefined): void;
  theme: {
    fg(color: string, text: string): string;
  };
}

export interface StatuslineEmitChannel {
  emit(eventName: string, payload: unknown): void;
}

export interface StatuslineEventBus {
  on(eventName: string, handler: (payload: unknown) => void): () => void;
}

export interface StatuslineProtocolHost {
  events: StatuslineEventBus & StatuslineEmitChannel;
}

const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(8);

export interface StatuslineSnapshotProvider {
  (): Iterable<StatuslineStatus>;
}

export interface StatuslineProviderHandle {
  dispose(): void;
}

function stripAnsi(value: string): string {
  return value
    .replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g'), '')
    .replace(new RegExp(`${ESC}\\]`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[`, 'g'), '')
    .replace(new RegExp(`${ESC}${BACKSPACE}`, 'g'), '')
    .replace(new RegExp(`${ESC}\\(K`, 'g'), '')
    .replace(new RegExp(`${ESC}\\)B`, 'g'), '')
    .trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStatuslineStatus(value: unknown): value is StatuslineStatus {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.text === 'string' &&
    (value.state === undefined || typeof value.state === 'string') &&
    (value.fallbackColor === undefined || typeof value.fallbackColor === 'string')
  );
}

function normalizeStatus(value: StatuslineStatus): StatuslineStatus {
  return {
    key: value.key,
    text: stripAnsi(value.text),
    state: typeof value.state === 'string' ? value.state : undefined,
    fallbackColor:
      typeof value.fallbackColor === 'string' && value.fallbackColor.length > 0
        ? value.fallbackColor
        : undefined,
  };
}

export function parseStatusEvent(payload: unknown): StatuslineStatusEvent | undefined {
  if (!isRecord(payload) && !isStatuslineStatus(payload)) {
    return undefined;
  }

  if (!isRecord(payload)) {
    return normalizeStatus(payload as StatuslineStatus);
  }

  if (!isStatuslineStatus(payload)) {
    return undefined;
  }

  const normalized = normalizeStatus(payload);
  const source = payload.source;
  return {
    ...normalized,
    source: typeof source === 'string' && source.length > 0 ? source : undefined,
  };
}

export function parseClearEvent(payload: unknown): StatuslineStatusClearEvent | undefined {
  if (typeof payload === 'string') {
    const key = payload.trim();
    return key.length > 0 ? { key } : undefined;
  }

  if (!isRecord(payload) || typeof payload.key !== 'string') {
    return undefined;
  }

  const key = payload.key.trim();
  if (key.length === 0) {
    return undefined;
  }

  const source = payload.source;
  return {
    key,
    source: typeof source === 'string' && source.length > 0 ? source : undefined,
  };
}

export function parseSnapshotEvent(payload: unknown): StatuslineStatusSnapshot | undefined {
  if (!payload) {
    return undefined;
  }

  const sourceFromPayload = (rawSource: unknown): string | undefined =>
    typeof rawSource === 'string' && rawSource.length > 0 ? rawSource : undefined;

  if (Array.isArray(payload)) {
    const statuses = payload
      .map((entry) => (isStatuslineStatus(entry) ? normalizeStatus(entry) : undefined))
      .filter((entry): entry is StatuslineStatus => entry !== undefined);
    return { statuses };
  }

  if (!isRecord(payload)) {
    return undefined;
  }

  if (!Array.isArray(payload.statuses)) {
    return undefined;
  }

  const source = sourceFromPayload(payload.source);
  const statuses = payload.statuses
    .map((entry) => (isStatuslineStatus(entry) ? normalizeStatus(entry) : undefined))
    .filter((entry): entry is StatuslineStatus => entry !== undefined);

  return { source, statuses };
}

function buildEventPayload(status: StatuslineStatus, source?: string): StatuslineStatusEvent {
  const normalized = normalizeStatus(status);
  return {
    ...normalized,
    source: typeof source === 'string' && source.length > 0 ? source : undefined,
  };
}

function buildSnapshotPayload(
  statuses: Iterable<StatuslineStatus>,
  source?: string,
): StatuslineStatusSnapshot {
  const normalized: StatuslineStatus[] = [];
  for (const status of statuses) {
    if (!isStatuslineStatus(status)) {
      continue;
    }
    normalized.push(normalizeStatus(status));
  }

  return {
    source: typeof source === 'string' && source.length > 0 ? source : undefined,
    statuses: normalized,
  };
}

export function publishSnapshot(
  host: StatuslineProtocolHost,
  statuses: Iterable<StatuslineStatus>,
  source?: string,
): void {
  host.events.emit(STATUSLINE_STATUS_SNAPSHOT_EVENT, buildSnapshotPayload(statuses, source));
}

export function publishStatus(
  host: StatuslineProtocolHost,
  ctx: StatuslineUICtx,
  status: StatuslineStatus,
  source?: string,
): void {
  if (!isStatuslineStatus(status)) {
    return;
  }

  const normalized = normalizeStatus(status);
  const fallbackColor = normalized.fallbackColor;
  const fallbackText =
    fallbackColor === undefined ? normalized.text : ctx.theme.fg(fallbackColor, normalized.text);

  ctx.setStatus(normalized.key, fallbackText);
  host.events.emit(STATUSLINE_STATUS_SET_EVENT, buildEventPayload(normalized, source));
}

export function clearStatus(
  host: StatuslineProtocolHost,
  ctx: StatuslineUICtx,
  key: string,
  source?: string,
): void {
  const cleaned = key.trim();
  if (!cleaned) {
    return;
  }

  ctx.setStatus(cleaned, undefined);
  const payload: StatuslineStatusClearEvent = { key: cleaned, source };
  host.events.emit(STATUSLINE_STATUS_CLEAR_EVENT, payload);
}

export function registerStatusProvider(
  host: StatuslineProtocolHost,
  getStatuses: StatuslineSnapshotProvider,
  source?: string,
): StatuslineProviderHandle {
  const onSnapshotRequest = () => {
    publishSnapshot(host, getStatuses(), source);
  };

  const offSnapshotRequest = host.events.on(
    STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT,
    onSnapshotRequest,
  );

  return {
    dispose: () => {
      offSnapshotRequest();
    },
  };
}
