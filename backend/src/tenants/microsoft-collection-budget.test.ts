import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MicrosoftCollectionBudget,
  readBoundedResponseText,
  type EntraCollectionLimits,
} from './microsoft-collection-budget.js'
import * as service from './tenant-sync.service.js'
import type { EntraCollectionLimits as ServiceEntraCollectionLimits } from './tenant-sync.service.js'

test('existing service exports retain the reusable budget and reader identities', () => {
  assert.equal(service.MicrosoftCollectionBudget, MicrosoftCollectionBudget)
  assert.equal(service.readBoundedResponseText, readBoundedResponseText)
  assert.equal('cancelBoundedStream' in service, false)
  const limits: Readonly<EntraCollectionLimits> = service.ENTRA_COLLECTION_LIMITS
  const compatibleLimits: Readonly<ServiceEntraCollectionLimits> = limits
  assert.equal(compatibleLimits, service.ENTRA_COLLECTION_LIMITS)
})
