/**
 * `StandingWorkExpiryReaper` — sweeps `StandingWorkDef` rows whose `expiresAt` has
 * passed, transitioning them from `active`/`paused` to `expired` and suppressing
 * their pending CP-side notifications.
 *
 * The daemon has its own `expireStandingWork` on the local SQLite store (runs every
 * pump tick), but the CP's PostgreSQL projection has no equivalent writer — without
 * this sweep the console would show `active` past the expiry window. Both sides are
 * idempotent: the `state IN ('active','paused')` guard means a second writer finds
 * zero rows, and the daemon stays authoritative for execution.
 *
 * Same Clock-driven self-rescheduling `setTimeout` shape as `CronRunReaper`.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'

export interface StandingWorkExpiryReaperRepo {
  expireStandingWork(now: Date): Promise<number>
}

export interface StandingWorkExpiryReaperConfig {
  intervalMs: number
}

export interface ReaperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class StandingWorkExpiryReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly repo: StandingWorkExpiryReaperRepo,
    private readonly clock: Clock,
    private readonly cfg: StandingWorkExpiryReaperConfig,
    private readonly log?: ReaperLog
  ) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), this.cfg.intervalMs)
  }

  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const reaped = await this.repo.expireStandingWork(new Date(this.clock.now()))
      if (reaped > 0)
        this.log?.info({ reaped }, 'standing-work-expiry: transitioned past-expiry definitions to expired')
    } catch (err) {
      this.log?.error({ err }, 'standing-work-expiry: sweep failed')
    } finally {
      this.arm()
    }
  }
}
