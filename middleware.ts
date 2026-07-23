import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const protectedRoutes = ['/tenants', '/dashboard', '/reports', '/settings']
const publicRoutes = ['/login']

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl

  // Development bypass: active ONLY when NODE_ENV is not production
  const isDev = process.env.NODE_ENV !== 'production'

  // Query param bypass (?dev=1) - strictly disabled in production
  const devQueryBypass = isDev && searchParams.get('dev') === '1'

  // Auth session cookie check
  const sessionCookie = request.cookies.get('hawkview-session')

  // In development, allow bypass so preview iframe works seamlessly
  const isAuthenticated = isDev || !!sessionCookie?.value

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
    if (devQueryBypass) dashboardUrl.searchParams.set('dev', '1')
    return NextResponse.redirect(dashboardUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
