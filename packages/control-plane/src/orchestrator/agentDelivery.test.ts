import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_SESSION_MODE_V1_FEATURE,
  GITLAB_COM_V1_FEATURE,
  type IntegrationSpec
} from '@agentconnect.md/protocol'
import { AgentDelivery } from './agentDelivery.js'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { AgentRecord } from '../persistence/ports.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'

function agentWith(mode: string): AgentRecord {
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    daemonId: DAEMON,
    workspace: { mode } as AgentRecord['workspace']
  } as AgentRecord
}

function harness(features: readonly string[] | undefined) {
  const sent: string[] = []
  const delivery = new AgentDelivery({
    control: {
      agentUpsert: async (daemonId: string) => {
        sent.push(daemonId)
      },
      agentRemove: async () => {},
      integrationUpsert: async (daemonId: string) => {
        sent.push(daemonId)
      },
      integrationRemove: async () => {},
      cronUpsert: async () => ({ ok: true }),
      cronRemove: async () => ({ ok: true })
    },
    specs: { assemble: async () => ({ agentId: 'a' }) } as unknown as AgentSpecAssembler,
    daemonFeatures: () => features
  })
  return { delivery, sent }
}

describe('AgentDelivery §17.3 projection gate', () => {
  it('delivers ungated agents regardless of advertised features', async () => {
    const { delivery, sent } = harness(undefined)
    await delivery.upsert(agentWith('github'), () => {})
    expect(sent).toEqual([DAEMON])
  })

  it('skips a target that has not advertised a gated agent required feature', async () => {
    const { delivery, sent } = harness([])
    await delivery.upsert(agentWith('gitlab'), () => {})
    expect(sent).toEqual([])
  })

  it('delivers a gated agent once the target advertises the feature', async () => {
    const { delivery, sent } = harness([GITLAB_COM_V1_FEATURE])
    await delivery.upsert(agentWith('gitlab'), () => {})
    expect(sent).toEqual([DAEMON])
  })

  it('withholds append integration updates until the target advertises session mode support', async () => {
    const spec = { core: { sessionModes: [{ channel: 'C1', mode: 'append' }] } } as IntegrationSpec
    const old = harness(undefined)
    await old.delivery.integrationUpsert(agentWith('github'), spec, () => {})
    expect(old.sent).toEqual([])
    const upgraded = harness([CONVERSATION_SESSION_MODE_V1_FEATURE])
    await upgraded.delivery.integrationUpsert(agentWith('github'), spec, () => {})
    expect(upgraded.sent).toEqual([DAEMON])
  })
})
