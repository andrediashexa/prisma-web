import { Badge } from "@/components/ui/badge"

export const ACTION_LABEL: Record<string, string> = {
  "auth.login": "login",
  "auth.login_blocked": "login blocked",
  "auth.logout": "logout",
  "auth.password_change": "password change",
  "user.bootstrap": "initial admin",
  "user.create": "created user",
  "user.update": "updated user",
  "user.delete": "deleted user",
  "router.interface.update": "updated interface",
  "router.command": "command",
  "router.clear": "clear",
  "config.commit": "commit",
  "config.confirm": "confirmed commit",
  "config.save": "saved configuration",
  "box.commit": "commit on device",
  "box.confirm-pending": "commit confirmed on device",
  "box.confirmed": "confirmed on device",
  "box.rolled-back": "automatic rollback",
  "box.saved": "saved on device",
  "router.create": "added router",
  "router.update": "updated router",
  "router.delete": "removed router",
}

export function AuditActionBadge({ action, success }: { action: string; success: boolean }) {
  const label = ACTION_LABEL[action] ?? action
  if (!success) return <Badge variant="destructive">{label} · failed</Badge>
  if (action === "box.rolled-back") return <Badge variant="destructive">{label}</Badge>
  const tone = action.startsWith("config.") || action.startsWith("box.")
    ? "bg-chart-1/15 text-chart-1"
    : action.startsWith("router.")
      ? "bg-chart-2/15 text-chart-2"
      : action.startsWith("user.")
        ? "bg-chart-4/20 text-amber-700 dark:text-chart-4"
        : ""
  return (
    <Badge variant="secondary" className={tone}>
      {label}
    </Badge>
  )
}
