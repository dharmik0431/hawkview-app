const BRAND = Object.freeze({
  name: 'HawkView',
  blue: '#2563eb',
  navy: '#0f172a',
  muted: '#64748b',
  border: '#dbe4f0',
  surface: '#f8fafc',
})

const BRAND_MARK_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAFxGAABcRgEUlENBAAADS0lEQVRYhcWXaUhUYRSG739jrpX6zZQo5RJzR2dIf6ijjbZBG2WlopFJViqVRmSQWamjQSvRotlGqYlilmmIVpDWjzZxrQxpQUslw8yccmzUeeO76HXKaXPGmRcOXL4f532+c8693MMwBrIhcgeWcBkiIq0XOUi/soSDOYLmEhGujiVcOvVgjIkVc6EiwvWZy/S3MNRDzIWMM2cJp59sc4PQCxA2RO5giZsbqcSXKWJXe4b23NLmYyFVMyIibbAWAB1MCqCxIkAfY3jg5jEPu5MyEBufBMksb4tAMMYO4+KT0Nr2HvmFJQhcHGp5AJZwcJUFoLikHFSPn9YjOjYRdo5yCwGIPYTn9dEJ6O3t40Het3diR2IKps3wnFwAZ1UiFFuq4KRMgK1EAS+/pWhsasaomp69xNqImMkDsJ3pBd/kLvir++GztxNuK09B4jYfZy/kQa/XCyAVd6oxRxE0OTPgsuQQ/PZ38xA0/FI+QxqWh6jtB6HVagWI7k892Bizy/wALOEw1dEbTgE7odh8D/5p3wQQVWwx3rR1wVC5+cUTmg3mjwASD1Terca+tKPwDIyCbF0RlKkaHkSZ3IUzpW0YawhwteAGbMUy8wGwhMOhY1l8cp1uEAVFpQhYHgf5prtCa8KOdeJd9xjGidMXzQswW+qPS1cKoR0Y4A2Gh4d5EO8VSfDZ085DqNRfUF4/KEDcvHUbyvnBfDWc3X1BnOZOHIAdCXdPFU5nXeYrQaXRfEWy+iQU0RVCNVKu90Orwzh91+lQeK0M02d6ThyAHQm/oGDUNTwXklc/eATfsMNQHuiBSt2HutZh/E7hG7aZDsASDvaOCtTUNgqJuz52I3JrBu7VdBg1plWjHy4XLsB0AN/AVXhSU/+Twes3rejo/GDU/EVzCxYvX2f6DBCnuTh6IluYAaqhoSFknsvB8ZPncTm3SIjM7Bwkpx7BomURf30tmX8xX7IyEi2v3v50s6r7D+G/YPV/t++/AUIiYnGjtAIlZZV80Fdw4dJwk40FAJEV/ogN/4wZugVZEaCOtiDdWgAskaZZczHpnSJxtxtdzUIsvprZy9b8uh+G0KGwxM3HmY+K7mp0XRI5cLXmXFhoLpqT9lwo+4h+ANpAWRNicIUuAAAAAElFTkSuQmCC'

function paragraph(value) {
  return `<p style="margin:0 0 16px;color:${BRAND.navy};font-size:16px;line-height:24px;">${value}</p>`
}

function brandedEmail({ preheader, title, paragraphs, action, code, security = false }) {
  const body = paragraphs.map(paragraph).join('')
  const actionMarkup = action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 20px;"><tr><td style="border-radius:10px;background:${BRAND.blue};"><a href="${action.href}" style="display:inline-block;padding:13px 20px;color:#ffffff;font-size:16px;font-weight:700;line-height:20px;text-decoration:none;border-radius:10px;">${action.label}</a></td></tr></table>`
    : ''
  const codeMarkup = code
    ? `<div style="margin:24px 0;padding:18px;border:1px solid ${BRAND.border};border-radius:10px;background:${BRAND.surface};color:${BRAND.navy};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;">${code}</div>`
    : ''
  const notice = security
    ? `<div style="margin-top:24px;padding:14px 16px;border-left:4px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:14px;line-height:21px;">If you did not make this change, reset your password and contact your HawkView administrator immediately.</div>`
    : `<p style="margin:24px 0 0;color:${BRAND.muted};font-size:13px;line-height:20px;">If you did not request this email, you can safely ignore it.</p>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#eef2f7;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:16px;">
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid ${BRAND.border};">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
                <td style="width:38px;height:38px;vertical-align:middle;"><img src="${BRAND_MARK_DATA_URI}" width="38" height="38" alt="" style="display:block;width:38px;height:38px;border:0;border-radius:9px;"></td>
                <td style="padding-left:12px;color:${BRAND.navy};font-size:20px;font-weight:800;">${BRAND.name}</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 32px 32px;">
              <h1 style="margin:0 0 18px;color:${BRAND.navy};font-size:26px;line-height:34px;">${title}</h1>
              ${body}
              ${codeMarkup}
              ${actionMarkup}
              ${notice}
            </td>
          </tr>
        </table>
        <p style="margin:18px 0 0;color:${BRAND.muted};font-size:12px;line-height:18px;">HawkView account email</p>
      </td>
    </tr>
  </table>
</body>
</html>`
}

