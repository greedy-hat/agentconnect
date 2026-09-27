import { CONVERSATION_SESSION_MODE_V1_FEATURE, type IntegrationSpec } from '@agentconnect.md/protocol'
import type { IntegrationChannelRecord } from '../persistence/ports.js'
import { advertises } from './daemon-features.js'

export function requiredIntegrationFeatures(
  channels: readonly Pick<IntegrationChannelRecord, 'sessionMode'>[]
): readonly string[] {
  return channels.some((channel) => channel.sessionMode === 'append') ? [CONVERSATION_SESSION_MODE_V1_FEATURE] : []
}

export function daemonSupportsIntegration(
  channels: readonly Pick<IntegrationChannelRecord, 'sessionMode'>[],
  advertisedFeatures: readonly string[] | undefined
): boolean {
  return advertises(advertisedFeatures, requiredIntegrationFeatures(channels))
}

/** The send-side equivalent, checked again against the actual target connection. */
export function daemonSupportsIntegrationSpec(
  spec: Pick<IntegrationSpec, 'core'>,
  advertisedFeatures: readonly string[] | undefined
): boolean {
  return advertises(
    advertisedFeatures,
    spec.core?.sessionModes?.some((entry) => entry.mode === 'append') ? [CONVERSATION_SESSION_MODE_V1_FEATURE] : []
  )
}
