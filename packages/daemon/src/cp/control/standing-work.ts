import type { AnyFrame } from '@agentconnect.md/protocol'
import type { StandingWorkControlPlane, StandingWorkAuthority } from '../../execution/standing-work.js'
import type { ControlHandler } from './context.js'

/**
 * The CP has already authenticated the actor and resolved grants before it emits this control.
 * Keep that authority separate from the model-facing management API: a missing local adapter is
 * a refusal, never an implicit allow on an older daemon.
 */
export interface StandingWorkControlDeps {
  standingWorkControl?: StandingWorkControlPlane
}

type ControlPayload = {
  authority: StandingWorkAuthority
  action: 'approve' | 'pause' | 'resume' | 'cancel'
  orgId: string
  workId: string
  version: number
}

export const standingWorkControl: ControlHandler<StandingWorkControlDeps> = async (frame: AnyFrame, deps, wire) => {
  if (!deps.standingWorkControl) {
    wire.sendError(frame.id, 'CONFLICT', 'standing work is unavailable on this daemon', true)
    return
  }
  const payload = frame.payload as ControlPayload
  try {
    if (frame.orgId && frame.orgId !== payload.orgId) throw new Error('organization fence mismatch')
    const control = deps.standingWorkControl
    // Destination authority is not used by these lifecycle-only controls; it is required by
    // create/edit at the CP definition API, where the destination is present.
    const authority = payload.authority as StandingWorkAuthority
    const result =
      payload.action === 'approve'
        ? await control.approve(authority, payload.orgId, payload.workId, payload.version)
        : payload.action === 'pause'
          ? await control.pause(authority, payload.orgId, payload.workId, payload.version)
          : payload.action === 'resume'
            ? await control.resume(authority, payload.orgId, payload.workId, payload.version)
            : await control.cancel(authority, payload.orgId, payload.workId, payload.version)
    wire.reply(frame, 'ack', { ok: result !== undefined && result !== false })
  } catch (error) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', `standing work control failed: ${(error as Error).message}`, false)
  }
}
