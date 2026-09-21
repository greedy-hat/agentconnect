import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { currentSessionCoordinates, sessionKeyForCoordinates } from '../src/session/session-coordinate.js'
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
})
