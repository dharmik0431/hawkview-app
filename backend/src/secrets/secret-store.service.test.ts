import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SEALED_WITH_UNAVAILABLE_KEY, SecretStoreService } from './secret-store.service.js'
import {
  CURRENT_KEY_VARIABLE,
  KEY_VERSION_VARIABLE,
  PREVIOUS_KEY_VARIABLE,
} from './secret-encryption-keys.js'
import { PLATFORM_OWNED, TENANT_SCOPE_UNSUPPORTED } from './secret-owner.js'

/** Key rotation, and the one property the whole change exists for: **rotating the
 * encryption key must not make a stored secret unreadable.**
 *
 * Two rows exist in production — the Microsoft client secret that reads all five
 * customer tenants, and the key that signs consent-state tokens. Before this
 * change, changing `SECRET_ENCRYPTION_KEY` destroyed both, and the resulting
 * error was the same one a corrupt row produces, so the mistake was
 * indistinguishable from data loss. These tests run the whole rotation.
 */

const KEY_ONE = '11'.repeat(32)
const KEY_TWO = '22'.repeat(32)
const KEY_THREE = '33'.repeat(32)

interface Row {
  id: string
  name: string
  ciphertext: Uint8Array
  initializationVector: Uint8Array
  authenticationTag: Uint8Array
  keyVersion: number
  legacyReference?: string | null
}

/** A tiny in-memory stand-in for the one table this service touches. It enforces
 * the guarded update, because that guard is what keeps two concurrent re-seals
 * from labelling a row one version while sealing it with another. */
function database() {
  const rows = new Map<string, Row>()
  let updateFails = false
  const prisma = {
    encryptedSecret: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where.id === 'string') return rows.get(where.id) ?? null
        if (typeof where.name === 'string') {
          return [...rows.values()].find((row) => row.name === where.name) ?? null
        }
        if (typeof where.legacyReference === 'string') {
          return [...rows.values()].find((row) => row.legacyReference === where.legacyReference) ?? null
        }
        return null
      },
      upsert: async ({ where, create, update }: {
        where: { name: string }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) => {
        const existing = [...rows.values()].find((row) => row.name === where.name)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { id: randomUUID(), ...create } as Row
        rows.set(row.id, row)
        return row
      },
      updateMany: async ({ where, data }: {
        where: { id: string; keyVersion: number }
        data: Record<string, unknown>
      }) => {
        if (updateFails) throw new Error('write unavailable')
        const row = rows.get(where.id)
        // THE GUARD. A re-seal only applies to the version it read.
        if (!row || row.keyVersion !== where.keyVersion) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      findMany: async () => [...rows.values()],
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where.id === 'string') rows.delete(where.id)
        return { count: 1 }
      },
    },
  }
  return {
    rows,
    prisma,
    breakWrites: () => { updateFails = true },
    service: () => new SecretStoreService(prisma as never),
  }
}

/** Runs `work` with a specific key configuration, restoring the environment. */
async function withKeys(
  configuration: { current: string; version?: string; previous?: string },
  work: () => Promise<void>,
) {
  const keys = [CURRENT_KEY_VARIABLE, KEY_VERSION_VARIABLE, PREVIOUS_KEY_VARIABLE]
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env[CURRENT_KEY_VARIABLE] = configuration.current
  if (configuration.version === undefined) delete process.env[KEY_VERSION_VARIABLE]
  else process.env[KEY_VERSION_VARIABLE] = configuration.version
  if (configuration.previous === undefined) delete process.env[PREVIOUS_KEY_VARIABLE]
  else process.env[PREVIOUS_KEY_VARIABLE] = configuration.previous
  try { await work() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('A ROTATION DOES NOT DESTROY A SECRET, and leaves the old key unnecessary', async () => {
  // THE WHOLE POINT OF THE CHANGE, run end to end as an operator would.
  const world = database()
  let reference = ''
  const value = 'the-microsoft-client-secret'

  // 1. Sealed under the original key, before anyone thinks about rotating.
  await withKeys({ current: KEY_ONE }, async () => {
    reference = await world.service().store('hawkview-microsoft-connector-client-secret', value, PLATFORM_OWNED)
    assert.equal(await world.service().access(reference), value)
  })
  const sealed = [...world.rows.values()][0]
  assert.equal(sealed.keyVersion, 1, 'the first key is version 1')
  const originalCiphertext = Buffer.from(sealed.ciphertext).toString('hex')

  // 2. The rotation window: new key current, old key still available.
  await withKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE }, async () => {
    // Readable. Before this change, this is the step that returned "the stored
    // credential could not be decrypted" and the secret was gone.
    assert.equal(await world.service().access(reference), value)
  })

  // 3. And it was re-sealed on the way through, not merely read.
  const resealed = [...world.rows.values()][0]
  assert.equal(resealed.keyVersion, 2, 'the row should have been re-sealed')
  assert.notEqual(
    Buffer.from(resealed.ciphertext).toString('hex'),
    originalCiphertext,
    'ciphertext must actually change, or nothing was re-sealed')

  // 4. The old key is now unnecessary. This is what makes the rotation finished
  //    rather than merely started.
  await withKeys({ current: KEY_TWO, version: '2' }, async () => {
    assert.equal(await world.service().access(reference), value)
  })
})

