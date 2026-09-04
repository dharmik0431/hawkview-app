import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { MailboxRiskProjector } from './mailbox-risk-projector.service.js'
import { IdentityRiskPseudonymProvider } from './identity-risk-pseudonym.js'
import { mailboxNow, mailboxScope } from './mailbox-risk.test-fixtures.js'

test('stalled connection acquisition and query transport close their actual sockets without queued work', { timeout: 10000 }, async () => {
  const previousUrl = process.env.DATABASE_URL
  try {
    process.env.DATABASE_URL = 'postgresql://synthetic:SYNTHETIC_PASSWORD@[invalid/not-a-host'
    await assert.rejects(() => withMailboxReadTransaction(Date.now() + 600, 500, async () => undefined),
      (error: unknown) => error instanceof Error && error.message === 'IDENTITY_RISK_SOURCE_UNAVAILABLE')
    for (const acceptStartup of [false, true]) {
      const sockets = new Set<net.Socket>()
      let connections = 0
      const server = net.createServer((socket) => {
        connections++; sockets.add(socket)
        socket.on('error', () => undefined)
        socket.on('close', () => sockets.delete(socket))
        if (acceptStartup) socket.once('data', () => {
          // Synthetic PostgreSQL AuthenticationOk + ReadyForQuery; subsequent
          // transaction requests deliberately never receive a response.
          socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]))
          socket.on('data', () => undefined)
        })
        else socket.on('data', () => undefined)
      })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address() as net.AddressInfo
      process.env.DATABASE_URL = `postgresql://synthetic@127.0.0.1:${address.port}/synthetic`
      try {
        // The unconfigured production provider must not even open a socket.
        await assert.rejects(() => new MailboxRiskProjector(new IdentityRiskPseudonymProvider()).load(mailboxScope, mailboxNow), /KEY_UNAVAILABLE/)
        assert.equal(connections, 0)
        const started = Date.now()
        await assert.rejects(() => withMailboxReadTransaction(started + 600, 500, async () => { throw new Error('Should not reach read') }),
          (error: unknown) => error instanceof Error && error.message === 'IDENTITY_RISK_SOURCE_UNAVAILABLE')
        assert.ok(Date.now() - started < 2000)
        for (let attempt = 0; sockets.size && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
        assert.equal(connections, 1)
        assert.equal(sockets.size, 0, 'deadline must close the connection, not merely return early')
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      }
    }
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl
  }
})
