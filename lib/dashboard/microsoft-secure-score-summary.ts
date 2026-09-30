import { datasetAge } from '../tenants/dataset-age.ts'

function scoreObservations(rows: readonly unknown[]) {
  const tenants = new Map<string, Set<number | null>>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const { id, secureScore } = row as { id?: unknown; secureScore?: unknown }
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) continue
    const score = typeof secureScore === 'number' && Number.isFinite(secureScore) && secureScore >= 0 && secureScore <= 100 ? secureScore : null
    const observations = tenants.get(id) ?? new Set<number | null>()
    observations.add(score)
    tenants.set(id, observations)
  }
  return tenants
}

/** Average only supplied Microsoft percentages; tenant health is a different metric. */
export function microsoftSecureScoreSummary(rows: readonly unknown[]) {
  const tenants = scoreObservations(rows)
  const scores: number[] = []
  for (const observations of Array.from(tenants.values())) {
    // A conflicting duplicate (including a missing score) has no selected source.
    if (observations.size !== 1) continue
    const score = Array.from(observations)[0]
    if (score !== null) scores.push(score)
  }
  return {
    value: scores.length ? `${Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)}%` : 'Unavailable',
    detail: scores.length && scores.length === tenants.size
      ? `Average across ${scores.length} tenant${scores.length === 1 ? '' : 's'}`
      : scores.length ? `Average across ${scores.length} of ${tenants.size} tenants`
        : `Scores available for 0 of ${tenants.size} tenant${tenants.size === 1 ? '' : 's'}`,
  }
}

/** Only canonical UTC instants supplied by the versioned backend contract. */
function contractDate(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || value.length !== 24) return null
  const instant = Date.parse(value)
  return Number.isFinite(now) && Number.isFinite(instant) && instant >= 0 && instant <= now &&
    new Date(instant).toISOString() === value ? value : null
}

/** Collection age follows the snapshots contributing to the scalar average.
 * A separately updated collection-success clock cannot date those values. */
export function microsoftSecureScoreAge(rows: readonly unknown[], now: number) {
  const contributors = new Map(Array.from(scoreObservations(rows)).filter(([, scores]) => scores.size === 1 && !scores.has(null)))
  if (!contributors.size) return null
  const observations = new Map<string, Set<string | null>>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const { id, secureScore, secureScoreDetails: details } = row as Record<string, any>
    if (!contributors.has(id)) continue
    let selected: string | null = null
    if (details && typeof details === 'object' && !Array.isArray(details) && details.version === 1 && details.percentage === secureScore) {
      const collected = contractDate(details.snapshotObservedAt, now)
      const scoreDate = contractDate(details.scoreCreatedAt, now)
      const lastSuccess = contractDate(details.lastSuccessfulCollectionAt, now)
      if (collected && (details.scoreCreatedAt === null || scoreDate) &&
          (details.lastSuccessfulCollectionAt === null || lastSuccess) && (!scoreDate || scoreDate <= collected)) {
        selected = JSON.stringify([collected, scoreDate])
      }
    }
    const dates = observations.get(id) ?? new Set<string | null>()
    dates.add(selected)
    observations.set(id, dates)
  }
  const selected: [string, string | null][] = []
  for (const dates of Array.from(observations.values())) {
    if (dates.size === 1 && !dates.has(null)) selected.push(JSON.parse(Array.from(dates)[0]!))
  }
  if (selected.length !== contributors.size) return {
    label: 'Collection date unavailable',
    description: `Secure Score collection dates are missing or inconsistent for ${contributors.size - selected.length} of ${contributors.size} averaged tenants.`,
  }
  const collectionDates = Array.from(new Set(selected.map(([collected]) => collected))).sort()
  const scoreDates = selected.map(([, scoreDate]) => scoreDate)
  const scoreDateDetail = scoreDates.every((value): value is string => value !== null)
    ? `Oldest Microsoft score date: ${scoreDates.sort()[0]}.`
    : `Microsoft score date unavailable for ${scoreDates.filter(value => value === null).length} of ${contributors.size} averaged tenants.`
  const age = datasetAge({ source: 'Microsoft Secure Score snapshots', observedAt: collectionDates[0] }, now)
  return {
    label: `Oldest collection: ${age.label.replace('Updated ', '')}`,
    description: `Secure Score snapshot collection dates (UTC): ${collectionDates.join('; ')}. ${scoreDateDetail} Collection dates describe retrieval; Microsoft score dates describe the scores.`,
  }
}
