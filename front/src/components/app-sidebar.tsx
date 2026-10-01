"use client"

import Link from "next/link"
import { Fragment } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  ChevronsUpDownIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  ServerIcon,
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useFleetStatus, useRouters } from "@/hooks/use-routers"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { hasRole, ROLE_LABEL, type CurrentUser, type Role } from "@/lib/types"

type NavItem = { href: string; label: string; icon: React.ComponentType; role?: Role }

const ROUTER_PAGES = [
  { href: "", label: "Dashboard" },
  { href: "/interfaces", label: "Interfaces" },
  { href: "/config", label: "Configuration" },
  { href: "/cgnat", label: "CGNAT" },
  { href: "/routing", label: "Routing" },
  { href: "/policies", label: "Policies" },
  { href: "/console", label: "Console" },
]

const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "General",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboardIcon },
      { href: "/routers", label: "Routers", icon: ServerIcon },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/audit", label: "Change log", icon: HistoryIcon, role: "operator" },
      { href: "/users", label: "Users", icon: UsersIcon, role: "admin" },
    ],
  },
]

export function AppSidebar({ user }: { user: CurrentUser }) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: routers } = useRouters()
  const { data: fleet } = useFleetStatus()

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
                  <span className="text-muted-foreground text-xs">Management</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group, gi) => {
          const items = group.items.filter((i) => !i.role || hasRole(user, i.role))
          if (items.length === 0) return null
          return (
            <Fragment key={group.label}>
            <SidebarGroup>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const active = item.href === "/" || item.href === "/routers" ? pathname === item.href : pathname.startsWith(item.href)
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
            {gi === 0 && routers && routers.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel>Prisma routers</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {routers.map((r) => {
                      const base = `/routers/${r.id}`
                      const open = pathname === base || pathname.startsWith(base + "/")
                      const status = fleet?.find((f) => f.id === r.id)
                      return (
                        <SidebarMenuItem key={r.id}>
                          <SidebarMenuButton asChild isActive={open && pathname === base} tooltip={r.name}>
                            <Link href={base}>
                              <span className="flex size-4 shrink-0 items-center justify-center">
                                <span
                                  className={cn(
                                    "size-2 rounded-full",
                                    !status ? "bg-muted-foreground/50" : status.online ? "bg-emerald-500" : "bg-destructive",
                                  )}
                                />
                              </span>
                              <span className="truncate">{r.name}</span>
                            </Link>
                          </SidebarMenuButton>
                          {open && (
                            <SidebarMenuSub>
                              {ROUTER_PAGES.map((p) => (
                                <SidebarMenuSubItem key={p.label}>
                                  <SidebarMenuSubButton asChild isActive={pathname === base + p.href}>
                                    <Link href={base + p.href}>{p.label}</Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ))}
                            </SidebarMenuSub>
                          )}
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
            </Fragment>
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
                  Signed in as {user.username}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <KeyRoundIcon /> Change password
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={logout}>
                  <LogOutIcon /> Sign out
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