test('a row sealed with a key this service does not hold says so, and says nothing was lost', async () => {
  // THE DISTINCTION THAT MAKES A MISTAKE RECOVERABLE. "I do not have that key"
  // has a remedy — put it back. "Could not be decrypted" reads as corruption and
  // sends someone looking for a backup they do not have.
  const world = database()
  let reference = ''
  await withKeys({ current: KEY_ONE }, async () => {
    reference = await world.service().store('a-secret', 'value', PLATFORM_OWNED)
  })

  // Rotated to version 2 with NO previous key configured: the row is still at 1.
  await withKeys({ current: KEY_TWO, version: '2' }, async () => {
    await assert.rejects(
      () => world.service().access(reference),
      (error: any) => {
        const body = error.getResponse()
        assert.equal(body.code, SEALED_WITH_UNAVAILABLE_KEY)
        assert.match(body.message, /version 1/)
        assert.match(body.message, /nothing has been lost/)
        return true
      })
  })

  // POSITIVE CONTROL: supplying the previous key makes the very same row readable
  // again, so the refusal above was about the missing key and not a damaged row.
  await withKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE }, async () => {
    assert.equal(await world.service().access(reference), 'value')
  })
})

test('the wrong key for a version is still reported as a decryption failure', async () => {
  // The two failures must stay distinguishable in both directions. A key that is
  // PRESENT but wrong is not "a key I do not hold" — it is a bad key or a bad
  // row, and it must not claim the reassuring message.
  const world = database()
  let reference = ''
  await withKeys({ current: KEY_ONE }, async () => {
    reference = await world.service().store('a-secret', 'value', PLATFORM_OWNED)
  })

  await withKeys({ current: KEY_THREE }, async () => {
    await assert.rejects(
      () => world.service().access(reference),
      (error: any) => {
        assert.match(String(error.message), /could not be decrypted/)
        return true
      })
  })
})

test('a failed re-seal does not fail the read', async () => {
  // A re-seal is an optimisation of the rotation, never a precondition of the
  // read. If a write failure could refuse a credential, adding rotation would
  // have introduced a new way for collection to stop.
  const world = database()
  let reference = ''
  await withKeys({ current: KEY_ONE }, async () => {
    reference = await world.service().store('a-secret', 'value', PLATFORM_OWNED)
  })

  world.breakWrites()
  await withKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE }, async () => {
    assert.equal(await world.service().access(reference), 'value', 'the read must survive a failed re-seal')
  })
  // Still at the old version, so the previous key is still required — which is
  // exactly what rotationStatus will report.
  assert.equal([...world.rows.values()][0].keyVersion, 1)
})

test('a concurrent re-seal cannot leave a row labelled one version and sealed with another', async () => {
  // Two simultaneous reads of the same stale row both decide to re-seal. The
  // guarded update means the second applies to nothing rather than overwriting
  // the first.
  const world = database()
  let reference = ''
  await withKeys({ current: KEY_ONE }, async () => {
    reference = await world.service().store('a-secret', 'value', PLATFORM_OWNED)
  })

  await withKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE }, async () => {
    const service = world.service()
    const [a, b] = await Promise.all([service.access(reference), service.access(reference)])
    assert.equal(a, 'value')
    assert.equal(b, 'value')
  })

  // And the row is still coherent: readable under the version it claims.
  assert.equal([...world.rows.values()][0].keyVersion, 2)
  await withKeys({ current: KEY_TWO, version: '2' }, async () => {
    assert.equal(await world.service().access(reference), 'value')
  })
})

