import { cancelReason, type CancelReason, type CancelScope } from './send-queue.js'

export interface CancellationArguments {
  readonly scope: CancelScope
  readonly by: string
  readonly because: CancelReason
  readonly apply: boolean
}

export function parseCancellationArguments(argv: readonly string[]): CancellationArguments {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  const valuedFlags = new Set(['--organisation', '--created-before', '--by', '--because'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (values.has(flag) || switches.has(flag)) throw new Error(`Repeated option: ${flag}`)
    if (flag === '--everything' || flag === '--apply') {
      switches.add(flag)
    } else if (valuedFlags.has(flag)) {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value.`)
      values.set(flag, next)
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
  }
  const value = (flag: string): string | undefined => values.get(flag)
  const organisation = value('--organisation')
  const everything = switches.has('--everything')
  const createdBefore = value('--created-before')
  const by = value('--by')
  const because = value('--because')

  // BOTH OR NEITHER IS AN ERROR, not a precedence rule. An operator who typed both does not know
  // which they meant, and picking one for them is how the wrong MSP gets silenced.
  if (organisation !== undefined && everything) {
    throw new Error('Pass --organisation or --everything, not both. Which one you meant is not something this can guess.')
  }
  if (organisation === undefined && !everything) throw new Error('Pass --organisation <uuid> or --everything.')
  if (organisation !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organisation)) {
    throw new Error('--organisation must be a canonical UUID.')
  }
  if (createdBefore === undefined) throw new Error('--created-before is required. See the note in --help.')
  if (by === undefined || by.trim() === '') throw new Error('--by is required.')
  if (because === undefined) throw new Error('--because is required. An unexplained stop is what turns into an argument with a customer.')

  const parsed = Date.parse(createdBefore)
  // A REFUSAL, NOT A FALLBACK. `Date.parse` of nonsense is NaN, and a NaN comparison in SQL
  // matches nothing — so a typo would silently stop zero jobs and read as "nothing was waiting".
  if (Number.isNaN(parsed)) throw new Error(`--created-before is not a date: ${createdBefore}`)
  const createdBeforeIso = new Date(parsed).toISOString()

  return {
    scope: organisation !== undefined
      ? { kind: 'ORGANISATION', organizationId: organisation.toLowerCase(), createdBeforeIso }
      : { kind: 'EVERYTHING', createdBeforeIso },
    by,
    // CONSTRUCTED HERE so a blank reason is an argument error with an exit code, not a
    // stack trace. It threw past the handler when it lived in main, which is a worse first
    // experience than the mistake deserves.
    because: cancelReason(because),
    apply: switches.has('--apply'),
  }
}
