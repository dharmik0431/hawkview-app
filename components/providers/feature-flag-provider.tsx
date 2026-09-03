'use client'

import * as React from 'react'
import {
  DEFAULT_HAWKVIEW_FEATURE_FLAGS,
  type HawkViewFeatureFlags,
} from '@/lib/features/feature-flags'

const FeatureFlagContext = React.createContext<HawkViewFeatureFlags>(
  DEFAULT_HAWKVIEW_FEATURE_FLAGS
)

export function FeatureFlagProvider({
  flags,
  children,
}: {
  flags: HawkViewFeatureFlags
  children: React.ReactNode
}) {
  return (
    <FeatureFlagContext.Provider value={flags}>
      {children}
    </FeatureFlagContext.Provider>
  )
}

export function useFeatureFlags() {
  return React.useContext(FeatureFlagContext)
}
