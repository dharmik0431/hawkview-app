// QA probe: 0814914's waiter withdrawal. The dangerous failure is a waiter
// whose deadline expires at the same instant the lane is handed to it — if the
// `handed` flag logic is wrong, the lane is either handed to a caller that has
// abandoned it (stranding every later read forever) or released twice.
// This deliberately aligns deadlines with the handoff moment, many times over,
// and after each round checks the lane is still grantable.
import { runInReadMemoryLane, ReadMemoryLaneCapacityError } from '../tenants/tenant-sync.service.js'

const STUCK = Symbol('stuck')
async function laneIsGrantable(timeoutMs = 2000) {
  const result = await Promise.race([
    runInReadMemoryLane(async () => 'granted'),
    new Promise<typeof STUCK>(resolve => setTimeout(() => resolve(STUCK), timeoutMs)),
  ])
  return result !== STUCK
}

let expired = 0
let completed = 0
let stuckAtRound: number | null = null
const ROUNDS = 300
const HOLD_MS = 12

for (let round = 0; round < ROUNDS && stuckAtRound === null; round++) {
  let release!: () => void
  const held = runInReadMemoryLane(() => new Promise<void>(resolve => { release = resolve }))

  // Deadlines straddling the exact moment the holder releases the lane.
  const waiters = [-2, -1, 0, 1, 2, 3].map(offset =>
    runInReadMemoryLane(async () => { completed++; return 'ok' }, Date.now() + HOLD_MS + offset)
      .catch(error => {
        if (error instanceof ReadMemoryLaneCapacityError) { expired++; return 'expired' }
        throw error
      }))

  setTimeout(() => release(), HOLD_MS)
  await held
  await Promise.all(waiters)

  if (!(await laneIsGrantable())) stuckAtRound = round
}

console.log(JSON.stringify({
  QA_READ_LANE_RACE: {
    rounds: ROUNDS,
    holdMs: HOLD_MS,
    waitersCompleted: completed,
    waitersExpired: expired,
    // Both outcomes must actually have occurred, or the probe never reached the race.
    exercisedBothPaths: completed > 0 && expired > 0,
    stuckAtRound,
    verdict: stuckAtRound !== null
      ? `FAIL: read lane permanently stuck after round ${stuckAtRound}`
      : completed > 0 && expired > 0
        ? 'PASS: lane remained grantable across every timeout/handoff interleaving, with both paths exercised'
        : 'INCONCLUSIVE: the race was not actually reached (tune HOLD_MS)',
  },
}, null, 2))
