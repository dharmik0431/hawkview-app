/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  allowedDevOrigins: [
    '*.run.app',
    '*.google.com',
    '*.riker.replit.dev',
    '*.replit.dev',
    '*.repl.co',
    '127.0.0.1',
    'localhost',
  ],
}

// Identity is compiled into the frontend, never minted by a running server.
// Keep the generator lazy: standalone/next start need neither source inputs nor Git.
module.exports = (phase) => {
  const { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } = require('next/constants')
  if (phase === PHASE_PRODUCTION_BUILD) {
    const buildIdentity = require('./scripts/frontend-build-identity.cjs').resolveFrontendBuildIdentity(__dirname)
    return { ...nextConfig, env: { NEXT_PUBLIC_HAWKVIEW_BUILD_IDENTITY: JSON.stringify(buildIdentity) } }
  }
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return { ...nextConfig, env: { NEXT_PUBLIC_HAWKVIEW_BUILD_IDENTITY: JSON.stringify({ kind: 'development', sourceHash: null, builtAt: null }) } }
  }
  return nextConfig
}
