import assert from 'node:assert/strict'
import test from 'node:test'
import { IMMUTABLE_MANAGED_SECRET_PREFIX } from '../microsoft/managed-connector-authority.js'
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
      createMany: async ({ data }: { data: Omit<Row, 'id'> }) => {
        if (updateFails) throw new Error('write unavailable')
        if ([...rows.values()].some((row) => row.name === data.name)) return { count: 0 }
        const row = { id: randomUUID(), ...data }
        rows.set(row.id, row)
        return { count: 1 }
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
        if (typeof where.id === 'string') {
          const row = rows.get(where.id)
          const excluded = (where.NOT as { name?: { startsWith?: string } } | undefined)?.name?.startsWith
          if (row && !(excluded && row.name.startsWith(excluded))) rows.delete(where.id)
        }
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


test('immutable namespace refuses generic creation and overwrite, retains deletion tombstones', async () => {
  await withKeys({ current: KEY_ONE }, async () => {
    const db = database(), service = db.service()
    const name = IMMUTABLE_MANAGED_SECRET_PREFIX + randomUUID()
    await assert.rejects(service.store(name, 'synthetic', PLATFORM_OWNED), /MANAGED_CREDENTIAL_REQUIRES_IMMUTABLE_PUBLICATION/)
    await assert.rejects(service.accessOrCreate(name, () => 'synthetic'), /MANAGED_CREDENTIAL_REQUIRES_IMMUTABLE_PUBLICATION/)
    assert.equal(db.rows.size, 0)
    const ordinary = await service.store('ordinary-platform-name', 'unchanged', PLATFORM_OWNED)
    const row = [...db.rows.values()][0]
    row.name = name
    const before = Buffer.from(row.ciphertext)
    await assert.rejects(service.store(name, 'replacement', PLATFORM_OWNED), /MANAGED_CREDENTIAL_REQUIRES_IMMUTABLE_PUBLICATION/)
    await service.delete(ordinary)
    assert.equal(db.rows.size, 1)
    assert.deepEqual(Buffer.from(row.ciphertext), before)
    row.name = 'ordinary-platform-name'
    await service.delete(ordinary)
    assert.equal(db.rows.size, 0)
  })
})

test('managed preparation writes nothing, uses canonical revision AAD and yields a readable immutable reference', async () => {
  await withKeys({ current: KEY_ONE }, async () => {
    const db = database(), service = db.service(), revision = randomUUID()
    const sealed = service.prepareManagedRevision(revision.toUpperCase(), 'synthetic-managed-value')
    assert.equal(db.rows.size, 0)
    db.rows.set(revision, { id: revision, name: IMMUTABLE_MANAGED_SECRET_PREFIX + revision, ...sealed })
    assert.equal(await service.access('encrypted-secret:' + revision), 'synthetic-managed-value')
    const swapped = randomUUID()
    db.rows.set(swapped, { id: swapped, name: IMMUTABLE_MANAGED_SECRET_PREFIX + swapped, ...sealed })
    await assert.rejects(service.access('encrypted-secret:' + swapped))
    await assert.rejects(service.store(IMMUTABLE_MANAGED_SECRET_PREFIX + revision, 'replacement', PLATFORM_OWNED),
      /MANAGED_CREDENTIAL_REQUIRES_IMMUTABLE_PUBLICATION/)
    assert.equal(await service.access('encrypted-secret:' + revision), 'synthetic-managed-value')
  })
})
test('managed preparation rejects bad identity, empty content and UTF8 overflow without persistence', async () => {
  await withKeys({ current: KEY_ONE }, async () => {
    const db = database(), service = db.service()
    assert.throws(() => service.prepareManagedRevision('not-a-revision', 'synthetic'), /INVALID_MANAGED_AUTHORITY_ID/)
    for (const value of ['', 'é'.repeat(32769)]) {
      assert.throws(() => service.prepareManagedRevision(randomUUID(), value), /INVALID_MANAGED_CREDENTIAL/)
    }
    assert.equal(service.prepareManagedRevision(randomUUID(), 'é'.repeat(32768)).ciphertext.length, 65536)
    assert.equal(db.rows.size, 0)
  })
})


test('concurrent first use returns one persisted winner to every caller', async () => {
  await withKeys({ current: KEY_ONE }, async () => {
    const world = database()
    const values = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      world.service().accessOrCreate('first-use', () => `synthetic-${index}`)))
    assert.equal(new Set(values).size, 1)
    assert.equal(world.rows.size, 1)
    const row = [...world.rows.values()][0]
    assert.equal(await world.service().access(`encrypted-secret:${row.id}`), values[0])
    assert.equal(await world.service().accessOrCreate('first-use', () => {
      assert.fail('existing value must not invoke the factory')
    }), values[0])
    assert.equal(await world.service().accessOrCreate('other-name', () => 'independent'), 'independent')
  })
})

test('first-use storage failure never returns an unpersisted value', async () => {
  await withKeys({ current: KEY_ONE }, async () => {
    const world = database()
    world.breakWrites()
    await assert.rejects(world.service().accessOrCreate('first-use', () => 'synthetic'), /write unavailable/)
    assert.equal(world.rows.size, 0)
  })
})

test('first-use missing winner fails closed instead of returning a generated value', async () => {
  await withKeys({ current: KEY_ONE }, async () => {
    const world = database()
    world.prisma.encryptedSecret.createMany = async () => ({ count: 0 })
    await assert.rejects(world.service().accessOrCreate('first-use', () => 'synthetic'),
      /stored.*unavailable/i)
    assert.equal(world.rows.size, 0)
  })
})
