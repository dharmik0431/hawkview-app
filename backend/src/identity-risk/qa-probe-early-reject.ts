// QA probe: 53c1e8a's early reject. The throw happens AFTER acquisition and
// inside the try, so `finally` should still hand the lane on. If it doesn't,
// the lane strands and every later read fails forever — worse than the bug.
// This drives rejects while other readers are queued behind them, which is the
// case where a stranded lane would be visible.
import { runInReadMemoryLane, ReadMemoryLaneCapacityError } from '../tenants/tenant-sync.service.js'

const STUCK = Symbol('stuck')
async function laneIsGrantable(timeoutMs = 2000) {
  const result = await Promise.race([
    runInReadMemoryLane(async () => 'granted'),
    new Promise<typeof STUCK>(resolve => setTimeout(() => resolve(STUCK), timeoutMs)),
  ])
  return result !== STUCK
}

let rejected = 0
let completed = 0
let ranDespiteReject = 0
let stuckAtRound: number | null = null
const ROUNDS = 200

for (let round = 0; round < ROUNDS && stuckAtRound === null; round++) {
  // Occupy the lane so the following calls must queue behind it.
  let release!: () => void
  const held = runInReadMemoryLane(() => new Promise<void>(resolve => { release = resolve }))

  // Queued readers: some will be rejected for insufficient budget the moment
  // they acquire, some will run normally. Interleaved so a stranded lane after
  // a reject would block the normal ones behind it.
  const queued = [
    // generous deadline, impossible minimum -> must reject AFTER acquiring
    runInReadMemoryLane(async () => { ranDespiteReject++; return 'ran' }, Date.now() + 5_000, 60_000),
    // generous deadline, no minimum -> must run
    runInReadMemoryLane(async () => { completed++; return 'ok' }, Date.now() + 5_000, 0),
    runInReadMemoryLane(async () => { ranDespiteReject++; return 'ran' }, Date.now() + 5_000, 60_000),
    runInReadMemoryLane(async () => { completed++; return 'ok' }, Date.now() + 5_000, 0),
  ].map(promise => promise.catch(error => {
    if (error instanceof ReadMemoryLaneCapacityError) { rejected++; return 'rejected' }
    throw error
  }))

  release()
  await held
  await Promise.all(queued)

  if (!(await laneIsGrantable())) stuckAtRound = round
}

console.log(JSON.stringify({
  QA_EARLY_REJECT: {
    rounds: ROUNDS,
    rejected,
    completed,
    // A rejected call must never have executed its work function.
    workRanDespiteReject: ranDespiteReject,
    exercisedBothPaths: rejected > 0 && completed > 0,
    stuckAtRound,
    verdict: stuckAtRound !== null
      ? `FAIL: lane stranded after round ${stuckAtRound}`
      : ranDespiteReject > 0
        ? `FAIL: work executed ${ranDespiteReject} times despite an early reject`
        : rejected > 0 && completed > 0
          ? 'PASS: early reject releases the lane, readers behind it still run, and rejected work never executes'
          : 'INCONCLUSIVE: both paths were not exercised',
  },
}, null, 2))
