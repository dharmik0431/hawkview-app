'use client'

import React from 'react'
import { AuthLayout } from '@/components/auth/auth-layout'
import { AuthForm } from '@/components/auth/auth-form'

export default function SignUpPage() {
  return (
    <AuthLayout>
      <AuthForm initialMode="sign-up" />
    </AuthLayout>
  )
}
