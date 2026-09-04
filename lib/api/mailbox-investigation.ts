export type MailboxInvestigation = {
  version: 1
  status: 'AVAILABLE' | 'UNAVAILABLE'
  mailbox: { id: string; label: string; observedAt: string; inventoryPath: string } | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function closed(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
const unavailable = (): MailboxInvestigation => ({ version: 1, status: 'UNAVAILABLE', mailbox: null })
const unsafeUnicode = new RegExp('[\\p{Cc}\\p{Cf}]', 'u')

export function parseInvestigationAccess(value: unknown) {
  return record(value) && closed(value, ['version', 'allowed']) && value.version === 1 && value.allowed === true
}

export function parseMailboxInvestigation(value: unknown, tenantId: string, now = new Date()): MailboxInvestigation {
  if (!record(value) || !closed(value, ['version', 'status', 'mailbox']) || value.version !== 1) return unavailable()
  if (value.status === 'UNAVAILABLE' && value.mailbox === null) return unavailable()
  const mailbox = value.mailbox
  if (value.status !== 'AVAILABLE' || !record(mailbox) ||
    !closed(mailbox, ['id', 'label', 'observedAt', 'inventoryPath']) ||
    typeof mailbox.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(mailbox.id) ||
    typeof mailbox.label !== 'string' || mailbox.label.trim() !== mailbox.label || !mailbox.label || mailbox.label.length > 160 ||
    (unsafeUnicode.test(mailbox.label) || /[<>\[\]{}\\]/.test(mailbox.label)) ||
    mailbox.inventoryPath !== `/tenants/${encodeURIComponent(tenantId)}/exchange` ||
    typeof mailbox.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(mailbox.observedAt)) return unavailable()
  const timestamp = Date.parse(mailbox.observedAt)
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > 36 * 60 * 60 * 1000) return unavailable()
  return { version: 1, status: 'AVAILABLE', mailbox: { id: mailbox.id, label: mailbox.label, observedAt: new Date(timestamp).toISOString(), inventoryPath: mailbox.inventoryPath } }
}
