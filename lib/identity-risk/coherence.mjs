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

  report.searched = identities.length
  report.sections = sections.length
  return report
}

/**
 * The same comparison, between what a sighted technician reads and what a
 * screen reader announces for the same region.
 *
 * Most of this surface's honesty lives in copy, so a visually-hidden label that
 * has drifted from its visible partner is a defect this project cares about
 * specifically — and reading order is the only view that shows both at once. It
 * cuts the other way too: an sr-only string is text a sighted reader never
 * sees, so noticing it in a preview does not mean it is on screen.
 *
 * The regions reported are those where the two readings differ once the glyphs
 * are set aside. Differing is not by itself wrong: "0" against "0 No findings
 * in evaluated evidence" is a label doing its job. Two readings that disagree
 * about a fact are the thing to look for.
 */
export function accessibleTextReport(markup) {
  const { document } = new JSDOM(markup).window

  const textExcluding = (element, selector) => {
    const clone = element.cloneNode(true)
    for (const hidden of clone.querySelectorAll(selector)) hidden.remove()
    return normalise(clone.textContent)
  }

  // One entry per hidden label, paired with the visible words nearest to it.
  //
  // An earlier version grouped labels by region and dropped an outer region
  // when an inner one was already reported, which quietly hid every label that
  // existed only at the outer level — including the one carrying this surface's
  // no-safe-verdict sentence. Pairing directly cannot drop anything.
  const report = []
  for (const label of document.querySelectorAll('.sr-only')) {
    let region = label.parentElement
    while (region && textExcluding(region, '.sr-only') === '') {
      region = region.parentElement
    }
    const heard = normalise(label.textContent)
    if (!heard) continue
    report.push({
      heard,
      seen: region ? textExcluding(region, '.sr-only') : '',
      // A label whose visible neighbourhood says nothing is text only one
      // audience ever receives, which is worth seeing separately from a label
      // that merely rephrases what is on screen.
      visibleNeighbour: Boolean(region),
    })
  }
  return report
}

/** The accessible-text comparison as a panel. */
export function accessibleTextPanel(report) {
  const escape = (value) =>
    String(value).replace(
      /[&<>]/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character
    )

  if (report.length === 0) {
    return `<section class="coherence"><h2>Seen versus heard</h2><p>This route renders nothing with a visually-hidden label. That is not a pass — it means the check found no material here, which on a surface that uses them is itself worth explaining.</p></section>`
  }

  const heardOnly = report.filter((entry) => !entry.visibleNeighbour).length
  // Heard-only labels first, then the rest in document order.
  //
  // This pass reports every hidden label rather than only the suspicious ones,
  // because its non-findings have earned their place — reading the ordinary
  // ones is how the duplicated headline turned up, and that label was neither
  // heard-only nor contradicting anything. But a list that grows with the
  // surface eventually gets skimmed, and a skimmed instrument reports nothing
  // while appearing to run. Floating the one category that can be detected
  // mechanically keeps the reading worthwhile as the page grows, without
  // discarding the entries that only a reader can judge.
  const ordered = [
    ...report.filter((entry) => !entry.visibleNeighbour),
    ...report.filter((entry) => entry.visibleNeighbour),
  ]

  const rows = ordered
    .map(({ seen, heard, visibleNeighbour }) => {
      const repeated = seen.includes(heard)
      const note = !visibleNeighbour
        ? '<em>heard only — nothing visible near it</em>'
        : repeated
          ? '<em>repeats what is already on screen</em>'
          : ''
      return `<tr><th scope="row">Heard</th><td>${escape(heard)} ${note}</td></tr><tr><th scope="row">Seen nearby</th><td>${escape(seen) || '<em>nothing</em>'}</td></tr>`
    })
    .join('<tr class="spacer"><td colspan="2"></td></tr>')

  return `<section class="coherence"><h2>Seen versus heard</h2><p>${report.length === 1 ? 'One visually-hidden label' : `All ${report.length} visually-hidden labels`} on this screen${heardOnly === 0 ? (report.length === 1 ? ', with visible text nearby' : ', each with visible text nearby') : `, ${heardOnly} with nothing visible nearby`}. Each is shown with the visible words next to it. Most will rephrase or expand what is on screen, which is a label doing its job. Two to look for: a label that states a <em>fact</em> the visible text contradicts, and a label marked <em>heard only</em> — text one audience receives and the other never does.</p><table><tbody>${rows}</tbody></table></section>`
}

/** The report as a panel to sit above the page it describes. */
export function coherencePanel(report) {
  const scope = `Looked for ${report.searched ?? 0} named ${
    report.searched === 1 ? 'identity' : 'identities'
  } across ${report.sections ?? 0} sections.`

  if (report.length === 0) {
    return `<section class="coherence"><h2>Cross-section coherence</h2><p>${scope} None of them appears in more than one, so there is nothing for this pass to compare. That is not a pass — it means this route cannot exercise the check. Use a route where the same person appears in several places, and check that the names given to the pass are the ones actually rendered.</p></section>`
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

  return `<section class="coherence"><h2>Cross-section coherence</h2><p>${scope} ${report.length} of them ${report.length === 1 ? 'appears' : 'appear'} in more than one, and everything the screen says about those is collected below so it can be read together. Nothing here is asserted — read it and judge whether any two statements contradict when a technician meets them on the same screen.</p>${blocks}</section>`
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
