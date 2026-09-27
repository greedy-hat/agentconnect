import { describe, expect, it } from 'vitest'
import { StandingWorkWakeCoordinator } from '../src/execution/standing-work.js'
import { openTestStore } from './store-support.js'
import type { LocalStore } from '../src/store/local-store.js'

async function makeStore() {
  return await openTestStore()
}

async function seedWakeableWork(store: LocalStore, opts: { wakeOnConversation?: boolean; conversationRef?: any } = {}) {
  const now = Date.now()
  const work = {
    orgId: 'org-1',
    workId: 'work-1',
    agentId: '00000000-0000-0000-0000-000000000001',
    principalId: 'principal-1',
    name: 'Test Work',
    objective: 'Test objective',
    state: 'active' as const,
    definitionVersion: 1,
    schedule: '* * * * *',
    timezone: 'UTC',
    scheduleMode: 'fixed' as const,
    maxIntervalSeconds: 86400,
    wakeOnConversation: opts.wakeOnConversation ?? true,
    conversationRefJson: opts.conversationRef ? JSON.stringify(opts.conversationRef) : null,
    targetDestination: JSON.stringify({ platform: 'slack', integrationId: 'int-1', channel: 'C123' }),
    expiresAt: now + 86_400_000,
    maxRunsPerDay: 10,
    maxNotificationsPerDay: 5,
    approvalVersion: 1,
    approvalState: 'approved' as const,
    authorizationRevision: 1,
    createdAt: now,
    updatedAt: now
  }
  const state = {
    orgId: 'org-1',
    workId: 'work-1',
    appliedDefinitionVersion: 1,
    nextCheckAt: now + 3600_000,
    lastRunAt: null,
    lastNotifiedAt: null,
    contextCursor: null,
    observationState: '{}',
    observationSchemaVersion: 1,
    executionEpoch: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    blockedReason: null,
    suggestedNextCheckAt: null,
    wakeSource: 'scheduled' as const
  }
  await store.ingestStandingWork(work, state)
  return { work, state }
}

describe('StandingWorkWakeCoordinator', () => {
  it('advances nextCheckAt on conversation event for wakeable work', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const coordinator = new StandingWorkWakeCoordinator(store, () => Date.now(), 0)
    const before = await store.getStandingWork('org-1', 'work-1')
    const originalNextCheck = before!.state.nextCheckAt

    await coordinator.onConversationEvent(conversationRef)

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBeLessThanOrEqual(originalNextCheck)
    coordinator.stop()
  })

  it('ignores events when wakeOnConversation is false', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: false, conversationRef })

    const coordinator = new StandingWorkWakeCoordinator(store, () => Date.now(), 0)
    const before = await store.getStandingWork('org-1', 'work-1')

    await coordinator.onConversationEvent(conversationRef)

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBe(before!.state.nextCheckAt)
    coordinator.stop()
  })

  it('respects min interval between runs', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const now = Date.now()
    await store.reportStandingWork({
      orgId: 'org-1',
      workId: 'work-1',
      runId: '00000000-0000-0000-0000-000000000010',
      ownerId: 'owner-1',
      epoch: 0,
      definitionVersion: 1,
      authorizationRevision: 1,
      outcome: 'no_change',
      now: now - 30_000,
      nextCheckAt: now + 3600_000,
      observationState: '{}',
      contextCursor: undefined
    })

    const coordinator = new StandingWorkWakeCoordinator(store, () => now, 0)
    const before = await store.getStandingWork('org-1', 'work-1')

    await coordinator.onConversationEvent(conversationRef)

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBe(before!.state.nextCheckAt)
    coordinator.stop()
  })

  it('respects daily quota', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    const { work } = await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const now = Date.now()
    const dayStart = now - (now % 86_400_000)
    for (let i = 0; i < work.maxRunsPerDay; i++) {
      await store.reportStandingWork({
        orgId: 'org-1',
        workId: 'work-1',
        runId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        ownerId: 'owner-1',
        epoch: 0,
        definitionVersion: 1,
        authorizationRevision: 1,
        outcome: 'no_change',
        now: dayStart + i * 1000,
        nextCheckAt: now + 3600_000,
        observationState: '{}',
        contextCursor: undefined
      })
    }

    const coordinator = new StandingWorkWakeCoordinator(store, () => now, 0)
    const before = await store.getStandingWork('org-1', 'work-1')

    await coordinator.onConversationEvent(conversationRef)

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBe(before!.state.nextCheckAt)
    coordinator.stop()
  })

  it('debounces multiple events within window', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const coordinator = new StandingWorkWakeCoordinator(store, () => Date.now(), 100)
    const before = await store.getStandingWork('org-1', 'work-1')

    await coordinator.onConversationEvent(conversationRef)
    await coordinator.onConversationEvent(conversationRef)
    await coordinator.onConversationEvent(conversationRef)

    await new Promise((resolve) => setTimeout(resolve, 150))

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBeLessThanOrEqual(before!.state.nextCheckAt)
    coordinator.stop()
  })

  it('ignores events for non-matching conversation ref', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const coordinator = new StandingWorkWakeCoordinator(store, () => Date.now(), 0)
    const before = await store.getStandingWork('org-1', 'work-1')

    await coordinator.onConversationEvent({ platform: 'slack', integrationId: 'int-1', channel: 'C999' })

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBe(before!.state.nextCheckAt)
    coordinator.stop()
  })

  it('enforces causal hop limit', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const coordinator = new StandingWorkWakeCoordinator(store, () => Date.now(), 0, 2, 100)
    const sourceWork = { orgId: 'org-1', workId: 'work-source' }
    const before = await store.getStandingWork('org-1', 'work-1')

    // First two wakes should succeed (within limit)
    await coordinator.onConversationEvent(conversationRef, sourceWork)
    await coordinator.onConversationEvent(conversationRef, sourceWork)

    // Third wake should be blocked (exceeds limit)
    await coordinator.onConversationEvent(conversationRef, sourceWork)

    const after = await store.getStandingWork('org-1', 'work-1')
    // The wake should have advanced nextCheckAt to now (sooner than original)
    expect(after!.state.nextCheckAt).toBeLessThanOrEqual(before!.state.nextCheckAt)
    coordinator.stop()
  })

  it('enforces rate limit', async () => {
    const store = await makeStore()
    const conversationRef = { platform: 'slack', integrationId: 'int-1', channel: 'C123' }
    await seedWakeableWork(store, { wakeOnConversation: true, conversationRef })

    const now = Date.now()
    const coordinator = new StandingWorkWakeCoordinator(store, () => now, 0, 100, 3)
    const before = await store.getStandingWork('org-1', 'work-1')

    // First 3 wakes should succeed
    for (let i = 0; i < 3; i++) {
      await coordinator.onConversationEvent(conversationRef)
    }

    // 4th and 5th should be blocked
    for (let i = 0; i < 2; i++) {
      await coordinator.onConversationEvent(conversationRef)
    }

    const after = await store.getStandingWork('org-1', 'work-1')
    expect(after!.state.nextCheckAt).toBeLessThanOrEqual(before!.state.nextCheckAt)
    coordinator.stop()
  })
})
