import { type Body } from './email-delivery.js'
import {
  ALERT_EMAIL_TEMPLATE_VERSION, ALERT_EMAIL_LOGO_URL, alertEmailPlaintext, buildAlertEmailContent,
  escapeAlertEmailHtml as escape,
  type AlertEmailContent,
} from './email-alert-content.js'
import { type EmailIncidentContext } from './email-incident-context.js'

/** Called only to create a NEW frozen payload. Existing envelope bytes must never be re-rendered. */
export function renderAlertEmail(body: Body, mode: 'live' | 'historical-test' = 'live', incidentContext?: EmailIncidentContext, compactValueLimit = 160) {
  const content = buildAlertEmailContent(body, { mode, incidentContext })
  if (content.compact) return renderCompactAlertEmail(content, compactValueLimit)
  const paragraph = (value: string) => `<p style="margin:0;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;">${escape(value)}</p>`
  const facts = content.facts.map(fact => `<p style="margin:8px 0 0;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#0f172a;">${escape(fact.label)}:</strong> ${escape(fact.value)}</p>`).join('')
  const steps = content.steps.map((step, index) => `<p style="margin:0 0 10px;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#1d4ed8;">${index + 1}.</strong> ${escape(step)}</p>`).join('')
  const detailFacts = (items: readonly { label: string; value: string }[]) => items.map(fact =>
    `<p style="margin:8px 0;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;"><strong>${escape(fact.label)}:</strong> ${escape(fact.value)}</p>`).join('')
  const details = content.incidentContext ? `<tr><td style="padding:18px 20px 0;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 8px;font-size:18px;line-height:25px;color:#0f172a;">Incident details</h2>${detailFacts(content.incidentContext.facts)}${content.incidentContext.findings.map(finding => `<div style="margin-top:14px;padding:14px;background-color:#f8fafc;border:1px solid #dbe4f0;border-radius:8px;"><h3 style="margin:0;font-size:16px;line-height:24px;color:#0f172a;">${escape(finding.title)}</h3>${detailFacts(finding.facts)}${finding.events.map(event => `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #cbd5e1;"><h4 style="margin:0;font-size:14px;line-height:22px;color:#1e3a8a;">${escape(event.title)}</h4>${detailFacts(event.facts)}</div>`).join('')}</div>`).join('')}${content.incidentContext.omittedFindings ? paragraph(`${content.incidentContext.omittedFindings} additional finding snapshots for this incident are not shown.`) : ''}<div style="margin-top:12px;">${paragraph(content.incidentContext.note)}</div></td></tr>` : ''
  const html = `<!doctype html>
<html lang="en" dir="ltr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(content.subject)}</title></head>
<body lang="en" dir="ltr" style="margin:0;padding:0;background-color:#f1f5f9;color:#0f172a;font-family:'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%;">
<!-- Template: ${ALERT_EMAIL_TEMPLATE_VERSION}. The serialized envelope, not this version label, is retry authority. -->
<div lang="en" dir="ltr" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escape(content.eyebrow)}: Review the recorded security evidence in HawkView.</div>
<table lang="en" dir="ltr" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#f1f5f9;">
<tr><td align="center" style="padding:20px 8px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;box-sizing:border-box;table-layout:fixed;background-color:#ffffff;border:1px solid #dbe4f0;border-radius:12px;">
<tr><td style="height:4px;background-color:#2563eb;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:18px 20px;background-color:#0f172a;overflow-wrap:anywhere;word-break:break-word;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="46" height="46" align="center" bgcolor="#ffffff" style="width:46px;height:46px;background-color:#ffffff;border:1px solid #cbd5e1;border-radius:8px;"><img src="${ALERT_EMAIL_LOGO_URL}" width="36" height="36" alt="HawkView logo" style="display:block;width:36px;height:36px;border:0;background-color:#ffffff;"></td><td style="padding-left:12px;"><div style="font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.4px;color:#ffffff;">HawkView</div></td></tr></table><div style="margin-top:8px;font-size:12px;line-height:20px;font-weight:600;letter-spacing:1px;color:#cbd5e1;">${escape(content.eyebrow)}</div></td></tr>
${content.notice ? `<tr><td style="padding:12px 20px;background-color:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:14px;line-height:22px;color:#1e3a8a;overflow-wrap:anywhere;word-break:break-word;"><strong>${escape(content.notice)}</strong></td></tr>` : ''}
<tr><td style="padding:20px 20px 14px;overflow-wrap:anywhere;word-break:break-word;"><h1 style="margin:0 0 10px;font-size:26px;line-height:33px;font-weight:700;letter-spacing:-0.4px;color:#0f172a;">${escape(content.headline)}</h1>${paragraph(content.intro)}</td></tr>
${details}
<tr><td style="padding:0 20px;"><div style="padding:14px;background-color:#f8fbff;border:1px solid #bfdbfe;border-left:4px solid #2563eb;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 8px;font-size:16px;line-height:23px;color:#1e3a8a;">Why it matters</h2>${paragraph(content.why)}</div></td></tr>
${content.incidentContext ? '' : `<tr><td style="padding:18px 20px 0;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 8px;font-size:16px;line-height:23px;color:#0f172a;">Alert scope</h2><p style="margin:0;font-size:19px;line-height:27px;font-weight:700;color:#0f172a;">${escape(content.summary)}</p>${facts}<p style="margin:8px 0 0;font-size:12px;line-height:20px;color:#475569;">${escape(content.priorityNote)}</p></td></tr>`}
<tr><td style="padding:16px 20px 0;overflow-wrap:anywhere;word-break:break-word;"><a href="${escape(content.actionUrl)}" style="display:block;box-sizing:border-box;max-width:100%;padding:13px 14px;border:1px solid #2563eb;border-radius:8px;background-color:#2563eb;font-size:15px;line-height:22px;font-weight:700;color:#ffffff;text-align:center;text-decoration:none;overflow-wrap:anywhere;word-break:break-word;">${escape(content.actionLabel)}</a><p style="margin:10px 0 0;font-size:12px;line-height:20px;color:#475569;">${escape(content.authorizationNote)}</p></td></tr>
<tr><td style="padding:18px 20px 8px;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 10px;font-size:16px;line-height:23px;color:#0f172a;">Investigation next steps</h2>${steps}</td></tr>
<tr><td style="padding:16px 20px;background-color:#f8fafc;border-top:1px solid #e2e8f0;overflow-wrap:anywhere;word-break:break-word;">${paragraph(content.source)}${content.previewNote ? `<div style="margin-top:10px;">${paragraph(content.previewNote)}</div>` : ''}</td></tr>
</table></td></tr></table></body></html>`
  const text = alertEmailPlaintext(content)
  if (Buffer.byteLength(html, 'utf8') + Buffer.byteLength(text, 'utf8') > 90_000) throw new Error('EMAIL_CONTENT_UNAVAILABLE')
  return { subject: content.subject, text, html }
}

