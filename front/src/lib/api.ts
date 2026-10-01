import type { Diagnostic } from "@/lib/types"

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Relato do VTY quando o Prisma recusou a chamada. */
    public diagnostics?: { items: Diagnostic[]; output: string } | null,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/")) {
    // Sessão expirou no meio do uso: navegação completa para descartar o cache do SWR.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new ApiError(
      res.status,
      data?.error?.code ?? "unknown",
      data?.error?.message ?? `Erro ${res.status}`,
      data?.error?.diagnostics,
    )
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T = void>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
}

/** Fetcher do SWR: a chave é o caminho sob /api. */
export const fetcher = <T>(path: string) => api.get<T>(path)

export function errorMessage(err: unknown) {
  if (err instanceof ApiError && err.diagnostics?.items?.length) {
    // A mensagem do VTY é mais útil que o resumo do status gRPC.
    return err.diagnostics.items.map((d) => d.message).join("; ")
  }
  return err instanceof Error ? err.message : "Erro inesperado"
}
