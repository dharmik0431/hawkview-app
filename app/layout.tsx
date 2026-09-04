import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { QueryProvider } from '@/components/providers/query-provider'
import { ThemeProvider } from '@/components/providers/theme-provider'
import { AuthProvider } from '@/components/providers/auth-provider'
import { FeatureFlagProvider } from '@/components/providers/feature-flag-provider'
import { resolveServerFeatureFlags } from '@/lib/features/feature-flags'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'HawkView',
  description: 'Enterprise SaaS Management Platform',
  icons: {
    icon: '/brand/hawkview-favicon.svg',
    shortcut: '/brand/hawkview-favicon.svg',
    apple: '/brand/hawkview-mark-256.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const featureFlags = resolveServerFeatureFlags({
    // Global UI exposure only, independent of backend evaluation/availability.
    // Unset is visible; explicit false (or invalid config) is an emergency hide.
    identityRiskUi: process.env.HAWKVIEW_IDENTITY_RISK_UI_ENABLED,
  })

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <FeatureFlagProvider flags={featureFlags}>
            <AuthProvider>
              <QueryProvider>{children}</QueryProvider>
            </AuthProvider>
          </FeatureFlagProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