/** Compact markup keeps the full provider envelope within the existing storage budget. */
function renderCompactAlertEmail(original: AlertEmailContent, valueLimit: number) {
  const bounded = new Set(['Tenant', 'Domain', 'Affected user', 'Email', 'Application', 'Resource'])
  const compact = { ...original.compact!, facts: original.compact!.facts.map(fact => {
    const points = Array.from(fact.value)
    return bounded.has(fact.label) && points.length > valueLimit
      ? { ...fact, value: points.slice(0, valueLimit).join('') + ' [truncated]' } : fact
  }) }
  const content = { ...original, compact }
  const rows = compact.facts.map(fact => `<tr><td width="34%" valign="top" style="padding:8px 10px 8px 0;color:#475569">${escape(fact.label)}</td><td valign="top" style="padding:8px 0">${escape(fact.value)}</td></tr>`).join('')
  const html = `<!doctype html>
<html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(content.subject)}</title></head>
<body style="margin:0;background:#edf3f9;color:#0f172a;font:14px/1.5 'Segoe UI',Arial,sans-serif">
<div lang="en" dir="ltr" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escape(content.eyebrow)}: Review recorded security activity in HawkView.</div>
<table lang="en" dir="ltr" role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;box-sizing:border-box;table-layout:fixed;background:#fff;border:1px solid #dbe4f0;border-top:4px solid #2563eb;border-radius:12px;overflow-wrap:anywhere;word-break:break-word">
<tr><td style="padding:18px 20px;border-bottom:1px solid #dbe4f0"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td width="46" height="46" align="center" bgcolor="#ffffff" style="border:1px solid #dbe4f0;border-radius:8px"><img src="${ALERT_EMAIL_LOGO_URL}" width="36" height="36" alt="HawkView logo" style="display:block;border:0"></td><td style="padding-left:10px"><strong style="font-size:22px">HawkView</strong><div style="font-size:10px;color:#1d4ed8">${escape(content.eyebrow)}</div></td></tr></table></td></tr>
<tr><td style="padding:20px"><h1 style="margin:0 0 8px;font-size:25px;line-height:1.3">${escape(compact.headline)}</h1><p style="margin:0;color:#475569">${escape(compact.intro)}</p>${content.notice ? `<p>${escape(content.notice)}</p>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;table-layout:fixed;font-size:14px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word">${rows}</table>
<p style="font-size:12px;color:#475569">${escape(compact.qualification)}</p>
<div style="padding:12px;border-left:3px solid #2563eb;background:#f7fbff"><h2 style="margin:0 0 4px;font-size:14px;color:#1e3a8a">Recommended action</h2><p style="margin:0">${escape(compact.action)}</p></div>
<p><a href="${escape(content.actionUrl)}" style="display:block;padding:12px;background:#2563eb;border-radius:8px;color:#fff;text-align:center;text-decoration:none;font-weight:bold">${escape(content.notice ? content.actionLabel : 'View in HawkView')}</a></p>
<p style="margin:0;font-size:12px;color:#475569">Sign-in and current workspace authorization are required.</p>${content.previewNote ? `<p>${escape(content.previewNote)}</p>` : ''}</td></tr>
</table></td></tr></table></body></html>`
  return { subject: content.subject, text: alertEmailPlaintext(content), html }
}
