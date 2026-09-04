import { runRiskKeyOperator } from './identity-risk/risk-key-operator.js'

const result = await runRiskKeyOperator(process.argv.slice(2))
process.stdout.write(`${result.output}\n`)
process.exitCode = result.exitCode
