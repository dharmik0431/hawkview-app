export type FrontendBuildIdentity =
  | Readonly<{ kind: 'build'; sourceHash: string; builtAt: string }>
  | Readonly<{ kind: 'source'; sourceHash: string; builtAt: null }>
  | Readonly<{ kind: 'development' | 'unavailable'; sourceHash: null; builtAt: null }>

const unavailable: FrontendBuildIdentity = Object.freeze({ kind: 'unavailable', sourceHash: null, builtAt: null })

/** Strict public metadata only. Never consult the API, runtime clock or Git from the browser. */
export function parseFrontendBuildIdentity(raw: string | undefined): FrontendBuildIdentity {
  if (!raw || raw.length > 512) return unavailable
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return unavailable
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'builtAt,kind,sourceHash') return unavailable
    if (record.kind === 'development' && record.sourceHash === null && record.builtAt === null) {
      return Object.freeze({ kind: 'development', sourceHash: null, builtAt: null })
    }
    if (record.kind === 'source' && typeof record.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(record.sourceHash) && record.builtAt === null) {
      return Object.freeze({ kind: 'source', sourceHash: record.sourceHash, builtAt: null })
    }
    if (record.kind !== 'build' || typeof record.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.sourceHash) ||
      typeof record.builtAt !== 'string' || !Number.isFinite(Date.parse(record.builtAt)) ||
      new Date(record.builtAt).toISOString() !== record.builtAt) return unavailable
    return Object.freeze({ kind: 'build', sourceHash: record.sourceHash, builtAt: record.builtAt })
  } catch { return unavailable }
}

// Dev compilation token updates with watched source, without depending on hosting mode or a clock.
declare const __HAWKVIEW_SOURCE_IDENTITY__: string | undefined
// Static access is replaced by Next at compile time in production server/client bundles.
export const FRONTEND_BUILD_IDENTITY = parseFrontendBuildIdentity(
  typeof __HAWKVIEW_SOURCE_IDENTITY__ === 'string' ? __HAWKVIEW_SOURCE_IDENTITY__ : process.env.NEXT_PUBLIC_HAWKVIEW_BUILD_IDENTITY,
)
