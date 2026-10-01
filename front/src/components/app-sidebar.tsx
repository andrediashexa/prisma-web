"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  ChevronsUpDownIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  NetworkIcon,
  RouteIcon,
  UsersIcon,
} from "lucide-react"

import { PrismaLogo } from "@/components/prisma-logo"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { api } from "@/lib/api"
import { hasRole, ROLE_LABEL, type CurrentUser, type Role } from "@/lib/types"

type NavItem = { href: string; label: string; icon: React.ComponentType; role?: Role }

const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Roteador",
    items: [
      { href: "/", label: "Painel", icon: LayoutDashboardIcon },
      { href: "/interfaces", label: "Interfaces", icon: NetworkIcon },
      { href: "/routes", label: "Rotas", icon: RouteIcon },
    ],
  },
  {
    label: "Administração",
    items: [
      { href: "/audit", label: "Log de mudanças", icon: HistoryIcon, role: "operator" },
      { href: "/users", label: "Usuários", icon: UsersIcon, role: "admin" },
    ],
  },
]

export function AppSidebar({ user }: { user: CurrentUser }) {
  const pathname = usePathname()
  const router = useRouter()

  async function logout() {
    await api.post("/auth/logout").catch(() => {})
    router.replace("/login")
  }

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <PrismaLogo className="size-8! shrink-0" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="font-semibold tracking-tight">Prisma</span>
                  <span className="text-muted-foreground text-xs">Gerenciamento</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.role || hasRole(user, i.role))
          if (items.length === 0) return null
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
        })}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="bg-primary/10 text-primary rounded-lg font-medium uppercase">
                      {user.username.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.username}</span>
                    <span className="text-muted-foreground truncate text-xs">{ROLE_LABEL[user.role]}</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                  Conectado como {user.username}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <KeyRoundIcon /> Trocar senha
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={logout}>
                  <LogOutIcon /> Sair
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
