import {
  createContinuationGateController,
  type ContinuationGateController,
  type ContinuationGateProtocolHost,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';

import { TMUX_BASH_GATE_SOURCE } from './types.js';

export function createTmuxGateController(
  host: ContinuationGateProtocolHost,
): ContinuationGateController {
  return createContinuationGateController(host, { source: TMUX_BASH_GATE_SOURCE });
}
