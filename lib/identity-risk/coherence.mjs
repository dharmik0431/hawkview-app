// Cross-section coherence pass for the Risky Users surface.
//
// Six defects on this feature have had one shape: a statement that is true
// where it stands, positioned where a reader takes it as a statement about
// something else. Every one was invisible to unit tests and to the acceptance
// gate, for the same reason — both assert propositions one at a time, and each
// proposition here is individually true. They are only wrong in company.
//
// The class also scales with honesty. Every disclosure added to this surface is
// another true sentence that can be misread as being about its neighbour, so
// this gets worse as the page gets more careful, not better.
//
// This pass does not assert. It cannot: whether two true statements contradict
// is a judgement about meaning, and a machine that tried would either miss the
// real cases or drown the reader in false ones. What it does is put every
// statement the page makes about one identity next to every other statement it
// makes about that same identity, so a human reads them adjacent instead of
// four hundred pixels and one scroll apart.
//
// The template is the row it was built from: Microsoft reporting Alice Chen "at
// risk, high confidence" in one panel while a row labelled "HawkView and
// Microsoft" carried "Low" in another.
import { JSDOM } from 'jsdom'

/** Text of a section's own heading, for naming where a statement was found. */
function sectionName(section, document) {
  const id = section.getAttribute('aria-labelledby')
  const heading = id ? document.getElementById(id) : null
  const own = section.querySelector('h1, h2, h3, h4, h5')
  return (
    heading?.textContent?.trim() ||
    own?.textContent?.trim() ||
    'Unlabelled section'
  )
}

function normalise(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Every place on the page that says something about a given identity, with the
 * section it said it in and the words it used.
 */
export function coherenceReport(markup, identities) {
  const { document } = new JSDOM(markup).window
  const sections = Array.from(document.querySelectorAll('section'))
  const report = []

  for (const identity of identities) {
    const mentions = []
    for (const section of sections) {
      // Only the innermost section that mentions the identity, so a nested
      // group is not also reported as a mention of its parent.
      if (section.querySelector('section')) {
        const nested = Array.from(section.querySelectorAll('section'))
        if (nested.some((child) => child.textContent?.includes(identity))) {
          continue
        }
      }
      if (!section.textContent?.includes(identity)) continue

      const row = Array.from(section.querySelectorAll('tbody tr')).find(
        (item) => item.textContent?.includes(identity)
      )
      const cells = row
        ? Array.from(row.querySelectorAll('td')).map((cell) =>
            normalise(cell.textContent)
          )
        : null

      mentions.push({
        section: sectionName(section, document),
        // A row's cells read better as fields than as one run-on string; a
        // non-row mention keeps its surrounding sentence, which is usually the
        // part that does the misleading.
        says: cells ?? [normalise(section.textContent).slice(0, 400)],
      })
    }
    if (mentions.length > 1) report.push({ identity, mentions })
  }

  return report
}

/** The report as a panel to sit above the page it describes. */
export function coherencePanel(report) {
  if (report.length === 0) {
    return `<section class="coherence"><h2>Cross-section coherence</h2><p>No identity appears in more than one section on this screen, so there is nothing for this pass to compare. That is not a pass — it means this route cannot exercise the check. Use a route where the same person appears in several places.</p></section>`
  }

  const escape = (value) =>
    String(value).replace(
      /[&<>]/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character
    )

  const blocks = report
    .map(({ identity, mentions }) => {
      const rows = mentions
        .map(
          (mention) =>
            `<tr><th scope="row">${escape(mention.section)}</th><td>${mention.says
              .filter(Boolean)
              .map((part) => `<span>${escape(part)}</span>`)
              .join('')}</td></tr>`
        )
        .join('')
      return `<article><h3>${escape(identity)} — ${mentions.length} places on this screen</h3><table><tbody>${rows}</tbody></table></article>`
    })
    .join('')

  return `<section class="coherence"><h2>Cross-section coherence</h2><p>Everything this screen says about each identity that appears in more than one place, collected so it can be read together. Nothing here is asserted — read it and judge whether any two of these statements contradict when a technician meets them on the same screen.</p>${blocks}</section>`
}

export const coherenceStyles = `
.coherence{margin:0 0 24px;padding:16px 18px;border:2px solid #0f172a;border-radius:10px;background:#fff}
.coherence h2{margin:0 0 6px;font-size:15px}
.coherence>p{margin:0 0 14px;font-size:13px;color:#475569;max-width:70ch}
.coherence article{margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0}
.coherence h3{margin:0 0 8px;font-size:13px}
.coherence table{width:100%;border-collapse:collapse}
.coherence th{width:34%;text-align:left;vertical-align:top;padding:5px 10px 5px 0;font-size:12px;color:#0f172a}
.coherence td{padding:5px 0;font-size:12px;color:#334155}
.coherence td span{display:block;margin-bottom:3px}
`
