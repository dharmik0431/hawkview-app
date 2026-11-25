import { assertDisposableTestDatabase } from '../src/prisma/native-alert-test-database.js'

type Environment = Readonly<Record<string, string | undefined>>
const repository = 'dharmik0431/hawkview-app'
const workflow = 'Required quality gates'
const job = 'backend-quality'
const profile = 'haw70-upgrade'
const connection = 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci'
const failure = 'HAW-70 upgrade context or target is not qualified'

function requireMatch(condition: boolean): void {
  if (!condition) throw new Error(failure)
}

/**
 * Pure refusal check for a proposed hosted profile, with no default process.env.
 * Environment strings are claims, not proof of hosting, approval or DB state.
 * Nothing returned by this helper authorizes execution.
 */
export function inspectHaw70UpgradeTarget(input: {
  environment: Environment
  expectedCandidateCommit: string
}) {
  try {
    requireMatch(Boolean(input) && typeof input === 'object' && !Array.isArray(input))
    requireMatch(Object.keys(input).sort().join(',') === 'environment,expectedCandidateCommit')
    const { environment, expectedCandidateCommit } = input
    requireMatch(Boolean(environment) && typeof environment === 'object' && !Array.isArray(environment))
    requireMatch(typeof expectedCandidateCommit === 'string' && /^[0-9a-f]{40}$/.test(expectedCandidateCommit))

    // Do not permit ambient connection routing, config/preload or alternate
    // datasource values to survive into a future separately reviewed runner.
    for (const key of Object.keys(environment)) {
      if (/^(PG|PRISMA_|DOTENV_)/i.test(key)
        || /^(NODE_OPTIONS|NODE_PATH|DIRECT_URL|SHADOW_DATABASE_URL|DATABASE_DIRECT_URL|npm_config_node_options|npm_config_script_shell)$/i.test(key)
        || (/DATABASE_URL$/i.test(key) && key !== 'DATABASE_URL')) {
        requireMatch(environment[key] === undefined)
      }
    }

    const required: Environment = {
      CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
      GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_API_URL: 'https://api.github.com', GITHUB_WORKFLOW: workflow, GITHUB_JOB: job,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
      GITHUB_SHA: expectedCandidateCommit, GITHUB_WORKFLOW_SHA: expectedCandidateCommit,
      HAWKVIEW_CI_MIGRATION_PROFILE: profile, HAWKVIEW_RUN_HAW70_UPGRADE: '1',
      HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1', TZ: 'UTC',
      HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
      HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
    }
    for (const [key, value] of Object.entries(required)) requireMatch(environment[key] === value)

    const ref = environment.GITHUB_REF
    requireMatch(typeof ref === 'string' && /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref)
      && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.')
      && !ref.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')))
    requireMatch(environment.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/quality-gates.yml@${ref}`)
    for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
      requireMatch(typeof environment[key] === 'string' && /^[1-9][0-9]{0,19}$/.test(environment[key]!))
    }

    // Reuse the existing boundary, then narrow its permitted local fixture
    // alternative to this one exact hosted service and public CI credential.
    const url = assertDisposableTestDatabase(environment, { requireUtc: true })
    requireMatch(url.port === '5432' && environment.DATABASE_URL === connection)

    return Object.freeze({
      kind: 'haw70-upgrade-target-claims-only-v1', executionAllowed: false,
      claimsMatchProposedProfile: true, profile, workflow, job,
      candidateCommit: expectedCandidateCommit,
      runId: environment.GITHUB_RUN_ID!, runAttempt: environment.GITHUB_RUN_ATTEMPT!,
      target: Object.freeze({ host: '127.0.0.1', port: 5432, database: 'hawkview_ci', user: 'hawkview_ci' }),
    })
  } catch {
    // Never retain caller values, connection credentials, cause or parser input.
    throw new Error(failure)
  }
}
