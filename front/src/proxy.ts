import { NextResponse, type NextRequest } from "next/server"

// Optimistic check: without a session cookie, don't even try to render the dashboard.
// The real session validation happens in the back end on every API call.
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("pw_session")
  const { pathname, search } = request.nextUrl

  if (!hasSession && pathname !== "/login") {
    const url = new URL("/login", request.url)
    if (pathname !== "/") url.searchParams.set("next", pathname + search)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // Does not intercept /api (owned by the back end, via Caddy), Next assets or static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[a-z0-9]+$).*)"],
}
