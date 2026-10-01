import { Badge } from "@/components/ui/badge"

export const ACTION_LABEL: Record<string, string> = {
  "auth.login": "login",
  "auth.login_blocked": "login bloqueado",
  "auth.logout": "logout",
  "auth.password_change": "troca de senha",
  "user.bootstrap": "admin inicial",
  "user.create": "criou usuário",
  "user.update": "alterou usuário",
  "user.delete": "excluiu usuário",
  "router.interface.update": "alterou interface",
}

export function AuditActionBadge({ action, success }: { action: string; success: boolean }) {
  const label = ACTION_LABEL[action] ?? action
  if (!success) return <Badge variant="destructive">{label} · falhou</Badge>
  const tone = action.startsWith("router.")
    ? "bg-chart-1/15 text-chart-1"
    : action.startsWith("user.")
      ? "bg-chart-4/20 text-amber-700 dark:text-chart-4"
      : ""
  return (
    <Badge variant="secondary" className={tone}>
      {label}
    </Badge>
  )
}
