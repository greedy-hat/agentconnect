import type { NormalizedMessage } from '../messages/normalized.js'
import { sessionKey } from '../store/local-store.js'

/**
 * Trusted coordinates selected for one target during admission.
 *
 * Delivery coordinates name where provider-facing output belongs; session
 * coordinates name the logical session and transcript. They are deliberately
 * separate even while the current policy makes them equal.
 */
export interface SessionCoordinates {
  readonly deliveryThread: string
  readonly sessionThread: string
}

/** Current policy: each physical thread owns its own logical session. */
export function currentSessionCoordinates(msg: NormalizedMessage): SessionCoordinates {
  const thread = msg.thread ?? msg.msgId
  return { deliveryThread: thread, sessionThread: thread }
}

/** Build the one session key from coordinates resolved at admission. */
export function sessionKeyForCoordinates(
  agentId: string,
  msg: NormalizedMessage,
  coordinates: Pick<SessionCoordinates, 'sessionThread'>
): string {
  return sessionKey(msg.platform, msg.channel, coordinates.sessionThread, agentId, msg.transportScope)
}
