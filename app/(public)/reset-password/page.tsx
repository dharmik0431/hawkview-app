'use client'

import { AuthLayout } from '@/components/auth/auth-layout'
import { UpdatePasswordForm } from '@/components/auth/update-password-form'

export default function ResetPasswordPage() {
  return (
    <AuthLayout>
      <UpdatePasswordForm />
    </AuthLayout>
  )
}
