import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'
import { runRiskTransaction } from './risk-bounded-prisma-transaction.js'

function packet(kind: string, payload: Buffer) {
  const size = Buffer.alloc(4); size.writeInt32BE(payload.length + 4)
  return Buffer.concat([Buffer.from(kind), size, payload])
}
const ready = packet('Z', Buffer.from('T'))
const command = (sql: string) => Buffer.concat([packet('C', Buffer.from(`${sql}\0`)), ready])

test('risk-owned Prisma transport drains startup, BEGIN, query and rollback stalls without abandoned callbacks/sockets', { timeout: 15_000 }, async () => {
  const prior = process.env.DATABASE_URL
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    for (const stall of ['startup', 'BEGIN', 'SELECT', 'ROLLBACK'] as const) {
      let connections = 0; let callbacks = 0; let callbackSettled = false
      const sockets = new Set<net.Socket>(); const queries: string[] = []
      const server = net.createServer(socket => {
        connections++; sockets.add(socket)
        socket.on('error', () => undefined)
        socket.on('close', () => sockets.delete(socket))
        let startup = true; let buffer = Buffer.alloc(0)
        socket.on('data', chunk => {
          buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
          if (startup) {
            if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return
            buffer = buffer.subarray(buffer.readInt32BE(0)); startup = false
            if (stall === 'startup') return
            socket.write(Buffer.concat([packet('R', Buffer.alloc(4)), packet('Z', Buffer.from('I'))]))
          }
          while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
            const length = buffer.readInt32BE(1)
            const kind = String.fromCharCode(buffer[0]!)
            const sql = buffer.subarray(5, length).toString()
            buffer = buffer.subarray(length + 1)
            if (kind !== 'Q') continue
            queries.push(sql)
            if (sql.startsWith(stall)) continue
            socket.write(command(sql.startsWith('SELECT') ? 'SELECT 0' : sql))
          }
        })
      })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      process.env.DATABASE_URL = `postgresql://synthetic@127.0.0.1:${(server.address() as net.AddressInfo).port}/synthetic?sslmode=disable`
      try {
        const start = Date.now()
        await assert.rejects(runRiskTransaction({} as any, { executionDeadlineAt: start + 650 }, async tx => {
          callbacks++
          try {
            if (stall === 'ROLLBACK') throw new Error('Synthetic rollback request')
            await tx.$executeRawUnsafe('SELECT 1')
            assert.fail('Stalled SELECT must not return')
          } finally { callbackSettled = true }
        }))
        assert.ok(Date.now() - start < 2_000, `Unbounded ${stall}`)
        assert.equal(callbacks, ['SELECT', 'ROLLBACK'].includes(stall) ? 1 : 0)
        if (callbacks) assert.equal(callbackSettled, true, 'callback must settle before boundary returns')
        assert.equal(sockets.size, 0, `Actual socket still open when ${stall} boundary returns`)
        const count = queries.length
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.equal(queries.length, count, 'No late query/write after return')
        assert.equal(connections, 1, 'No reconnect or pool retry')
        assert.deepEqual(unhandled, [])
        if (stall === 'ROLLBACK') assert.ok(queries.includes('ROLLBACK'), 'Must exercise actual rollback transport')
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior
  }
})

test('zero/invalid budget never acquires a connection or invokes work; legacy transaction is unchanged', async () => {
  let calls = 0
  const shared = { $transaction: async (work: any) => { calls++; return work({ sentinel: true }) } } as any
  for (const executionDeadlineAt of [Date.now() - 1, NaN, Infinity]) {
    await assert.rejects(runRiskTransaction(shared, { executionDeadlineAt }, async () => { calls++; }), /CYCLE_DEFERRED/)
  }
  assert.equal(calls, 0)
  assert.equal(await runRiskTransaction(shared, {}, async tx => (tx as any).sentinel), true)
  assert.equal(calls, 1)
})
