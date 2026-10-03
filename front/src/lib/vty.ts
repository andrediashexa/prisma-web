// What the configuration screens send to the VTY: lines at a path, as one Edit.
//
// The interface lines live in lib/interface-config.ts since #40, the rest of the
// grammar in lib/config-model.ts (#39).

export interface EditBlock {
  path: string[]
  lines: string[]
}

/** "nat / cgnat / pool X" → ["nat", "cgnat", "pool X"]. */
export function parsePath(raw: string) {
  return raw
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
}
