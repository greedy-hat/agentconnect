import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgStandingWorkRepo } from '../../src/persistence/repositories/standing-work.repo.js'

const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
// Repository approval checks the real clock; keep this fixture future dated.
const now = new Date('2099-09-22T00:00:00Z')
const input = {
  orgId: DEFAULT_ORG_ID,
  actorId: 'human-1',
  authorizationRevision: 1,
  idempotencyKey: 'creation-key-1',
  requestHash: 'hash-1',
  agentId,
  principalId: `standing-work:${DEFAULT_ORG_ID}`,
  name: 'Watch rollout',
  objective: 'Observe the rollout',
  schedule: '* * * * *',
  timezone: 'UTC',
  startAt: now,
  expiresAt: new Date(now.getTime() + 86_400_000),
  minIntervalSeconds: 60,
  maxRunsPerDay: 24,
  maxNotificationsPerDay: 2,
  conversationRef: null,
  targetDestination: { platform: 'slack', integrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', channel: 'C1' },
  budgetPolicyRef: 'default',
  toolPolicyRef: 'read-only',
  notificationPolicy: { mode: 'changes' as const, includeCompletion: true },
  visibilityPolicyRef: 'agent',
  sourceSessionId: null,
  scheduleMode: 'fixed' as const,
  maxIntervalSeconds: 86400,
  wakeOnConversation: false
}

describe('Standing Work definition repository', () => {
  it('keeps creation idempotent and refuses a different request under the same key', async () => {
    await seedAgent(prisma, agentId)
    const repo = new PgStandingWorkRepo(prisma)
    const first = await repo.create(input)
    expect(first).not.toBe('conflict')
    if (first === 'conflict') return
    expect(first.duplicate).toBe(false)
    expect(await repo.create(input)).toMatchObject({ duplicate: true, record: { id: first.record.id } })
    expect(await repo.create({ ...input, requestHash: 'hash-2' })).toBe('conflict')
    expect(await repo.list(DEFAULT_ORG_ID, 100)).toHaveLength(1)
  })

  it('fences an approved version after an edit or lifecycle change', async () => {
    await seedAgent(prisma, agentId)
    const repo = new PgStandingWorkRepo(prisma)
    const created = await repo.create(input)
    if (created === 'conflict') throw new Error('unexpected conflict')
    const id = created.record.id
    expect(
      (await repo.approve({ orgId: DEFAULT_ORG_ID, id, expectedVersion: 1, actorId: 'owner' }))?.approvalVersion
    ).toBe(1)
    const edited = await repo.replace({
      orgId: DEFAULT_ORG_ID,
      id,
      expectedVersion: 1,
      actorId: 'human-2',
      authorizationRevision: 2,
      definition: { ...input, objective: 'Observe safely' }
    })
    expect(edited).toMatchObject({
      definitionVersion: 2,
      approvalState: 'pending',
      approvalVersion: null,
      createdByActorId: 'human-1'
    })
    expect(await repo.approve({ orgId: DEFAULT_ORG_ID, id, expectedVersion: 1, actorId: 'owner' })).toBeNull()
    expect(
      await repo.transition({ orgId: DEFAULT_ORG_ID, id, expectedVersion: 1, actorId: 'human-1', state: 'paused' })
    ).toBeNull()
    expect(
      (await repo.transition({ orgId: DEFAULT_ORG_ID, id, expectedVersion: 2, actorId: 'human-1', state: 'paused' }))
        ?.definitionVersion
    ).toBe(3)
  })

  it('returns foreign organization identifiers as absent', async () => {
    await seedAgent(prisma, agentId)
    const repo = new PgStandingWorkRepo(prisma)
    const created = await repo.create(input)
    if (created === 'conflict') throw new Error('unexpected conflict')
    expect(await repo.get('other-org', created.record.id)).toBeNull()
    expect(
      await repo.approve({ orgId: 'other-org', id: created.record.id, expectedVersion: 1, actorId: 'owner' })
    ).toBeNull()
    expect(await repo.list('other-org', 100)).toEqual([])
  })
})
