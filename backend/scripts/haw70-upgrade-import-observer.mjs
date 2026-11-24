/**
 * INERT EFFECT OBSERVER for a cold import of the HAW-70 staged upgrade driver.
 *
 * Loaded with `--import` BEFORE anything else, so the patches below are in
 * place while the module under observation is evaluated for the first time in
 * a fresh process. Nothing here delegates: every patched function RECORDS the
 * attempt and then refuses. No child is launched, no socket is opened and no
 * name is resolved.
 *
 * It exists because "importing the driver does no work" cannot be established
 * by asserting on exported constants after the module has already been
 * imported by the test file itself. That observation has to happen in a
 * process where the import has not yet occurred.
 *
 * `syncBuiltinESMExports()` is load-bearing. Patching the CommonJS export
 * object alone does not reach a module that does
 * `import { spawnSync } from 'node:child_process'`: named ESM bindings are
 * created from the module's exports, so without the sync the driver would
 * keep the ORIGINAL function and a real launch would not be observed.
 */
import childProcess from 'node:child_process'
import net from 'node:net'
import dns from 'node:dns'
import { createHash } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { registerHooks, syncBuiltinESMExports } from 'node:module'

const attempts = []
const record = (kind, detail) => { attempts.push({ kind, detail }) }
// Shared with the inert `pg` stub, which is loaded as a separate module and
// needs to record into the same log.
globalThis.__HAW70_OBSERVER__ = { attempts, record }

/**
 * EVERY child launch is recorded IN FULL, and refusal is the default.
 *
 * Two things this must get right, both of which an earlier version did not:
 *
 * 1. THE RECEIPT. Recording only `args[0]` proved a launch named some node
 *    binary and nothing else. The real adapter's argv, cwd, child
 *    environment and process options are the interesting part, so the whole
 *    request is recorded. The datasource URL carries a password, so
 *    `DATABASE_URL` is recorded as a SHA-256 digest and a length, never as a
 *    value; the test compares the digest of the value it supplied.
 *
 * 2. THE GIT EXCEPTION. It used to accept anything whose argv[0] was
 *    `/usr/bin/git`, through any of seven process APIs, and forward every
 *    argument and option to the real implementation. That would have
 *    delegated `git push`, `git fetch`, `git clean -fdx`, or a `-c
 *    core.hooksPath=...` invocation that runs an external helper -- so the
 *    "read-only git only" assurance was stronger than the boundary.
 *
 *    The exception is now enforced: only `spawnSync`, only `/usr/bin/git`,
 *    only an allowlisted read-only verb, only allowlisted `-c` settings and
 *    option shapes, a `-C` target that must resolve inside the owned
 *    repository, and an environment free of Git routing overrides. Anything
 *    else is recorded and refused BEFORE delegation.
 */
const realChild = {}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  realChild[name] = childProcess[name]
}
const allowGit = process.env.HAW70_OBSERVER_ALLOW_GIT === '1'
const gitRoot = process.env.HAW70_OBSERVER_GIT_ROOT
const databaseUrl = process.env.HAW70_OBSERVER_DATASOURCE

/** The read-only verbs the driver's own source validation actually uses. */
const READ_ONLY_GIT_VERBS = new Set(['status', 'cat-file', 'rev-parse', 'ls-tree', 'ls-files',
  'archive', 'merge-base', 'show', 'config', 'symbolic-ref', 'for-each-ref', 'log', 'diff'])
/** The only `-c` settings permitted, all of which DISABLE behaviour. */
const ALLOWED_GIT_CONFIG = new Set(['core.fsmonitor=false', 'core.hooksPath=/dev/null',
  'core.untrackedCache=false'])
const ALLOWED_GIT_FLAGS = new Set(['--no-pager', '--no-replace-objects'])

/** Returns null when the request may be delegated, else the reason to refuse. */
function gitRefusalReason(name, args) {
  if (name !== 'spawnSync') return `api ${name}`
  if (String(args[0]) !== '/usr/bin/git') return 'executable'
  const argv = Array.isArray(args[1]) ? args[1].map(String) : null
  if (argv === null) return 'argv shape'
  const options = (args[2] && typeof args[2] === 'object') ? args[2] : {}
  if (options.shell === true) return 'shell requested'
  if (typeof gitRoot !== 'string' || gitRoot.length === 0) return 'no owned repository'
  let index = 0
  let target = null
  while (index < argv.length) {
    const token = argv[index]
    if (ALLOWED_GIT_FLAGS.has(token)) { index += 1; continue }
    if (token === '-c') {
      if (!ALLOWED_GIT_CONFIG.has(argv[index + 1])) return `config ${argv[index + 1]}`
      index += 2
      continue
    }
    if (token === '-C') {
      target = argv[index + 1]
      index += 2
      continue
    }
    break
  }
  if (index >= argv.length) return 'no verb'
  if (!READ_ONLY_GIT_VERBS.has(argv[index])) return `verb ${argv[index]}`
  // Containment: the target must be inside the owned repository.
  if (target !== null) {
    let resolved
    try { resolved = realpathSync(target) } catch { return 'unresolvable target' }
    if (resolved !== gitRoot && !resolved.startsWith(`${gitRoot}/`)) return 'target outside repository'
  }
  // Routing overrides must not reach the delegated child.
  const childEnvironment = options.env
  if (childEnvironment && typeof childEnvironment === 'object') {
    for (const key of Object.keys(childEnvironment)) {
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|ALTERNATE|OBJECT_DIRECTORY|CEILING|COMMON_DIR|NAMESPACE)/.test(key)) {
        return `routing ${key}`
      }
    }
  }
  return null
}

