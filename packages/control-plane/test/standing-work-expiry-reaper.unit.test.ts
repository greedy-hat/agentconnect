import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from './fakes/fake-clock.js'
import { StandingWorkExpiryReaper } from '../src/orchestrator/standingWorkExpiryReaper.js'
import type { ReaperLog, StandingWorkExpiryReaperRepo } from '../src/orchestrator/standingWorkExpiryReaper.js'

function makeRepo(
  expireStandingWork: (now: Date) => Promise<number> = vi.fn().mockResolvedValue(0)
): StandingWorkExpiryReaperRepo {
  return { expireStandingWork }
}

function makeLog(): ReaperLog & { infos: unknown[][]; errors: unknown[][] } {
  const infos: unknown[][] = []
  const errors: unknown[][] = []
  return {
    infos,
    errors,
    info: (obj: unknown, msg?: string) => {
      infos.push([obj, msg])
    },
    error: (obj: unknown, msg?: string) => {
      errors.push([obj, msg])
    }
  }
}

describe('StandingWorkExpiryReaper', () => {
  it('schedules a timer on start at the configured interval', () => {
    const clock = new FakeClock(1_000_000)
    const reaper = new StandingWorkExpiryReaper(makeRepo(), clock, { intervalMs: 30_000 })
    expect(clock.pendingTimers()).toBe(0)
    reaper.start()
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
  })

  it('clears the timer on stop', () => {
    const clock = new FakeClock()
    const reaper = new StandingWorkExpiryReaper(makeRepo(), clock, { intervalMs: 10_000 })
    reaper.start()
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('fires expireStandingWork with the current clock time when the timer elapses', async () => {
    const clock = new FakeClock(5_000)
    const expireSpy = vi.fn<(now: Date) => Promise<number>>().mockResolvedValue(0)
    const reaper = new StandingWorkExpiryReaper(makeRepo(expireSpy), clock, { intervalMs: 1_000 })
    reaper.start()
    clock.advance(1_000)
    // The callback is async; wait for the microtask queue to drain.
    await vi.waitFor(() => expect(expireSpy).toHaveBeenCalledWith(new Date(6_000)))
    reaper.stop()
  })

  it('logs the reaped count when rows were transitioned', async () => {
    const clock = new FakeClock()
    const expireSpy = vi.fn<(now: Date) => Promise<number>>().mockResolvedValue(3)
    const log = makeLog()
    const reaper = new StandingWorkExpiryReaper(makeRepo(expireSpy), clock, { intervalMs: 500 }, log)
    reaper.start()
    clock.advance(500)
    await vi.waitFor(() => expect(expireSpy).toHaveBeenCalled())
    expect(log.infos).toHaveLength(1)
    expect(log.infos[0]).toMatchObject([{ reaped: 3 }, expect.stringContaining('transitioned')])
    reaper.stop()
  })

  it('does not log when zero rows were reaped', async () => {
    const clock = new FakeClock()
    const expireSpy = vi.fn<(now: Date) => Promise<number>>().mockResolvedValue(0)
    const log = makeLog()
    const reaper = new StandingWorkExpiryReaper(makeRepo(expireSpy), clock, { intervalMs: 500 }, log)
    reaper.start()
    clock.advance(500)
    await vi.waitFor(() => expect(expireSpy).toHaveBeenCalled())
    expect(log.infos).toHaveLength(0)
    reaper.stop()
  })

  it('logs an error and reschedules when the sweep throws', async () => {
    const clock = new FakeClock()
    const boom = new Error('db down')
    const expireSpy = vi.fn<(now: Date) => Promise<number>>().mockRejectedValue(boom)
    const log = makeLog()
    const reaper = new StandingWorkExpiryReaper(makeRepo(expireSpy), clock, { intervalMs: 200 }, log)
    reaper.start()
    clock.advance(200)
    await vi.waitFor(() => expect(expireSpy).toHaveBeenCalled())
    expect(log.errors).toHaveLength(1)
    expect(log.errors[0]![0]).toMatchObject({ err: boom })
    // The reaper must re-arm after failure so the next tick still fires.
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
  })

  it('reschedules after each tick so the sweep keeps running', async () => {
    const clock = new FakeClock()
    const expireSpy = vi.fn<(now: Date) => Promise<number>>().mockResolvedValue(0)
    const reaper = new StandingWorkExpiryReaper(makeRepo(expireSpy), clock, { intervalMs: 100 })
    reaper.start()
    clock.advance(100)
    await vi.waitFor(() => expect(expireSpy).toHaveBeenCalledTimes(1))
    clock.advance(100)
    await vi.waitFor(() => expect(expireSpy).toHaveBeenCalledTimes(2))
    reaper.stop()
  })

  it('does not fire after stop', async () => {
    const clock = new FakeClock()
    const expireSpy = vi.fn<(now: Date) => Promise<number>>().mockResolvedValue(0)
    const reaper = new StandingWorkExpiryReaper(makeRepo(expireSpy), clock, { intervalMs: 100 })
    reaper.start()
    reaper.stop()
    clock.advance(1_000)
    expect(expireSpy).not.toHaveBeenCalled()
  })
})
