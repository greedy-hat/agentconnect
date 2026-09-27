import type { NormalizedMessage } from '../messages/normalized.js'
import { sessionKey, type LocalStore } from '../store/local-store.js'
import type { ChannelSessionMode } from '@agentconnect.md/protocol'

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

/** Resolve a target's policy before admission. An append reservation exists independently
 *  of the eventual session row, so simultaneous first messages share one inbox lane. */
export async function resolveSessionCoordinates(
  store: Pick<LocalStore, 'resolveAppendReservation'>,
  agentId: string,
  msg: NormalizedMessage,
  mode: ChannelSessionMode
): Promise<SessionCoordinates> {
  const delivery = currentSessionCoordinates(msg)
  if (mode !== 'append') return delivery
  return {
    deliveryThread: delivery.deliveryThread,
    sessionThread: await store.resolveAppendReservation(agentId, msg.channel, msg.transportScope ?? '')
  }
}

/** Build the one session key from coordinates resolved at admission. */
export function sessionKeyForCoordinates(
  agentId: string,
  msg: NormalizedMessage,
  coordinates: Pick<SessionCoordinates, 'sessionThread'>
): string {
  return sessionKey(msg.platform, msg.channel, coordinates.sessionThread, agentId, msg.transportScope)
}
