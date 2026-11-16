import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ObservationLedger } from '../src/mcp/observations.js'
import { profileSchema, type BrokerReceipt } from '../src/mcp/contracts.js'
import { receiptWireSchema, observationWireSchema } from '../src/mcp/protocol.js'
const receipt: BrokerReceipt = { protocol: 'sapper-mcp/1', kind: 'receipt', receiptId: randomUUID(), invocationId: randomUUID(), callId: 'read-registers', owner: { hostInstanceId: randomUUID(), workspaceId: 'workspace-A', challengeId: 't-A', taskId: 't-A', runId: 'r001', agentId: randomUUID(), role: 'explore' }, toolRef: { connectionRef: 'gdb', publicName: 'mcp__gdb__measure', schemaDigest: 'sha256:' + '1'.repeat(64) }, argumentsDigest: 'sha256:' + '2'.repeat(64), resultDigest: 'sha256:' + '3'.repeat(64), resource: { backendId: 'gdb', resourceId: 'inferior-1', generation: 1, kind: 'generic' }, target: { assetRefs: [], assetDigests: ['sha256:' + 'a'.repeat(64)], binding: 'attested' }, fence: 1, epoch: 1, status: 'success', source: 'target', artifacts: [], startedAt: '2026-11-16T12:00:00Z', endedAt: '2026-11-16T12:00:01Z' }
const profile = profileSchema.parse({ id: 'gdb', label: 'GDB', backendId: 'gdb', selectors: ['mcp__gdb__*'], measurements: [
  { tool: receipt.toolRef.publicName, claim: 'PIE base', valuePath: 'base', validity: 'resource-epoch' },
  { tool: receipt.toolRef.publicName, claim: 'gadget offset', valuePath: 'offset', validity: 'asset', assetDigestPath: 'binaryDigest' },
] })
const result = { isError: false as const, value: { base: '0x7f00000', offset: 132, binaryDigest: 'a'.repeat(64) }, content: [] }
it('invalidates process addresses after restart while preserving file measurements for the same digest', () => {
  const ledger = new ObservationLedger(), observations = ledger.record(receipt, result, profile)
  expect(observations).toHaveLength(2)
  observations.forEach((o) => expect(observationWireSchema.safeParse(o).success).toBe(true))
  const next = [{ backendId: 'gdb', resourceId: 'inferior-1', generation: 2, epoch: 2 }]
  expect(ledger.list(next, receipt.target.assetDigests).map((o) => o.currentlyApplicable)).toEqual([false, true])
  expect(() => ledger.require([observations[0]!.observationId], next)).toThrow('STALE_EPOCH')
})
it('keeps inferred or disk-loaded measurements from becoming fresh preconditions', () => {
  const ledger = new ObservationLedger(), inferred = ledger.infer(receipt, 'guessed base', '0x1234')
  expect(inferred.state).toBe('inferred')
  const records = ledger.record(receipt, result, profile), cold = new ObservationLedger()
  cold.load(records[0]); cold.load({ ...records[0], observationId: randomUUID(), validity: { scope: 'asset', assetDigests: 'malformed' } })
  expect(cold.list([{ ...receipt.resource, epoch: 1 }])).toHaveLength(1)
  expect(cold.list([{ ...receipt.resource, epoch: 1 }])[0]?.currentlyApplicable).toBe(false)
  expect(ledger.list([{ ...receipt.resource, epoch: 1 }]).find((v) => v.observationId === inferred.observationId)?.currentlyApplicable).toBe(false)
})
it('records repair guidance from actual failures without rewriting old measurements or replaying side effects', () => {
  const ledger = new ObservationLedger(), records = ledger.record(receipt, result, profile)
  const error = { ...receipt, receiptId: randomUUID(), status: 'error' as const, errorCode: 'TOOL_ERROR' as const }
  const input = { preserve: [records[1]!.observationId], invalidate: [records[0]!.observationId], resumeFrom: 'fresh-resource' as const, nextCapability: 'debug.memory.read', reason: 'inferior corrupted' }
  expect(() => ledger.diagnose(receipt, input)).toThrow('实际失败')
  expect(() => ledger.diagnose(error, { ...input, preserve: input.invalidate })).toThrow('不能相交')
  expect(ledger.diagnose(error, input).replaySafeStepRefs).toEqual([])
  expect(records[0]?.state).toBe('observed')
  expect(ledger.list([{ ...receipt.resource, epoch: 1 }], receipt.target.assetDigests).map((o) => o.currentlyApplicable)).toEqual([false, true])
})
it('requires a final digest for success and rejects invented owner privilege fields', () => {
  expect(receiptWireSchema.safeParse(receipt).success).toBe(true)
  expect(receiptWireSchema.safeParse({ ...receipt, resultDigest: undefined }).success).toBe(false)
  expect(receiptWireSchema.safeParse({ ...receipt, owner: { ...receipt.owner, fullAccess: true } }).success).toBe(false)
})
