/**
 * `standing-work/report` handler (operator timeline).
 *
 * A fire-and-forget EVT (no reply), the same shape as `cron/report`: the executing daemon stamps the run
 * in its own SQLite first and stays authoritative, then reports it so the console can inspect and stop
 * durable work. The write is fenced three times over — the org from the envelope, the reporting daemon
 * actually serving the definition's agent, and the run's own `definitionVersion`/`executionEpoch`/
 * `attempt` — so an unknown, foreign, or stale report drops silently and never errors the connection.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleStandingWorkReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('standing-work/report')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) return // no org to fence the reads on — drop, like every other unusable report
  // The definition's OWN agent, never the frame's claim: `agentId` rides an untrusted daemon payload.
  const work = await deps.standingWork.get(orgId, frame.payload.workId)
  if (!work) return // unknown / orphaned / out-of-org work — inert by design
  const agent = await deps.agent.get(orgId, AgentId(work.agentId))
  if (!agent) return
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  if (!(await resolver.mayAct(agent, DaemonId(conn.daemonId)))) return
  await deps.standingWork.recordReport(orgId, work.id, frame.payload)
}
