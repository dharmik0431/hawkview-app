import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCheckSettings } from './security-requirements-settings.js'

test('MSP inputs are normalized without broadening their approved sets', () => {
  const selected = [
    'sharepoint-approved-partner-domains-v1',
    'onedrive-sync-approved-domain-guids-v1',
    'onedrive-deleted-user-retention-minimum-v1',
    'm365-required-verified-domains-v1',
  ]
  assert.deepEqual(parseCheckSettings({
    'sharepoint-approved-partner-domains-v1': { approvedDomains: ['Partner.EXAMPLE.', 'other.example'] },
    'onedrive-sync-approved-domain-guids-v1': { approvedDomainGuids: ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'] },
    'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 180 },
    'm365-required-verified-domains-v1': { requiredDomains: ['Brand.Example.'] },
  }, selected), {
    'sharepoint-approved-partner-domains-v1': { approvedDomains: ['other.example', 'partner.example'] },
    'onedrive-sync-approved-domain-guids-v1': { approvedDomainGuids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
    'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 180 },
    'm365-required-verified-domains-v1': { requiredDomains: ['brand.example'] },
  })
})

test('missing, malformed, duplicate and unselected choices are rejected', () => {
  const partner = ['sharepoint-approved-partner-domains-v1']
  assert.throws(() => parseCheckSettings({}, partner))
  assert.throws(() => parseCheckSettings({ 'sharepoint-approved-partner-domains-v1': { approvedDomains: ['*.example.com'] } }, partner))
  assert.throws(() => parseCheckSettings({ 'sharepoint-approved-partner-domains-v1': { approvedDomains: ['Example.com', 'example.com'] } }, partner))
  assert.throws(() => parseCheckSettings({ 'sharepoint-approved-partner-domains-v1': { approvedDomains: ['example.com'] } }, []))
  assert.throws(() => parseCheckSettings({ 'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 29 } }, ['onedrive-deleted-user-retention-minimum-v1']))
  assert.throws(() => parseCheckSettings({ 'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 3651 } }, ['onedrive-deleted-user-retention-minimum-v1']))
  assert.throws(() => parseCheckSettings({ 'onedrive-sync-approved-domain-guids-v1': { approvedDomainGuids: ['not-a-guid'] } }, ['onedrive-sync-approved-domain-guids-v1']))
  assert.throws(() => parseCheckSettings({ 'm365-required-verified-domains-v1': { requiredDomains: ['*.example.com'] } }, ['m365-required-verified-domains-v1']))
})