/** The full request, with the datasource reduced to a digest. */
function describeRequest(name, args) {
  const argv = Array.isArray(args[1]) ? args[1].map(String) : []
  const options = (args[2] && typeof args[2] === 'object') ? args[2] : {}
  const childEnvironment = (options.env && typeof options.env === 'object') ? options.env : {}
  const projected = {}
  for (const key of Object.keys(childEnvironment).sort()) {
    const value = String(childEnvironment[key])
    projected[key] = key === 'DATABASE_URL'
      ? `sha256:${createHash('sha256').update(value).digest('hex')}:len=${value.length}`
      : value
  }
  return {
    api: name,
    executable: String(args[0]),
    argv,
    cwd: typeof options.cwd === 'string' ? options.cwd : null,
    shell: options.shell === undefined ? null : options.shell,
    timeout: options.timeout === undefined ? null : options.timeout,
    maxBuffer: options.maxBuffer === undefined ? null : options.maxBuffer,
    stdio: Array.isArray(options.stdio) ? options.stdio.map(String) : options.stdio ?? null,
    environmentKeys: Object.keys(projected),
    environment: projected,
  }
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = (...args) => {
    const refusal = allowGit ? gitRefusalReason(name, args) : 'git delegation disabled'
    if (refusal === null) {
      // Recorded compactly: the driver issues thousands of these and the
      // full receipt is reserved for the requests under observation.
      record(`child_process.${name}`, `delegated-git ${String(args[1]?.[args[1].length - 2] ?? '')}`)
      return realChild[name](...args)
    }
    record(`child_process.${name}`, JSON.stringify({
      refused: refusal, request: describeRequest(name, args) }))
    throw new Error('INERT OBSERVER: child launch refused')
  }
}
net.Socket.prototype.connect = function inertConnect(...args) {
  record('net.Socket.connect', JSON.stringify(args[0] ?? null))
  throw new Error('INERT OBSERVER: socket connect refused')
}
net.connect = net.createConnection = (...args) => {
  record('net.connect', JSON.stringify(args[0] ?? null))
  throw new Error('INERT OBSERVER: socket connect refused')
}
for (const name of ['lookup', 'resolve']) {
  dns[name] = (...args) => {
    record(`dns.${name}`, String(args[0]))
    throw new Error('INERT OBSERVER: name resolution refused')
  }
}
syncBuiltinESMExports()

/**
 * OPTIONAL ADAPTER OBSERVATION. With a stub path supplied, every `pg` import
 * resolves to that inert module instead of the real driver, so the ACTUAL
 * fixed adapter can be exercised -- its real `new Client`, `connect`,
 * `query` and `end` calls recorded -- while nothing reaches a database.
 *
 * Nothing is injected into the driver: it still imports `pg` by name and
 * builds its own adapter. The module graph is redirected from outside.
 */
const pgStub = process.env.HAW70_OBSERVER_PG_STUB
if (typeof pgStub === 'string') {
  const stubUrl = pathToFileURL(pgStub).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'pg') {
        record('resolve:pg', stubUrl)
        return { url: stubUrl, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

/**
 * The production entry reads `process.platform` and `process.version` as
 * ACTUAL facts, which is correct and is why it refuses on a workstation. To
 * exercise the adapter here, the harness states those facts differently --
 * it does not hand the driver a value, and the gate itself is covered
 * separately by reading the committed source.
 */
const forcedPlatform = process.env.HAW70_OBSERVER_FORCE_PLATFORM
if (typeof forcedPlatform === 'string') {
  Object.defineProperty(process, 'platform', { value: forcedPlatform, configurable: true })
  record('forced:platform', forcedPlatform)
}
const forcedVersion = process.env.HAW70_OBSERVER_FORCE_VERSION
if (typeof forcedVersion === 'string') {
  Object.defineProperty(process, 'version', { value: forcedVersion, configurable: true })
  record('forced:version', forcedVersion)
}

const output = process.env.HAW70_OBSERVER_OUTPUT
const target = process.env.HAW70_OBSERVER_TARGET
const control = process.env.HAW70_OBSERVER_POSITIVE_CONTROL === '1'

process.on('beforeExit', () => {
  if (typeof output === 'string') {
    writeFileSync(output, JSON.stringify({ attempts }, null, 2))
  }
})

// The cold import under observation, then the POSITIVE CONTROL: if the
// observer records nothing for the import AND nothing for a deliberate
// launch, it is broken rather than the import being clean.
const entryEnvironment = process.env.HAW70_OBSERVER_ENTRY_ENVIRONMENT

const run = async () => {
  if (typeof target === 'string') {
    record('import:begin', target)
    const module = await import(target)
    record('import:end', target)
    // With an environment supplied, CALL the real public entry so the actual
    // adapter is constructed and used. The outcome is recorded; the run is
    // expected to fail early against the inert stub, which is the point.
    if (typeof entryEnvironment === 'string') {
      try {
        const outcome = await module.runHaw70StagedUpgrade(
          { environment: JSON.parse(entryEnvironment) })
        record('entry:outcome', JSON.stringify({
          completed: outcome.completed, phase: outcome.phase, failure: outcome.failure,
          deployments: outcome.counts.deployments,
        }))
      } catch (error) {
        // A REJECTION is itself an observation: the entry is declared to
        // return an outcome, so this is recorded rather than allowed to kill
        // the process before the log is written.
        record('entry:threw', String(error && error.message))
      }
    }
  }
  if (control) {
    try { childProcess.spawnSync('/usr/bin/true', []) } catch { /* expected */ }
  }
}
await run()
