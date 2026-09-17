import { type Body } from './email-delivery.js'
import {
  ALERT_EMAIL_TEMPLATE_VERSION, alertEmailPlaintext, buildAlertEmailContent,
  escapeAlertEmailHtml as escape,
} from './email-alert-content.js'

/** Called only to create a NEW frozen payload. Existing envelope bytes must never be re-rendered. */
export function renderAlertEmail(body: Body, mode: 'live' | 'historical-test' = 'live') {
  const content = buildAlertEmailContent(body, { mode })
  const paragraph = (value: string) => `<p style="margin:0;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;">${escape(value)}</p>`
  const facts = content.facts.map(fact => `<p style="margin:8px 0 0;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#0f172a;">${escape(fact.label)}:</strong> ${escape(fact.value)}</p>`).join('')
  const steps = content.steps.map((step, index) => `<p style="margin:0 0 10px;font-size:14px;line-height:22px;color:#334155;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#1d4ed8;">${index + 1}.</strong> ${escape(step)}</p>`).join('')
  const html = `<!doctype html>
<html lang="en" dir="ltr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(content.subject)}</title></head>
<body lang="en" dir="ltr" style="margin:0;padding:0;background-color:#f1f5f9;color:#0f172a;font-family:'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%;">
<!-- Template: ${ALERT_EMAIL_TEMPLATE_VERSION}. The serialized envelope, not this version label, is retry authority. -->
<div lang="en" dir="ltr" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escape(content.eyebrow)}: ${escape(content.headline)}</div>
<table lang="en" dir="ltr" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#f1f5f9;">
<tr><td align="center" style="padding:20px 8px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;box-sizing:border-box;table-layout:fixed;background-color:#ffffff;border:1px solid #dbe4f0;border-radius:12px;">
<tr><td style="height:4px;background-color:#2563eb;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:18px 20px;background-color:#0f172a;overflow-wrap:anywhere;word-break:break-word;"><div style="font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.4px;color:#ffffff;"><span style="color:#60a5fa;">Hawk</span>View</div><div style="margin-top:4px;font-size:12px;line-height:20px;font-weight:600;letter-spacing:1px;color:#cbd5e1;">${escape(content.eyebrow)}</div></td></tr>
${content.notice ? `<tr><td style="padding:12px 20px;background-color:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:14px;line-height:22px;color:#1e3a8a;overflow-wrap:anywhere;word-break:break-word;"><strong>${escape(content.notice)}</strong></td></tr>` : ''}
<tr><td style="padding:20px 20px 14px;overflow-wrap:anywhere;word-break:break-word;"><h1 style="margin:0 0 10px;font-size:26px;line-height:33px;font-weight:700;letter-spacing:-0.4px;color:#0f172a;">${escape(content.headline)}</h1>${paragraph(content.intro)}</td></tr>
<tr><td style="padding:0 20px;"><div style="padding:14px;background-color:#f8fbff;border:1px solid #bfdbfe;border-left:4px solid #2563eb;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 8px;font-size:16px;line-height:23px;color:#1e3a8a;">Why it matters</h2>${paragraph(content.why)}</div></td></tr>
<tr><td style="padding:18px 20px 0;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 8px;font-size:16px;line-height:23px;color:#0f172a;">Alert scope</h2><p style="margin:0;font-size:19px;line-height:27px;font-weight:700;color:#0f172a;">${escape(content.summary)}</p>${facts}<p style="margin:8px 0 0;font-size:12px;line-height:20px;color:#475569;">${escape(content.priorityNote)}</p></td></tr>
<tr><td style="padding:16px 20px 0;overflow-wrap:anywhere;word-break:break-word;"><a href="${escape(content.actionUrl)}" style="display:block;box-sizing:border-box;max-width:100%;padding:13px 14px;border:1px solid #2563eb;border-radius:8px;background-color:#2563eb;font-size:15px;line-height:22px;font-weight:700;color:#ffffff;text-align:center;text-decoration:none;overflow-wrap:anywhere;word-break:break-word;">${escape(content.actionLabel)}</a><p style="margin:10px 0 0;font-size:12px;line-height:20px;color:#475569;">${escape(content.authorizationNote)}</p></td></tr>
<tr><td style="padding:18px 20px 8px;overflow-wrap:anywhere;word-break:break-word;"><h2 style="margin:0 0 10px;font-size:16px;line-height:23px;color:#0f172a;">Investigation next steps</h2>${steps}</td></tr>
<tr><td style="padding:16px 20px;background-color:#f8fafc;border-top:1px solid #e2e8f0;overflow-wrap:anywhere;word-break:break-word;">${paragraph(content.source)}${content.previewNote ? `<div style="margin-top:10px;">${paragraph(content.previewNote)}</div>` : ''}</td></tr>
</table></td></tr></table></body></html>`
  return { subject: content.subject, text: alertEmailPlaintext(content), html }
}
