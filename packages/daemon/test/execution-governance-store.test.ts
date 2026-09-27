import { describe, expect, it } from 'vitest'
import { openTestStore } from './store-support.js'

describe('execution governance store', () => {
  it('atomically reserves a finite quota and settles it exactly once', async () => {
    const store = await openTestStore()
    try {
      expect(await store.reserveExecutionQuota('r1', 'org-1', 'agent', 7, 10, 1)).toBe('reserved')
      expect(await store.reserveExecutionQuota('r2', 'org-1', 'agent', 4, 10, 2)).toBe('denied')
      expect(await store.reserveExecutionQuota('r1', 'org-1', 'agent', 7, 10, 3)).toBe('reserved')
      expect(await store.settleExecutionQuota('r1', 3, 4)).toBe(true)
      expect(await store.settleExecutionQuota('r1', 3, 5)).toBe(true)
      expect(await store.reserveExecutionQuota('r3', 'org-1', 'agent', 7, 10, 6)).toBe('reserved')
    } finally {
      await store.close()
    }
  })

  it('keeps audit intent through acknowledgement and deduplicates retries', async () => {
    const store = await openTestStore()
    try {
      expect(
        await store.appendExecutionAudit(
          'event-1',
          'org-1',
          'agent-1',
          { kind: 'tool_intent', details: { rawInput: 'secret' } },
          1
        )
      ).toBe(true)
      expect(await store.appendExecutionAudit('event-1', 'org-1', 'agent-1', { kind: 'tool_intent' }, 2)).toBe(false)
      expect(await store.pendingExecutionAudit('org-1', 10)).toEqual([
        { eventId: 'event-1', event: { kind: 'tool_intent', details: { rawInput: '[redacted]' } }, createdAt: 1 }
      ])
      expect(await store.acknowledgeExecutionAudit('event-1', 'org-1', 3)).toBe(true)
      expect(await store.pendingExecutionAudit('org-1', 10)).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('hands a drain only the rows about the agents it asked for, across every org', async () => {
    const store = await openTestStore()
    try {
      await store.appendExecutionAudit('mine-a', 'org-1', 'agent-me', { kind: 'admission' }, 1)
      await store.appendExecutionAudit('mine-b', 'org-2', 'agent-me', { kind: 'admission' }, 2)
      await store.appendExecutionAudit('theirs', 'org-1', 'agent-peer', { kind: 'admission' }, 3)
      expect(await store.pendingExecutionAuditForAgents(['agent-me'], 10)).toEqual([
        { eventId: 'mine-a', orgId: 'org-1', event: { kind: 'admission' } },
        { eventId: 'mine-b', orgId: 'org-2', event: { kind: 'admission' } }
      ])
      // An empty agent set is no claim on the outbox at all — not an unscoped read.
      expect(await store.pendingExecutionAuditForAgents([], 10)).toEqual([])
      expect(await store.pendingExecutionAuditForAgents(['agent-me', 'agent-peer'], 3)).toHaveLength(3)
      await store.acknowledgeExecutionAudit('mine-a', 'org-1')
      expect((await store.pendingExecutionAuditForAgents(['agent-me'], 10)).map((row) => row.eventId)).toEqual([
        'mine-b'
      ])
    } finally {
      await store.close()
    }
  })
})
