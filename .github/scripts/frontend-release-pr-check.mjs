import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { run: checkFrontendRelease } = require('../../scripts/frontend-release.cjs')

// Only these paths are known not to change the shipped frontend or its release
// metadata. New/unknown paths still require a PR stamp until classified.
const nonFrontendFiles = new Set([
  'HAWKVIEW_PM.md',
  'README.md',
  '.github/workflows/quality-gates.yml',
  '.github/scripts/backend-quality-tests.mjs',
  '.github/scripts/backend-quality-tests.test.mjs',
  '.github/scripts/frontend-release-pr-check.mjs',
  '.github/scripts/frontend-release-pr-check.test.mjs',
])

export function requiresReleaseStamp(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true
  return paths.some((path) => {
    if (typeof path !== 'string' || path.length === 0) return true
    if (path.includes('\\') || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      return true
    }
    return !(
      path.startsWith('backend/') ||
      path.startsWith('docs/') ||
      nonFrontendFiles.has(path)
    )
  })
}

export function changedPathsBetween(baseSha, cwd = process.cwd()) {
  if (typeof baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error('A full pull request base commit SHA is required')
  }
  // Without rename detection, both the source and destination of a move are
  // inspected. Moving a frontend file into backend/ cannot bypass the stamp.
  const output = execFileSync('git', [
    'diff', '--no-renames', '--name-only', '-z', baseSha, 'HEAD',
  ], { cwd, encoding: 'utf8' })
  return output.split('\0').filter(Boolean)
}

function main() {
  const baseSha = process.env.HAWKVIEW_BASE_SHA
  if (typeof baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error('A full pull request base commit SHA is required')
  }
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseSha], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const paths = changedPathsBetween(baseSha)
  if (requiresReleaseStamp(paths)) {
    checkFrontendRelease(['check'])
    console.log('Frontend release PR number matches this pull request')
  } else {
    console.log('Backend, documentation, or quality-gate-only changes: frontend release stamp not required')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
