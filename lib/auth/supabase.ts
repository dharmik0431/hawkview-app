'use client'

import { createClient } from '@supabase/supabase-js'
import {
  isBrowserSafeSupabasePublishableKey,
  publicRuntimeConfig,
} from '@/lib/config/public-runtime-config'

const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

export const isSupabaseConfigured = isBrowserSafeSupabasePublishableKey(
  supabasePublishableKey
)

export const supabase = isSupabaseConfigured
  ? createClient(publicRuntimeConfig.supabaseOrigin, supabasePublishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null