const confirmationUrl = '{{ .ConfirmationURL }}'
const token = '{{ .Token }}'

const templates = {
  confirmation: {
    subject: 'Confirm your HawkView email',
    content: brandedEmail({
      preheader: 'Confirm your email address to finish creating your HawkView account.',
      title: 'Confirm your email address',
      paragraphs: ['Use the button below to verify your email address and finish creating your HawkView account.'],
      action: { href: confirmationUrl, label: 'Confirm email address' },
    }),
  },
  invite: {
    subject: 'You are invited to HawkView',
    content: brandedEmail({
      preheader: 'Accept your invitation to join a HawkView workspace.',
      title: 'You have been invited',
      paragraphs: ['A HawkView workspace administrator invited you to join their team. Use the button below to accept the invitation and finish account setup.'],
      action: { href: confirmationUrl, label: 'Accept invitation' },
    }),
  },
  recovery: {
    subject: 'Reset your HawkView password',
    content: brandedEmail({
      preheader: 'Use this secure link to reset your HawkView password.',
      title: 'Reset your password',
      paragraphs: ['We received a request to reset the password for your HawkView account. Use the button below to choose a new password.'],
      action: { href: confirmationUrl, label: 'Reset password' },
    }),
  },
  magic_link: {
    subject: 'Your HawkView sign-in link',
    content: brandedEmail({
      preheader: 'Use this one-time link to sign in to HawkView.',
      title: 'Sign in to HawkView',
      paragraphs: ['Use the button below to securely sign in. This link is intended only for you and expires shortly.'],
      action: { href: confirmationUrl, label: 'Sign in to HawkView' },
    }),
  },
  reauthentication: {
    subject: '{{ .Token }} is your HawkView verification code',
    content: brandedEmail({
      preheader: 'Use this one-time verification code to confirm your identity.',
      title: 'Confirm your identity',
      paragraphs: ['Enter this one-time code in HawkView to continue. Do not share this code with anyone.'],
      code: token,
    }),
  },
  email_change: {
    subject: 'Confirm your new HawkView email',
    content: brandedEmail({
      preheader: 'Confirm the requested email-address change for your HawkView account.',
      title: 'Confirm your new email address',
      paragraphs: ['Use the button below to confirm the requested email-address change for your HawkView account.'],
      action: { href: confirmationUrl, label: 'Confirm new email address' },
    }),
  },
  password_changed_notification: {
    subject: 'Your HawkView password was changed',
    content: brandedEmail({
      preheader: 'The password for your HawkView account was changed.',
      title: 'Password changed',
      paragraphs: ['The password for your HawkView account was recently changed.'],
      security: true,
    }),
  },
  email_changed_notification: {
    subject: 'Your HawkView email was changed',
    content: brandedEmail({
      preheader: 'The email address for your HawkView account was changed.',
      title: 'Email address changed',
      paragraphs: ['The email address used to sign in to your HawkView account was recently changed.'],
      security: true,
    }),
  },
  phone_changed_notification: {
    subject: 'Your HawkView phone number was changed',
    content: brandedEmail({
      preheader: 'The phone number for your HawkView account was changed.',
      title: 'Phone number changed',
      paragraphs: ['The phone number associated with your HawkView account was recently changed.'],
      security: true,
    }),
  },
  mfa_factor_enrolled_notification: {
    subject: 'A HawkView verification method was added',
    content: brandedEmail({
      preheader: 'A new verification method was added to your HawkView account.',
      title: 'Verification method added',
      paragraphs: ['A new multi-factor verification method was recently added to your HawkView account.'],
      security: true,
    }),
  },
  mfa_factor_unenrolled_notification: {
    subject: 'A HawkView verification method was removed',
    content: brandedEmail({
      preheader: 'A verification method was removed from your HawkView account.',
      title: 'Verification method removed',
      paragraphs: ['A multi-factor verification method was recently removed from your HawkView account.'],
      security: true,
    }),
  },
  identity_linked_notification: {
    subject: 'A HawkView sign-in method was linked',
    content: brandedEmail({
      preheader: 'A new sign-in method was linked to your HawkView account.',
      title: 'Sign-in method linked',
      paragraphs: ['A new sign-in method was recently linked to your HawkView account.'],
      security: true,
    }),
  },
  identity_unlinked_notification: {
    subject: 'A HawkView sign-in method was removed',
    content: brandedEmail({
      preheader: 'A sign-in method was removed from your HawkView account.',
      title: 'Sign-in method removed',
      paragraphs: ['A sign-in method was recently removed from your HawkView account.'],
      security: true,
    }),
  },
}

export const HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH = Object.freeze(
  Object.fromEntries(
    Object.entries(templates).flatMap(([key, value]) => [
      [`mailer_subjects_${key}`, value.subject],
      [`mailer_templates_${key}_content`, value.content],
    ]),
  ),
)

export const HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS = Object.freeze(
  Object.keys(HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH),
)
