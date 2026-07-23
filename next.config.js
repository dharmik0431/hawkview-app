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

module.exports = nextConfig
