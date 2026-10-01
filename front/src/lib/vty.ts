// Linhas de VTY que a interface gera para mudanças simples.
//
// A gramática real é do Prisma; este é o único lugar que a conhece. Se o VTY
// usar outra forma, corrija aqui (ver docs/prisma-integracao.md, item 1.1).

export interface EditBlock {
  path: string[]
  lines: string[]
}

export function interfacePath(name: string) {
  return [`interface ${name}`]
}

export function interfaceEdit(
  name: string,
  change: { description?: string; mtu?: number; adminUp?: boolean },
): EditBlock {
  const lines: string[] = []
  if (change.description !== undefined) {
    const d = change.description.trim()
    lines.push(d ? `description ${d}` : "no description")
  }
  if (change.mtu !== undefined) lines.push(`mtu ${change.mtu}`)
  if (change.adminUp !== undefined) lines.push(change.adminUp ? "no shutdown" : "shutdown")
  return { path: interfacePath(name), lines }
}

/** "nat / cgnat / pool X" → ["nat", "cgnat", "pool X"]. */
export function parsePath(raw: string) {
  return raw
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
}
