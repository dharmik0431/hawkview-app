import { ProtectedShell } from '@/components/layout/protected-shell'
import '../globals.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { ProtectedRoute } from '@/components/auth/protected-route'

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ProtectedRoute>
      <ProtectedShell>{children}</ProtectedShell>
    </ProtectedRoute>
  )
}
