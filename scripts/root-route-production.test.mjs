import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverPath = path.join(projectRoot, '.next', 'standalone', 'server.js')
let serverProcess
let origin
let serverOutput = ''

async function availablePort() {
  return new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address()
      const port = typeof address === 'object' && address ? address.port : null
      reservation.close((error) => {
        if (error) reject(error)
        else if (port) resolve(port)
        else reject(new Error('A test port could not be reserved.'))
      })
    })
  })
}

function retainOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-8_000)
}

async function waitForServer() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Next production server exited early.\n${serverOutput}`)
    }
    try {
      const response = await fetch(`${origin}/login`, { redirect: 'manual' })
      if (response.status === 200) return
    } catch {
      // The standalone server may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Next production server did not become ready.\n${serverOutput}`)
}

async function assertLoginSurface(route) {
  const response = await fetch(`${origin}${route}`, { redirect: 'manual' })
  const body = await response.text()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/i)
  assert.doesNotMatch(body, /NEXT_REDIRECT/)
  assert.match(body, /Welcome back/)
  assert.match(body, /Log in to your HawkView workspace\./)
  assert.match(body, /Email address/)
}

before(async () => {
  await access(serverPath)
  const port = await availablePort()
  origin = `http://127.0.0.1:${port}`
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', retainOutput)
  serverProcess.stderr.on('data', retainOutput)
  await waitForServer()
})

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return
  serverProcess.kill()
  await new Promise((resolve) => {
    serverProcess.once('exit', resolve)
    setTimeout(resolve, 2_000)
  })
})

test('GET / renders login without relying on a redirect Location header', async () => {
  await assertLoginSurface('/')
})

test('GET /login continues to render the canonical login route', async () => {
  await assertLoginSurface('/login')
})
