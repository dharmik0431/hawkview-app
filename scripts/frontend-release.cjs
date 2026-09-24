const fs = require('node:fs')
const path = require('node:path')

function validateRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'phase,pullRequest' ||
      !Number.isSafeInteger(value.phase) || value.phase < 1 ||
      (value.pullRequest !== null && (!Number.isSafeInteger(value.pullRequest) || value.pullRequest < 1))) {
    throw new Error('Release metadata must contain a positive integer phase and a positive integer or null pullRequest')
  }
  return value
}

function parsePullRequest(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('An actual positive PR number is required')
  }
  return Number(raw)
}

function run(args, file = path.join(__dirname, '../lib/config/frontend-release.json'), env = process.env) {
  const release = validateRelease(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (args[0] === 'stamp' && args.length === 2) {
    release.pullRequest = parsePullRequest(args[1])
    fs.writeFileSync(file, `${JSON.stringify(release, null, 2)}\n`)
  } else if (args[0] === 'check' && args.length === 1) {
    const expected = parsePullRequest(env.HAWKVIEW_PULL_REQUEST_NUMBER)
    if (release.pullRequest !== expected) throw new Error(`Release PR must equal actual PR ${expected}; run node scripts/frontend-release.cjs stamp ${expected}`)
  } else {
    throw new Error('Usage: node scripts/frontend-release.cjs stamp <actual-pr-number> | check (HAWKVIEW_PULL_REQUEST_NUMBER required)')
  }
  return release
}

module.exports = { validateRelease, parsePullRequest, run }
if (require.main === module) {
  try {
    const release = run(process.argv.slice(2))
    console.log(`Release ${release.phase}.${release.pullRequest}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