test('rotation status is measured by opening every secret, not by trusting its label', async () => {
  const world = database()
  await withKeys({ current: KEY_ONE }, async () => {
    await world.service().store('secret-one', 'one', PLATFORM_OWNED)
    await world.service().store('secret-two', 'two', PLATFORM_OWNED)
  })

  // Mid-rotation: both rows still at version 1, previous key available.
  await withKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE }, async () => {
    const status = await world.service().rotationStatus()
    assert.equal(status.currentVersion, 2)
    assert.equal(status.unreadable, 0)
    assert.equal(status.resealPending, 2, 'both rows still need the previous key')
    assert.equal(status.complete, false, 'the old key cannot be removed yet')

    // Reading them re-seals them, which is how a rotation completes.
    await world.service().access('encrypted-secret:' + [...world.rows.values()][0].id)
    await world.service().access('encrypted-secret:' + [...world.rows.values()][1].id)

    const after = await world.service().rotationStatus()
    assert.equal(after.resealPending, 0)
    assert.equal(after.complete, true, 'now the previous key can be removed')
  })

  // POSITIVE CONTROL: with the old key gone and a row still stranded, status says
  // so rather than reporting completion. Prove it by stranding one deliberately.
  ;[...world.rows.values()][0].keyVersion = 1
  await withKeys({ current: KEY_TWO, version: '2' }, async () => {
    const status = await world.service().rotationStatus()
    assert.equal(status.unreadable, 1)
    assert.equal(status.complete, false)
    assert.equal(status.secrets.filter((row) => !row.readable).length, 1)
  })
})

test('status reports names and versions, never the secret', async () => {
  const world = database()
  await withKeys({ current: KEY_ONE }, async () => {
    await world.service().store('secret-one', 'a-value-nobody-should-see', PLATFORM_OWNED)
    const status = await world.service().rotationStatus()
    const serialised = JSON.stringify(status)
    assert.equal(serialised.includes('a-value-nobody-should-see'), false)
    assert.equal(serialised.includes('ciphertext'), false)
    assert.equal(status.secrets[0].name, 'secret-one')
  })
})

test('storing a tenant-owned secret is refused, loudly and with a reason', async () => {
  // The latent gap, made impossible to reach accidentally. encrypted_secrets has
  // no tenant column and access() checks no scope, so the first customer-managed
  // credential would be stored with no boundary at all. This refuses instead.
  const world = database()
  await withKeys({ current: KEY_ONE }, async () => {
    await assert.rejects(
      () => world.service().store('tenant-abc-microsoft-client-secret', 'value', {
        kind: 'TENANT',
        organizationId: 'org-1',
        customerTenantId: 'tenant-1',
      }),
      (error: any) => {
        assert.equal(error.getResponse().code, TENANT_SCOPE_UNSUPPORTED)
        assert.match(error.getResponse().message, /docs\/secret-store\.md/)
        return true
      })

    // Nothing was written. A refusal that still stored the row would be worse
    // than no refusal, because it would also be untrue.
    assert.equal(world.rows.size, 0)

    // POSITIVE CONTROL: a platform-owned secret with the same store, same keys,
    // is stored — so the refusal is about ownership and not a broken writer.
    await world.service().store('hawkview-owned', 'value', PLATFORM_OWNED)
    assert.equal(world.rows.size, 1)
  })
})

test('the onboarding path that has no tenant id yet is refused just the same', async () => {
  // customerTenantId is null there, because the credential is stored before the
  // tenant row exists. That must not read as "not tenant-owned".
  const world = database()
  await withKeys({ current: KEY_ONE }, async () => {
    await assert.rejects(
      () => world.service().store('tenant-abc-microsoft-client-secret', 'value', {
        kind: 'TENANT',
        organizationId: 'org-1',
        customerTenantId: null,
      }),
      (error: any) => error.getResponse().code === TENANT_SCOPE_UNSUPPORTED)
    assert.equal(world.rows.size, 0)
  })
})

test('every new secret records the version that sealed it', async () => {
  const world = database()
  await withKeys({ current: KEY_TWO, version: '2' }, async () => {
    await world.service().store('fresh', 'value', PLATFORM_OWNED)
  })
  assert.equal([...world.rows.values()][0].keyVersion, 2, 'a row written under version 2 must say 2')
})

test('accessOrCreate mints under the current version and re-seals an old one', async () => {
  const world = database()
  await withKeys({ current: KEY_ONE }, async () => {
    assert.equal(await world.service().accessOrCreate('consent-state', () => 'minted'), 'minted')
  })
  assert.equal([...world.rows.values()][0].keyVersion, 1)

  await withKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE }, async () => {
    // Returns the stored value rather than minting a second one...
    assert.equal(await world.service().accessOrCreate('consent-state', () => 'a-different-value'), 'minted')
  })
  // ...and re-seals it on the way.
  assert.equal([...world.rows.values()][0].keyVersion, 2)
})
