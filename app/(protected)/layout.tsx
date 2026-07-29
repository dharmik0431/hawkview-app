import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'
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
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Sidebar />
        <div className="lg:pl-52">
          <Topbar />
          <main className="py-6 px-4 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </ProtectedRoute>
  )
}
