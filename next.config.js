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
    return {
      ...nextConfig,
      webpack(config, { dev, webpack }) {
        if (dev) {
          const { frontendSourceHash, frontendSourceDependencies } = require('./scripts/frontend-build-identity.cjs')
          // No clock: the same source must compile to the same server/client identity.
          // File + context dependencies invalidate this module for edits and added/deleted inputs.
          const sourceIdentity = webpack.DefinePlugin.runtimeValue(
            () => JSON.stringify(JSON.stringify({ kind: 'source', sourceHash: frontendSourceHash(__dirname), builtAt: null })),
            { ...frontendSourceDependencies(__dirname), version: () => frontendSourceHash(__dirname) },
          )
          config.plugins.push(new webpack.DefinePlugin({ __HAWKVIEW_SOURCE_IDENTITY__: sourceIdentity }))
        }
        return config
      },
    }
  }
  return nextConfig
}
