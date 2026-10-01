import { NextResponse, type NextRequest } from "next/server"

// Checagem otimista: sem cookie de sessão, nem tenta renderizar o painel.
// A validação real da sessão acontece no back a cada chamada da API.
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
  // Não intercepta /api (é do back, via Caddy), assets do Next nem arquivos estáticos.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[a-z0-9]+$).*)"],
}
