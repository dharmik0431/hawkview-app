import assert from 'node:assert/strict'
import test from 'node:test'
import { readBoundedJson, validateManagementUrl } from './m365-management-activity.service.js'

// Qualification of current decoding and proposed selector limits, not a selector
// implementation or a requirement to preserve permissive decoding forever.
const rawPageLimit = 2 * 1024 * 1024
const proposedUriLimit = 3 * rawPageLimit
const proposedSerializedPageLimit = 8 * 1024 * 1024
const microsoftTenantId = '33333333-3333-3333-3333-333333333333'
const uriPrefix = `https://manage.office.com/api/v1.0/${microsoftTenantId}/activity/feed/audit?fixture=`
const opening = Buffer.from(`[{"contentId":"synthetic-bounds","contentUri":"${uriPrefix}`)
const closing = Buffer.from('"}]')

function responseBytes(fillByte: number, size = rawPageLimit) {
  return Buffer.concat([opening, Buffer.alloc(size - opening.length - closing.length, fillByte), closing])
}

async function readSyntheticUri(bytes: Buffer) {
  const budget = { remainingBytes: rawPageLimit }
  const response = new Response(new Uint8Array(bytes))
  const rows = await readBoundedJson(response, rawPageLimit, budget) as Array<{ contentUri: string }>
  assert.equal(rows.length, 1)
  assert.equal(budget.remainingBytes, 0, 'Accounting remains based on consumed response bytes')
  assert.doesNotThrow(() => validateManagementUrl(rows[0]!.contentUri, microsoftTenantId))
  return rows[0]!.contentUri
}

test('HAW-75 selector bounds distinguish raw discovery bytes from decoded ASCII URI bytes', async () => {
  const bytes = responseBytes(0x61)
  assert.equal(bytes.length, rawPageLimit)
  const uri = await readSyntheticUri(bytes)
  assert.ok(Buffer.byteLength(uri, 'utf8') < rawPageLimit)
  assert.ok(Buffer.byteLength(JSON.stringify({ contentUri: uri }), 'utf8') < proposedSerializedPageLimit)
})

test('HAW-75 current decoder can expand a bounded synthetic discovery URI beyond its raw byte ceiling', async () => {
  const bytes = responseBytes(0xff)
  const uri = await readSyntheticUri(bytes)
  const replacements = rawPageLimit - opening.length - closing.length
  assert.equal(uri.slice(uriPrefix.length), '\uFFFD'.repeat(replacements))
  const decodedBytes = Buffer.byteLength(uri, 'utf8')
  assert.equal(decodedBytes, Buffer.byteLength(uriPrefix, 'utf8') + replacements * 3)
  assert.ok(decodedBytes > rawPageLimit, 'A raw-body ceiling is not a persisted-URI byte ceiling')
  assert.ok(decodedBytes < proposedUriLimit)
  assert.ok(Buffer.byteLength(JSON.stringify({ contentUri: uri }), 'utf8') < proposedSerializedPageLimit)
  // A future strict UTF-8 rejection would require updating this qualification;
  // no live provider output, database row or full discovery call is exercised.
})

test('HAW-75 raw discovery overflow still rejects before parsing or successful budget accounting', async () => {
  const budget = { remainingBytes: rawPageLimit }
  await assert.rejects(
    readBoundedJson(new Response(new Uint8Array(responseBytes(0x61, rawPageLimit + 1))), rawPageLimit, budget),
    /response exceeded the 2097152-byte safety limit/,
  )
  assert.equal(budget.remainingBytes, rawPageLimit)
})

test('HAW-75 URI value bytes alone do not bound a serialized selector payload', () => {
  // Synthetic legacy-shaped text illustrates escaping cost; it is not evidence
  // that current discovery emits this row or that a future SQL format matches JSON.stringify.
  const uri = uriPrefix + '\u0001'.repeat(1_400_000)
  assert.ok(Buffer.byteLength(uri, 'utf8') < proposedUriLimit)
  const serialized = JSON.stringify({ contentUri: uri })
  assert.ok(Buffer.byteLength(serialized, 'utf8') > proposedSerializedPageLimit)
  assert.equal(JSON.parse(serialized).contentUri, uri, 'Truncation is not an acceptable size-bound workaround')
})
