'use client'

import { Building2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function TenantsPage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Tenants</CardTitle>
          <CardDescription>
            Manage your Microsoft 365 and Google Workspace tenants.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <Building2 className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium">Coming Soon</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-sm">
              Full tenant management features will be available here. For now, view tenant overview on the Dashboard.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
