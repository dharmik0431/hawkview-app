// QA PROBE. Does AuthenticEvent actually have only one constructor, as the comment claims?
import { providerMessageId, type AuthenticEvent } from './email-delivery.js'

// Forged: never passed through `authenticate`, no signature verdict anywhere.
export const forged: AuthenticEvent = {
  providerId: providerMessageId('resend-forged-1'),
  kind: 'DELIVERED',
  atIso: '2026-09-12T00:00:00.000Z',
  bounce: null,
  __authentic: true,
}
