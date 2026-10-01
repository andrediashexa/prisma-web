import { BoxesIcon, CableIcon, LockIcon, NetworkIcon, RepeatIcon, TagIcon } from "lucide-react"

/** The proto does not report the interface type; we infer it from the name to pick the icon. */
export type InterfaceKind = "ethernet" | "bridge" | "vlan" | "wireguard" | "loopback" | "bundle"

export function guessKind(name: string): InterfaceKind {
  const n = name.toLowerCase()
  if (n === "lo" || n.startsWith("loop")) return "loopback"
  if (n.startsWith("wg")) return "wireguard"
  if (n.startsWith("bond") || n.startsWith("bundle")) return "bundle"
  if (n.startsWith("br") || n.startsWith("bvi") || n.startsWith("lan")) return n.includes(".") ? "vlan" : "bridge"
  if (n.includes(".")) return "vlan"
  return "ethernet"
}

const ICONS: Record<InterfaceKind, React.ComponentType<{ className?: string }>> = {
  ethernet: CableIcon,
  bridge: NetworkIcon,
  vlan: TagIcon,
  wireguard: LockIcon,
  loopback: RepeatIcon,
  bundle: BoxesIcon,
}

export function InterfaceIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[guessKind(name)]
  return <Icon className={className} />
}
