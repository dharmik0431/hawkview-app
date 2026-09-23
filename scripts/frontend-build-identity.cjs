const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const INPUT_DIRECTORIES = ['app', 'components', 'lib', 'types', 'public']
const INPUT_FILES = ['package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json',
  'tailwind.config.ts', 'postcss.config.js', 'scripts/frontend-build-identity.cjs']
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.json',
  '.html', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.webmanifest'])
const PRIVATE_NAMES = /^(?:private|secrets?|credentials?|node_modules|coverage|dist|out|logs?)(?:[._-]|$)/i

function excluded(name) {
  return name.startsWith('.') || PRIVATE_NAMES.test(name) || /(?:^|[._-])(?:private|secret|credentials?)(?:[._-]|$)/i.test(name)
}

/** Source inputs only: never Git, environment values, runtime output or backend identity. */
function frontendSourceHash(root) {
  const base = path.resolve(root)
  const files = []
  function stat(relative) {
    const entry = fs.lstatSync(path.join(base, relative))
    if (entry.isSymbolicLink()) throw new Error('Frontend build identity does not allow symlink inputs.')
    return entry
  }
  if (fs.lstatSync(base).isSymbolicLink()) throw new Error('Frontend build identity requires a real source directory.')
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(base, relative)).sort()) {
      if (excluded(name)) continue
      const child = `${relative}/${name}`
      const entry = stat(child)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        // Every public asset can affect the served site, including future file formats.
        if (child.startsWith('public/') || EXTENSIONS.has(path.extname(name).toLowerCase())) files.push(child)
      } else throw new Error('Frontend build identity found an unsupported input.')
    }
  }
  for (const directory of INPUT_DIRECTORIES) {
    if (!stat(directory).isDirectory()) throw new Error('Frontend build identity requires its source directories.')
    walk(directory)
  }
  for (const file of INPUT_FILES) {
    // Check intermediate directories too; an allowlisted file cannot escape through a symlink.
    const directory = path.dirname(file)
    if (directory !== '.' && !stat(directory).isDirectory()) throw new Error('Frontend build identity requires its build scripts.')
    if (!stat(file).isFile()) throw new Error('Frontend build identity requires its build inputs.')
    files.push(file)
  }
  const hash = createHash('sha256').update('hawkview-frontend-source/v1\0')
  for (const file of files.sort()) {
    const name = Buffer.from(file, 'utf8')
    const bytes = fs.readFileSync(path.join(base, file))
    hash.update(`${name.length}:`).update(name).update(`${bytes.length}:`).update(bytes)
  }
  return hash.digest('hex')
}

function createFrontendBuildIdentity(root, builtAt = new Date()) {
  if (!(builtAt instanceof Date) || !Number.isFinite(builtAt.getTime())) throw new Error('Invalid frontend build clock.')
  return Object.freeze({ kind: 'build', sourceHash: frontendSourceHash(root), builtAt: builtAt.toISOString() })
}

const BUILD_CONTEXT_KEY = '__HAWKVIEW_FRONTEND_BUILD_CONTEXT'

/** Next forks config/build workers with process.env. One context belongs to that build tree. */
function resolveFrontendBuildIdentity(root, environment = process.env, builtAt = new Date()) {
  const sourceRoot = path.resolve(root)
  const sourceHash = frontendSourceHash(sourceRoot)
  const inherited = environment[BUILD_CONTEXT_KEY]
  if (inherited !== undefined) {
    let context
    try { context = JSON.parse(inherited) } catch { throw new Error('Invalid inherited frontend build context.') }
    const identity = context?.identity
    if (!context || Object.keys(context).sort().join(',') !== 'identity,root' || context.root !== sourceRoot ||
      !identity || Object.keys(identity).sort().join(',') !== 'builtAt,kind,sourceHash' ||
      identity.kind !== 'build' || identity.sourceHash !== sourceHash || typeof identity.builtAt !== 'string' ||
      !Number.isFinite(Date.parse(identity.builtAt)) || new Date(identity.builtAt).toISOString() !== identity.builtAt) {
      throw new Error('Frontend build context does not match stable source inputs.')
    }
    return Object.freeze({ kind: 'build', sourceHash, builtAt: identity.builtAt })
  }
  if (!(builtAt instanceof Date) || !Number.isFinite(builtAt.getTime())) throw new Error('Invalid frontend build clock.')
  const identity = Object.freeze({ kind: 'build', sourceHash, builtAt: builtAt.toISOString() })
  environment[BUILD_CONTEXT_KEY] = JSON.stringify({ root: sourceRoot, identity })
  return identity
}

module.exports = { frontendSourceHash, createFrontendBuildIdentity, resolveFrontendBuildIdentity, BUILD_CONTEXT_KEY }

// Read-only operator command: matches the fingerprint embedded by the production build.
if (require.main === module) console.log(frontendSourceHash(path.resolve(__dirname, '..')))
