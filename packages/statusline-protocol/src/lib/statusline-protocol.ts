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

const FALLBACK_OWNERS = Symbol.for('pi-statusline-protocol:fallback-owners');

interface FallbackPublication {
  source: string | undefined;
  text: string;
  sequence: number;
}

interface FallbackRegistry {
  sequence: number;
  statuses: Map<string, Map<string | undefined, FallbackPublication>>;
}

type StatuslineProtocolGlobal = typeof globalThis & {
  [FALLBACK_OWNERS]?: WeakMap<object, FallbackRegistry>;
};

export interface StatuslineSnapshotProvider {
  (): Iterable<StatuslineStatus>;
}

export interface StatuslineProviderHandle {
  dispose(): void;
}

function stripAnsi(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      output += value[index];
      continue;
    }

    const next = value[index + 1];
    if (next === '[') {
      let end = index + 2;
      while (end < value.length) {
        const code = value.charCodeAt(end);
        if ((code >= 48 && code <= 57) || code === 59) end += 1;
        else break;
      }
      const finalCode = value.charCodeAt(end);
      const isLetter =
        (finalCode >= 65 && finalCode <= 90) || (finalCode >= 97 && finalCode <= 122);
      index = isLetter ? end : index + 1;
      continue;
    }
    if (
      next === ']' ||
      next?.charCodeAt(0) === 8 ||
      (next === '(' && value[index + 2] === 'K') ||
      (next === ')' && value[index + 2] === 'B')
    ) {
      index += next === '(' || next === ')' ? 2 : 1;
      continue;
    }
    output += value[index];
  }
  return output.trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fallbackRegistry(host: StatuslineProtocolHost): FallbackRegistry {
  const sharedGlobal = globalThis as StatuslineProtocolGlobal;
  const registries = (sharedGlobal[FALLBACK_OWNERS] ??= new WeakMap());
  const existing = registries.get(host);
  if (existing) return existing;
  const registry: FallbackRegistry = { sequence: 0, statuses: new Map() };
  registries.set(host, registry);
  return registry;
}

function latestFallback(
  publications: Map<string | undefined, FallbackPublication>,
): FallbackPublication | undefined {
  let latest: FallbackPublication | undefined;
  for (const publication of publications.values()) {
    if (!latest || publication.sequence > latest.sequence) latest = publication;
  }
  return latest;
}

function normalizeSource(source?: unknown): string | undefined {
  return typeof source === 'string' && source.length > 0 ? source : undefined;
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
  return {
    ...normalized,
    source: normalizeSource(payload.source),
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

  return {
    key,
    source: normalizeSource(payload.source),
  };
}

export function parseSnapshotEvent(payload: unknown): StatuslineStatusSnapshot | undefined {
  if (!payload) {
    return undefined;
  }

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

  const source = normalizeSource(payload.source);
  const statuses = payload.statuses
    .map((entry) => (isStatuslineStatus(entry) ? normalizeStatus(entry) : undefined))
    .filter((entry): entry is StatuslineStatus => entry !== undefined);

  return { source, statuses };
}

function buildEventPayload(status: StatuslineStatus, source?: string): StatuslineStatusEvent {
  const normalized = normalizeStatus(status);
  return {
    ...normalized,
    source: normalizeSource(source),
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
    source: normalizeSource(source),
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
  const registry = fallbackRegistry(host);
  registry.sequence += 1;
  const publications = registry.statuses.get(normalized.key) ?? new Map();
  const normalizedSource = normalizeSource(source);
  publications.set(normalizedSource, {
    source: normalizedSource,
    text: fallbackText,
    sequence: registry.sequence,
  });
  registry.statuses.set(normalized.key, publications);
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

  const registry = fallbackRegistry(host);
  const publications = registry.statuses.get(cleaned);
  const normalizedSource = normalizeSource(source);
  if (normalizedSource === undefined) {
    ctx.setStatus(cleaned, undefined);
    registry.statuses.delete(cleaned);
  } else if (!publications) {
    ctx.setStatus(cleaned, undefined);
  } else {
    const current = latestFallback(publications);
    publications.delete(normalizedSource);
    if (current?.source === normalizedSource) {
      ctx.setStatus(cleaned, latestFallback(publications)?.text);
    }
    if (publications.size === 0) registry.statuses.delete(cleaned);
  }
  const payload: StatuslineStatusClearEvent = { key: cleaned, source: normalizedSource };
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
