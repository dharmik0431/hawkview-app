// QA: what does the screen SAY, given a REAL native response?
//
// Not the assembled pixels. The preview harness cannot render the new screen at
// all: no native fixture exists in the repo, and its hook stub targets a module
// the component no longer imports. This is the next best thing and the part that
// matters most for this feature's recurring defect -- the adapter and the view
// model are the code that turns a payload into sentences, so running the real
// response through them shows the sentences that will appear and in what order.
//
// WHAT IT CANNOT SHOW: visual grouping, what is above the fold, what sits beside
// what. Two of the five known instances of this defect were exactly that. A
// clean result here does NOT clear the screen.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const checkout = resolve(dirname(fileURLToPath(import.meta.url)))
const cache = new Map()

const candidates = (spec, fromDir) => {
  const base = spec.startsWith('@/') ? join(checkout, spec.slice(2)) : join(fromDir, spec)
  const stripped = base.replace(/\.(ts|tsx|js)$/, '')
  return [`${stripped}.ts`, `${stripped}.tsx`, join(stripped, 'index.ts')]
}

function load(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const exports = {}
  cache.set(absPath, exports)
  const compiled = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const dir = dirname(absPath)
  new Function('require', 'exports', compiled)((spec) => {
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/')) {
      const hit = candidates(spec, dir).find(existsSync)
      if (hit) return load(hit)
    }
    return require(spec)
  }, exports)
  return exports
}

const nativeAssessment = load(join(checkout, 'lib/identity-risk/native-assessment.ts'))
const nativeView = load(join(checkout, 'lib/identity-risk/native-view.ts'))

const raw = JSON.parse(readFileSync(process.env.QA_RESPONSE ?? '/tmp/native-response.json', 'utf8'))
const adapt = nativeAssessment.adaptNativeAssessment
const view = adapt(raw)

console.log('ADAPTER ACCEPTED THE REAL RESPONSE:', view !== null)
if (view === null) {
  console.log('\nThe adapter REJECTED a response produced by the shipped backend.')
  console.log('That is a contract mismatch between the two halves of this merge.')
  process.exit(0)
}

console.log('\n================ COUNT CARD ================')
console.log(JSON.stringify(nativeView.nativeRiskyUserCount(view), null, 2))
console.log('\n================ LIST ================')
console.log(JSON.stringify(nativeView.nativeRiskyUserList(view), null, 2))
