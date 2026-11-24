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
import { isAbsolute, resolve } from 'node:path'
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

/**
 * THE EXACT REQUEST FORMS the driver's own fixed Git adapter issues, and
 * nothing else.
 *
 * An earlier version allowlisted VERBS, which is not the same thing as
 * allowlisting read-only requests: `config` and `symbolic-ref` both have write
 * forms, and nothing validated the arguments after the verb, so
 * `config core.hooksPath /tmp/x` and `symbolic-ref HEAD refs/heads/other`
 * would have been delegated as writes. It also skipped containment when `-C`
 * was absent, left `cwd` unchecked, rejected only `shell === true` (so a
 * string value passed), and inspected the environment only when one was
 * supplied -- an absent one inheriting ambient configuration.
 *
 * The driver's whole Git surface is ONE call site plus the executable-source
 * status command, so the safe set is small and can be stated exactly.
 * `symbolic-ref` is not among them and is simply gone; `config` remains only
 * in its read-only `--get-regexp` shape, which has no value argument.
 */
const SAFE_GIT_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
})
/**
 * THE COMPLETE FIXED PREFIX the production caller issues, REQUIRED rather than
 * merely permitted, followed by the mandatory `-C`.
 *
 * Treating these as optional was a real omitted barrier. The safe environment
 * sets `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null`, which suppress
 * SYSTEM and GLOBAL configuration -- not the owned repository's own
 * `.git/config`. Measured: a locally configured value is still returned under
 * that environment, and only the `-c` override changes it. So a contained
 * `status` request with the exact safe environment and no `-c` settings would
 * have been delegated, and a local `core.fsmonitor` helper could then execute
 * inside the native child, outside every JavaScript patch here.
 *
 * Both real call sites -- the source adapter's single `git()` and the
 * executable-source status command -- emit exactly this sequence, so requiring
 * it verbatim costs nothing and removes the whole class.
 */
const REQUIRED_GIT_PREFIX = Object.freeze([
  '--no-pager', '--no-replace-objects',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.untrackedCache=false',
  '-C',
])
const OID = /^[0-9a-f]{40}$/
const REFUSED_OPTION_KEYS = ['detached', 'uid', 'gid', 'input', 'argv0', 'windowsVerbatimArguments']
const MAX_DELEGATED_TIMEOUT = 60_000

/** A relative, non-flag, non-traversing path. */
const safeRelative = token => typeof token === 'string' && token.length > 0
  && !token.startsWith('-') && !token.startsWith('/')
  && !token.split('/').includes('..')

/** Exact trailing forms per verb. Anything else is refused. */
const GIT_FORMS = Object.freeze({
  'cat-file': tail => tail.length === 2
    && (tail[0] === 'commit' || tail[0] === 'blob') && OID.test(tail[1]),
  'ls-tree': tail => tail.length >= 6 && tail[0] === '-r' && tail[1] === '-z'
    && tail[2] === '--full-tree' && OID.test(tail[3]) && tail[4] === '--'
    && tail.slice(5).every(safeRelative),
  'rev-parse': tail =>
    (tail.length === 1 && ['--show-toplevel', '--is-shallow-repository',
      '--absolute-git-dir', '--git-common-dir'].includes(tail[0]))
    || (tail.length === 2 && tail[0] === '--verify' && tail[1] === 'HEAD^{commit}')
    || (tail.length === 2 && tail[0] === '--git-path' && safeRelative(tail[1])),
  // READ-ONLY config ONLY. A write is `config <key> <value>`; requiring this
  // exact four-token shape leaves no room for a value or a mutating switch.
  config: tail => tail.length === 4 && tail[0] === '--local'
    && tail[1] === '--name-only' && tail[2] === '--get-regexp'
    && typeof tail[3] === 'string' && !tail[3].startsWith('-'),
  'for-each-ref': tail => tail.length === 2 && tail[0] === '--format=%(refname)'
    && typeof tail[1] === 'string' && tail[1].startsWith('refs/'),
  status: tail => tail.length >= 3 && tail[0] === '--porcelain=v1'
    && tail[1] === '--untracked-files=all' && tail[2] === '--'
    && tail.slice(3).every(safeRelative),
})

/**
 * Containment for `options.cwd` only. With an absolute canonical `-C`, Git's
 * repository selection no longer depends on `cwd` at all; this stays as a
 * second barrier so a delegated child cannot be started somewhere unexpected.
 */
const contained = (candidate, root) => {
  let resolved
  try { resolved = realpathSync(candidate) } catch { return false }
  return resolved === root || resolved.startsWith(`${root}/`)
}

