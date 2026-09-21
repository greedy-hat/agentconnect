import { describe, expect, it } from 'vitest'
import { CONVERSATION_SESSION_MODE_V1_FEATURE, type IntegrationSpec } from '@agentconnect.md/protocol'
import {
  daemonSupportsIntegration,
  daemonSupportsIntegrationSpec,
  requiredIntegrationFeatures
} from './integration-features.js'

describe('conversation session integration feature fence', () => {
  const createNew = [{ sessionMode: 'createNew' as const }]
  const append = [{ sessionMode: 'append' as const }]

  it('requires the feature only for configured append', () => {
    expect(requiredIntegrationFeatures(createNew)).toEqual([])
    expect(requiredIntegrationFeatures(append)).toEqual([CONVERSATION_SESSION_MODE_V1_FEATURE])
    expect(daemonSupportsIntegration(createNew, undefined)).toBe(true)
    expect(daemonSupportsIntegration(append, undefined)).toBe(false)
    expect(daemonSupportsIntegration(append, [CONVERSATION_SESSION_MODE_V1_FEATURE])).toBe(true)
  })

  it('checks projected specs at the send boundary', () => {
    const spec = { core: { sessionModes: [{ channel: 'C1', mode: 'append' }] } } as IntegrationSpec
    expect(daemonSupportsIntegrationSpec(spec, [])).toBe(false)
    expect(daemonSupportsIntegrationSpec(spec, [CONVERSATION_SESSION_MODE_V1_FEATURE])).toBe(true)
    expect(daemonSupportsIntegrationSpec({ core: { sessionModes: [] } } as unknown as IntegrationSpec, [])).toBe(true)
  })
})
