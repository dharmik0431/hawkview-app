import process from 'node:process'
import {
  HAWKVIEW_AUTH_EMAIL_DELIVERY_POLICY,
  HAWKVIEW_AUTH_EMAIL_MAX_HTML_BYTES,
  HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS,
  HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH,
} from '../supabase/email-templates/hawkview-auth-email-templates.mjs'

for (const [key, value] of Object.entries(HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH)) {
  if (!key.endsWith('_content')) continue
  if (Buffer.byteLength(value) > HAWKVIEW_AUTH_EMAIL_MAX_HTML_BYTES) {
    throw new Error(`Managed authentication email ${key} exceeds the safe HTML size limit.`)
  }
  if (/ConfirmationURL|supabase\.co/i.test(value)) {
    throw new Error(`Managed authentication email ${key} contains a provider-hosted action URL.`)
  }
}

const API_ORIGIN = 'https://api.supabase.com'
const args = new Set(process.argv.slice(2))
const check = args.has('--check')
const apply = args.has('--apply')

if (check === apply) {
  throw new Error('Choose exactly one mode: --check or --apply.')
}

const projectRef = process.env.SUPABASE_PROJECT_REF?.trim()
const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim()
if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) {
  throw new Error('SUPABASE_PROJECT_REF must be the exact 20-character project reference.')
}
if (!accessToken) {
  throw new Error('SUPABASE_ACCESS_TOKEN is required and must never be committed.')
}
if (apply && process.env.SUPABASE_TEMPLATE_APPLY_CONFIRM?.trim() !== projectRef) {
  throw new Error('Set SUPABASE_TEMPLATE_APPLY_CONFIRM to the exact project reference before --apply.')
}

const endpoint = `${API_ORIGIN}/v1/projects/${projectRef}/config/auth`
const headers = {
  Accept: 'application/json',
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
}

async function readConfig() {
  const response = await fetch(endpoint, { method: 'GET', headers })
  if (!response.ok) {
    throw new Error(`Supabase auth configuration read failed with HTTP ${response.status}.`)
  }
  return response.json()
}

function drift(current) {
  return HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS.filter(
    (key) => current?.[key] !== HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[key],
  )
}

function deliveryDrift(current) {
  const expected = {
    smtp_admin_email: HAWKVIEW_AUTH_EMAIL_DELIVERY_POLICY.senderEmail,
    smtp_sender_name: HAWKVIEW_AUTH_EMAIL_DELIVERY_POLICY.senderName,
  }
  return Object.entries(expected)
    .filter(([key, value]) => current?.[key] !== value)
    .map(([key]) => key)
}

const before = await readConfig()
const changedKeys = drift(before)
const changedDeliveryKeys = deliveryDrift(before)
if (changedKeys.length === 0 && changedDeliveryKeys.length === 0) {
  console.log(`HawkView auth email templates and sender identity are current for project ${projectRef}.`)
  process.exit(0)
}

if (check) {
  if (changedKeys.length > 0) {
    console.error(`HawkView auth email template drift detected (${changedKeys.length} fields):`)
    for (const key of changedKeys) console.error(`- ${key}`)
  }
  if (changedDeliveryKeys.length > 0) {
    console.error('HawkView auth sender identity requires a controlled provider rollout:')
    for (const key of changedDeliveryKeys) console.error(`- ${key}`)
  }
  process.exit(1)
}

if (changedKeys.length > 0) {
  const patch = Object.fromEntries(
    changedKeys.map((key) => [key, HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[key]]),
  )
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    throw new Error(`Supabase auth template update failed with HTTP ${response.status}.`)
  }
}

const after = await readConfig()
const remaining = drift(after)
if (remaining.length > 0) {
  throw new Error(`Supabase accepted the update but ${remaining.length} managed fields still differ.`)
}

const remainingDelivery = deliveryDrift(after)
if (remainingDelivery.length > 0) {
  throw new Error(
    'Templates were verified, but the dedicated authentication sender still requires a controlled Supabase/Resend rollout.',
  )
}

console.log(`Applied and verified ${changedKeys.length} HawkView auth email template fields for project ${projectRef}.`)
