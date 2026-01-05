'use client'

import { FileBarChart } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Reports</CardTitle>
          <CardDescription>
            Analytics and reporting for your tenants.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <FileBarChart className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium">Coming Soon</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-sm">
              Detailed reports and analytics will be available here. Connect tenants to generate insights.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
