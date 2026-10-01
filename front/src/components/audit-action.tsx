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
  "router.command": "comando",
  "config.commit": "commit",
  "config.confirm": "confirmou commit",
  "config.save": "salvou configuração",
  "box.commit": "commit no equipamento",
  "box.confirm-pending": "commit confirmed no equipamento",
  "box.confirmed": "confirmado no equipamento",
  "box.rolled-back": "rollback automático",
  "box.saved": "salvo no equipamento",
  "router.create": "cadastrou Prisma",
  "router.update": "alterou Prisma",
  "router.delete": "removeu Prisma",
}

export function AuditActionBadge({ action, success }: { action: string; success: boolean }) {
  const label = ACTION_LABEL[action] ?? action
  if (!success) return <Badge variant="destructive">{label} · falhou</Badge>
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
