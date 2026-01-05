'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Eye } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)

  const handleDevSignIn = async () => {
    setIsLoading(true)
    document.cookie = 'hawkview-session=dev-session; path=/; max-age=86400'
    await new Promise(resolve => setTimeout(resolve, 500))
    router.push('/tenants')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto w-16 h-16 bg-primary rounded-xl flex items-center justify-center">
            <Eye className="w-8 h-8 text-primary-foreground" aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-2xl font-bold">HawkView</CardTitle>
            <CardDescription className="mt-2">
              Enterprise SaaS Management Platform
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={handleDevSignIn}
            disabled={isLoading}
            className="w-full"
            size="lg"
            aria-label="Sign in with development credentials"
          >
            {isLoading ? 'Signing in...' : 'Dev Sign In'}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            Development mode. Microsoft Entra ID integration coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
