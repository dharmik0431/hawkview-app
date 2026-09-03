'use client'

import { AuthForm } from '@/components/auth/auth-form'
import { AuthLayout } from '@/components/auth/auth-layout'

export function LoginPageContent() {
  return (
    <AuthLayout>
      <AuthForm initialMode="sign-in" />
    </AuthLayout>
  )
}
