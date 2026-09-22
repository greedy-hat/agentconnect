import { describe, expect, it } from 'vitest'
import { LocalStore, sessionKey, type StoreDatabase } from '../src/store/local-store.js'
import { memoryStoreDatabase, openTestStore, usingPostgresStore } from './store-support.js'

const pg = usingPostgresStore()
const AGENT = 'agent-append'
const CHANNEL = 'C-append'

async function members(): Promise<[LocalStore, LocalStore]> {
  if (!pg) {
    const backing = memoryStoreDatabase()
    const database: StoreDatabase = {
      exec: (sql) => backing.exec(sql),
      query: (sql, params) => backing.query(sql, params),
      batch: (statements) => backing.batch(statements),
      transaction: (fn) => backing.transaction(fn),
      close: async () => undefined
    }
    const options = { database, shared: true, orgForAgent: () => 'org-1' }
    return [
      await openTestStore({ ...options, ownerId: 'member-a' }),
      await openTestStore({ ...options, ownerId: 'member-b' })
    ]
  }
  const options = { shared: true, orgForAgent: () => 'org-1' }
  return [
    await openTestStore({ ...options, ownerId: 'member-a' }),
    await openTestStore({ ...options, ownerId: 'member-b' })
  ]
}

async function saveSession(store: LocalStore, coordinate: string): Promise<string> {
  const key = sessionKey('slack', CHANNEL, coordinate, AGENT, 'bot-1')
  await store.upsertSession({
    key,
    agentId: AGENT,
    platform: 'slack',
    channel: CHANNEL,
    thread: coordinate,
    transportScope: 'bot-1',
    acpSessionId: null,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 100
  })
  return key
}

describe('append reservation store', () => {
  it('converges concurrent first uses before a session row exists and scopes by agent and transport', async () => {
    const [a, b] = await members()
    try {
      const [first, second] = await Promise.all([
        a.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1000),
        b.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1000)
      ])
      expect(first).toBe(second)
      expect(await b.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1)).toBe(first)
      expect(await a.resolveAppendReservation('other-agent', CHANNEL, 'bot-1', 1000)).toBe('append:1000')
      expect(await a.resolveAppendReservation(AGENT, CHANNEL, 'bot-2', 1000)).toBe('append:1000')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('uses one CAS winner for concurrent resets and advances monotonically through clock rollback', async () => {
    const [a, b] = await members()
    try {
      const initial = await a.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1000)
      const [left, right] = await Promise.all([
        a.advanceAppendReservation(AGENT, CHANNEL, 'bot-1', initial, 900),
        b.advanceAppendReservation(AGENT, CHANNEL, 'bot-1', initial, 900)
      ])
      expect([left?.advanced, right?.advanced].sort()).toEqual([false, true])
      expect(left?.coordinate).toBe(right?.coordinate)
      expect(left?.coordinate).toBe('append:1001')
      const sequential = await a.advanceAppendReservation(AGENT, CHANNEL, 'bot-1', left!.coordinate, 800)
      expect(sequential).toEqual({ coordinate: 'append:1002', advanced: true })
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('deduplicates a redelivered reset command after the reservation has advanced', async () => {
    const [a, b] = await members()
    try {
      const initial = await a.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1000)
      const first = await a.advanceAppendReservation(AGENT, CHANNEL, 'bot-1', initial, 1001, 'slack:C1:reset-1')
      expect(first).toEqual({ coordinate: 'append:1001', advanced: true })
      // A retry resolves today's reservation first, but must still return the
      // coordinate the original command minted rather than advance to 1002.
      const replay = await b.advanceAppendReservation(
        AGENT,
        CHANNEL,
        'bot-1',
        await b.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 2000),
        2000,
        'slack:C1:reset-1'
      )
      expect(replay).toEqual({ coordinate: 'append:1001', advanced: false, duplicate: true })
      expect(await a.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 2001)).toBe('append:1001')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('clears only the reservation still naming a purged session and preserves the high-water mark', async () => {
    const [a, b] = await members()
    try {
      const old = await a.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1000)
      const oldKey = await saveSession(a, old)
      await a.appendTranscript({
        channel: CHANNEL,
        thread: old,
        ts: '1',
        sender: 'user',
        kind: 'text',
        text: 'old',
        orgAgentId: AGENT
      })
      const next = await b.advanceAppendReservation(AGENT, CHANNEL, 'bot-1', old, 900)
      expect(next?.coordinate).toBe('append:1001')
      await a.deleteSession(oldKey)
      expect(await b.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1)).toBe(next!.coordinate)
      const nextKey = await saveSession(b, next!.coordinate)
      await b.deleteSession(nextKey)
      expect(await a.resolveAppendReservation(AGENT, CHANNEL, 'bot-1', 1)).toBe('append:1002')
      expect((await a.threadTranscript(CHANNEL, old, AGENT)).map((row) => row.text)).toEqual(['old'])
    } finally {
      await a.close()
      await b.close()
    }
  })
})
