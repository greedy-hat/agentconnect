import { describe, expect, it } from 'vitest'
import {
  admitExecution,
  authorizeTool,
  redactAuditDetails,
  type ExecutionProvenance
} from '../src/execution/governance.js'

const provenance: ExecutionProvenance = {
  orgId: 'org-1',
  agentId: 'agent-1',
  principalId: 'principal-1',
  authorizationRevision: 4,
  sessionId: 'session-1',
  runId: 'run-1',
  executionEpoch: 2,
  traceId: 'trace-1',
  actorId: 'user-1'
}

const policy = {
  audience: new Set(['user-1']),
  allowedTools: new Set(['read_file']),
  requireSandbox: true,
  maxToolCalls: 3
}
const capabilities = { sandbox: true, tools: new Set(['read_file']) }

describe('execution governance', () => {
  it('requires trusted provenance, a current audience, and an available sandbox', () => {
    expect(admitExecution(provenance, policy, capabilities)).toEqual({ allowed: true })
    expect(admitExecution({ ...provenance, actorId: 'other' }, policy, capabilities)).toEqual({
      allowed: false,
      reason: 'audience_denied'
    })
    expect(admitExecution(provenance, policy, { ...capabilities, sandbox: false })).toEqual({
      allowed: false,
      reason: 'sandbox_unavailable'
    })
    expect(admitExecution({ ...provenance, principalId: '' }, policy, capabilities)).toEqual({
      allowed: false,
      reason: 'invalid_context'
    })
  })

  it('fails closed for a tool missing from either policy or backend capability', () => {
    expect(authorizeTool(policy, capabilities, 'read_file')).toBe(true)
    expect(authorizeTool(policy, capabilities, 'shell')).toBe(false)
    expect(authorizeTool({ ...policy, allowedTools: new Set(['shell']) }, capabilities, 'shell')).toBe(false)
  })

  it('redacts secrets and unrestricted bodies before durable audit', () => {
    expect(
      redactAuditDetails({ token: 'nope', nested: { authorization: 'nope', useful: 'yes' }, body: 'raw' })
    ).toEqual({
      token: '[redacted]',
      nested: { authorization: '[redacted]', useful: 'yes' },
      body: '[redacted]'
    })
  })
})
