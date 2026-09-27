import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  currentSessionCoordinates,
  resolveSessionCoordinates,
  sessionKeyForCoordinates
} from '../src/session/session-coordinate.js'
import { transcriptCoords } from '../src/session/session-manager.js'

const message = (thread?: string): NormalizedMessage => ({
  msgId: 'slack:C1:100.2',
  traceId: 'trace',
  source: 'user',
  platform: 'slack',
  channel: 'C1',
  ...(thread ? { thread } : {}),
  sender: { id: 'U1', isBot: false },
  text: 'hello',
  mentionedBots: [],
  isDm: false
})

describe('session coordinates', () => {
  it('keeps current per-thread behavior for threaded and root messages', () => {
    expect(currentSessionCoordinates(message('100.1'))).toEqual({
      deliveryThread: '100.1',
      sessionThread: '100.1'
    })
    expect(currentSessionCoordinates(message())).toEqual({
      deliveryThread: 'slack:C1:100.2',
      sessionThread: 'slack:C1:100.2'
    })
  })

  it('uses a carried logical thread for session and transcript identity', () => {
    const inbound = message('physical')
    const coordinates = { deliveryThread: 'physical', sessionThread: 'logical' }
    expect(sessionKeyForCoordinates('agent-a', inbound, coordinates)).toBe('slack:C1:logical:agent-a')
    expect(transcriptCoords(inbound, coordinates)).toEqual({ thread: 'logical', ts: '100.2' })
  })

  it('keeps provider delivery physical while append resolves one logical lane per agent and transport', async () => {
    const reservations = new Map<string, string>()
    const store = {
      resolveAppendReservation: async (agentId: string, channel: string, transportScope: string) => {
        const key = `${agentId}:${channel}:${transportScope}`
        const existing = reservations.get(key)
        if (existing) return existing
        const coordinate = `append:${reservations.size + 1}`
        reservations.set(key, coordinate)
        return coordinate
      }
    }
    const root = { ...message(), transportScope: 'bot-a' }
    const reply = { ...message('physical-thread'), transportScope: 'bot-a' }
    await expect(resolveSessionCoordinates(store, 'agent-a', root, 'append')).resolves.toEqual({
      deliveryThread: 'slack:C1:100.2',
      sessionThread: 'append:1'
    })
    await expect(resolveSessionCoordinates(store, 'agent-a', reply, 'append')).resolves.toEqual({
      deliveryThread: 'physical-thread',
      sessionThread: 'append:1'
    })
    await expect(resolveSessionCoordinates(store, 'agent-b', root, 'append')).resolves.toMatchObject({
      sessionThread: 'append:2'
    })
  })
})
