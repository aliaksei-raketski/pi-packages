import type { StatuslineStatus } from '@aliaksei-raketski/pi-statusline-protocol';

export const CAFFEINATE_STATUS_KEY = 'caffeinate';
export const CAFFEINATE_STATUS_SOURCE = 'pi-caffeinate';

export interface CaffeinateStatusInput {
  enabled: boolean;
  manualStop: boolean;
  holding: boolean;
  inhibitorRunning: boolean;
  unavailable: boolean;
  gateCount: number;
  piIdle: boolean;
  pendingMessages?: boolean;
}

export function collectCaffeinateStatus(
  input: CaffeinateStatusInput,
): StatuslineStatus | undefined {
  if (!input.enabled || input.manualStop || !input.holding) return undefined;
  if (input.unavailable && !input.inhibitorRunning) {
    return {
      key: CAFFEINATE_STATUS_KEY,
      text: 'caffeinate unavailable',
      state: 'error',
      fallbackColor: 'error',
    };
  }
  if (input.gateCount > 0 && input.piIdle && !input.pendingMessages) {
    return {
      key: CAFFEINATE_STATUS_KEY,
      text: `awake · ${input.gateCount} waiting`,
      state: 'waiting',
      fallbackColor: 'warning',
    };
  }
  return {
    key: CAFFEINATE_STATUS_KEY,
    text: 'awake',
    state: 'active',
    fallbackColor: 'accent',
  };
}
