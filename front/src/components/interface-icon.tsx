import { CableIcon, LockIcon, NetworkIcon, RepeatIcon, TagIcon } from "lucide-react"

import type { InterfaceKind } from "@/lib/types"

const ICONS: Record<InterfaceKind, React.ComponentType<{ className?: string }>> = {
  ethernet: CableIcon,
  bridge: NetworkIcon,
  vlan: TagIcon,
  wireguard: LockIcon,
  loopback: RepeatIcon,
}

export const KIND_LABEL: Record<InterfaceKind, string> = {
  ethernet: "Ethernet",
  bridge: "Bridge",
  vlan: "VLAN",
  wireguard: "WireGuard",
  loopback: "Loopback",
}

export function InterfaceIcon({ kind, className }: { kind: InterfaceKind; className?: string }) {
  const Icon = ICONS[kind]
  return <Icon className={className} />
}