/** Returns null when the COMPLETE request may be delegated, else the reason. */
function gitRefusalReason(name, args) {
  if (name !== 'spawnSync') return `api ${name}`
  if (String(args[0]) !== '/usr/bin/git') return 'executable'
  const argv = Array.isArray(args[1]) && args[1].every(t => typeof t === 'string')
    ? args[1] : null
  if (argv === null) return 'argv shape'
  const options = (args[2] && typeof args[2] === 'object') ? args[2] : null
  if (options === null) return 'options missing'
  // ANY shell value, not just `true`. A string selects a shell too.
  if (options.shell !== undefined && options.shell !== false) return 'shell'
  for (const key of REFUSED_OPTION_KEYS) {
    if (options[key] !== undefined) return `options ${key}`
  }
  if (typeof options.timeout !== 'number' || !(options.timeout > 0)
    || options.timeout > MAX_DELEGATED_TIMEOUT) return 'timeout'
  if (typeof gitRoot !== 'string' || gitRoot.length === 0) return 'no owned repository'
  // The environment must be PRESENT and exactly the safe set: absent means
  // the child inherits this process's configuration.
  const childEnvironment = options.env
  if (!childEnvironment || typeof childEnvironment !== 'object') return 'environment missing'
  const expectedKeys = Object.keys(SAFE_GIT_ENVIRONMENT).sort()
  const suppliedKeys = Object.keys(childEnvironment).sort()
  if (suppliedKeys.join(',') !== expectedKeys.join(',')) return 'environment keys'
  for (const key of expectedKeys) {
    if (String(childEnvironment[key]) !== SAFE_GIT_ENVIRONMENT[key]) return `environment ${key}`
  }
  if (options.cwd !== undefined
    && (typeof options.cwd !== 'string' || !contained(options.cwd, gitRoot))) {
    return 'cwd outside repository'
  }
  // THE EXACT PREFIX, token for token. A missing or reordered barrier is
  // reported with its position so each omission has its own reason.
  for (let position = 0; position < REQUIRED_GIT_PREFIX.length; position += 1) {
    if (argv[position] !== REQUIRED_GIT_PREFIX[position]) {
      return `prefix ${position} ${REQUIRED_GIT_PREFIX[position]}`
    }
  }
  // THE TARGET MUST BE ABSOLUTE AND ALREADY CANONICAL.
  //
  // A relative `-C` cannot be validated here at all: `realpathSync` resolves
  // it against THIS process's working directory, while Git applies `-C` after
  // chdir'ing to `options.cwd`. Measured: with the observer in
  // `<owned>/backend`, `options.cwd = <owned>` and `-C ..`, validation
  // resolves to `<owned>` while Git lands in its parent. The production
  // caller always supplies an absolute canonical root, so the ambiguous form
  // is refused rather than interpreted.
  const target = argv[REQUIRED_GIT_PREFIX.length]
  if (typeof target !== 'string' || !isAbsolute(target)) return 'target not absolute'
  if (resolve(target) !== target) return 'target not canonical'
  let resolvedTarget
  try { resolvedTarget = realpathSync(target) } catch { return 'target unresolvable' }
  if (resolvedTarget !== target) return 'target not canonical'
  if (resolvedTarget !== gitRoot && !resolvedTarget.startsWith(`${gitRoot}/`)) {
    return 'target outside repository'
  }
  const index = REQUIRED_GIT_PREFIX.length + 1
  if (index >= argv.length) return 'no verb'
  const verb = argv[index]
  const form = GIT_FORMS[verb]
  if (form === undefined) return `verb ${verb}`
  if (!form(argv.slice(index + 1))) return `form ${verb}`
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

/**
 * Delegated receipts, BOUNDED but auditable: one compact line per call (the
 * driver issues thousands), plus the FULL request recorded once for each
 * distinct form signature and a final counted summary. Previously a delegated
 * call kept a single argument, so its actual argv, cwd, environment and
 * options were unavailable for the audit the comment claimed.
 */
const delegatedForms = new Map()

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = (...args) => {
    const refusal = allowGit ? gitRefusalReason(name, args) : 'git delegation disabled'
    if (refusal === null) {
      const request = describeRequest(name, args)
      const verb = request.argv[REQUIRED_GIT_PREFIX.length + 1] ?? ''
      const signature = `${verb}:${request.argv.length}`
      if (!delegatedForms.has(signature)) {
        delegatedForms.set(signature, { count: 0, request })
      }
      delegatedForms.get(signature).count += 1
      record(`child_process.${name}`, `delegated-git ${verb}`)
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
    writeFileSync(output, JSON.stringify({
      attempts,
      delegatedGit: [...delegatedForms.entries()]
        .map(([signature, entry]) => ({ signature, count: entry.count, request: entry.request }))
        .sort((left, right) => left.signature.localeCompare(right.signature)),
    }, null, 2))
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
