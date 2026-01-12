import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const protectedRoutes = ['/tenants', '/dashboard', '/reports', '/settings']
const publicRoutes = ['/login']

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl

  // ✅ DEV BYPASS: allow access when ?dev=1 is present
  const devBypass = searchParams.get('dev') === '1'

  const sessionCookie = request.cookies.get('hawkview-session')
  const isAuthenticated = devBypass || !!sessionCookie?.value

  const isProtectedRoute = protectedRoutes.some((route) =>
    pathname.startsWith(route)
  )
  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route))

  if (isProtectedRoute && !isAuthenticated) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  if (isPublicRoute && isAuthenticated) {
    const dashboardUrl = new URL('/dashboard', request.url)
    if (devBypass) dashboardUrl.searchParams.set('dev', '1') // keep dev=1
    return NextResponse.redirect(dashboardUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
