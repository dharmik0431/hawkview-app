// QA — M8 and M9 have no runtime variant, and that is the point.
//
// A leak searched for is a leak you can spell wrong. These are the two properties where the
// strong form is available: the body has nowhere to put an identity, and the send path has
// nowhere to put a tenant. Every negative is an @ts-expect-error, and an unused directive
// fails the build — so this file type-checking IS the evidence.
import type { DeliveryJob, MailSeam, MessageBody } from './qa-step-06-contract.js'
import type { Recipient, VerifiedRecipient } from './routing-policy.js'

const TO: VerifiedRecipient = { kind: 'MSP_SECURITY_INBOX', address: 'soc@msp.example', verifiedAt: new Date(0) }

// ── M8. THE BODY CANNOT CARRY AN IDENTITY ───────────────────────────────────
export const permittedBody: MessageBody = {
  alertTypeId: 'security.privileged_directory_change', tier: 'PHONE',
  affectedTenantCount: 3, deepLinkPath: '/alerts/incident/abc',
}

// @ts-expect-error there is no field for an account name
export const noAccountName: MessageBody = { ...permittedBody, accountName: 'alice@customer.example' }
// @ts-expect-error there is no field for an address
export const noAddress: MessageBody = { ...permittedBody, subjectAddress: 'alice@customer.example' }
// @ts-expect-error there is no field naming which tenants, only how many
export const noTenantNames: MessageBody = { ...permittedBody, tenants: ['Contoso', 'Fabrikam'] }
// @ts-expect-error and no free text, which is where a name would arrive by accident
export const noFreeText: MessageBody = { ...permittedBody, summary: 'alice@customer.example was locked out' }

// THE COUNT IS A NUMBER, so it cannot smuggle a name through the one field that is open.
export const countIsANumber: number = permittedBody.affectedTenantCount

// ── M9. NO TENANT ON THE SEND PATH ──────────────────────────────────────────
export const permittedJob: DeliveryJob = {
  jobId: 'job-1', idempotencyKey: 'key-1', organizationId: 'org-1', to: TO, body: permittedBody,
}
// @ts-expect-error a job addressed to a tenant is what makes a per-tenant loop natural
export const noTenantOnTheJob: DeliveryJob = { ...permittedJob, customerTenantId: 'ten-1' }

// And the seam itself takes jobs and ticks, with nothing tenant-shaped to iterate.
export const seamTakesNoTenant = (seam: MailSeam) => seam({
  jobs: [permittedJob], ticks: [], maxAttempts: 3, confirmWithinMs: 3600_000,
})

// ── AND THE RECIPIENT SURVIVES THE SEAM AS A TYPE ───────────────────────────
// @ts-expect-error a bare address is not a recipient — the kind is not optional
export const bareAddressIsNotARecipient: DeliveryJob = { ...permittedJob, to: 'soc@msp.example' }

const unverified: Recipient = { kind: 'NONE_VERIFIED', because: 'no verified inbox configured' }
// @ts-expect-error an unverified recipient cannot be posted to — DeliveryJob takes a VERIFIED one
export const cannotSendToAnUnverifiedRecipient: DeliveryJob = { ...permittedJob, to: unverified }

// A customer's end user was never a member of Recipient upstream, and nothing here widens it.
export const customerEndUserStillHasNoConstructor: VerifiedRecipient = {
  // @ts-expect-error still not an expressible recipient, one step later
  kind: 'CUSTOMER_END_USER', address: 'someone@customer.example', verifiedAt: new Date(0),
}

console.log(JSON.stringify({
  QA_STEP_06_TYPES: {
    M8: 'the body has no field for a name, an address, a tenant name, or free text — a leak '
      + 'has no constructor rather than failing a search for the spelling I guessed',
    M9: 'no tenant on the job or the seam, so a per-tenant loop has nothing to iterate',
    recipient: 'a bare address, an unverified recipient and a customer end user are all '
      + 'compile errors — the upstream type survives the seam',
    evidence: 'this file type-checking at all, with every negative an @ts-expect-error that '
      + 'would fail the build if it went unused',
  },
}, null, 2))
