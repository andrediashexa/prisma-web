"use client"

import Link from "next/link"
import { Fragment, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  ChevronRightIcon,
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { POLICY_PAGES } from "@/components/policies/policies-pages"
import { ROUTING_PAGES } from "@/components/routing/routing-pages"
import { useFleetStatus, useRouters } from "@/hooks/use-routers"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { hasRole, ROLE_LABEL, type CurrentUser, type Role } from "@/lib/types"

type NavItem = { href: string; label: string; icon: React.ComponentType; role?: Role }

const ROUTER_PAGES: { href: string; label: string; children?: readonly { href: string; label: string }[] }[] = [
  { href: "", label: "Dashboard" },
  { href: "/interfaces", label: "Interfaces" },
  { href: "/config", label: "Configuration" },
  { href: "/cgnat", label: "CGNAT" },
  // One page per protocol and the routing table (#88).
  { href: "/routing", label: "Routing", children: ROUTING_PAGES },
  // The policies, and the lists they match on (#89).
  { href: "/policies", label: "Policies", children: POLICY_PAGES },
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
  // A sub-menu the user opened or closed stays so; otherwise it is open while one of its pages is shown (#90).
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, inside: boolean) => chosen[key] ?? inside
  const choose = (key: string, open: boolean) => setChosen((c) => ({ ...c, [key]: open }))
  // Following the link drops the choice: the sub-menu is open while inside, closed when left.
  const follow = (key: string) =>
    setChosen((c) => {
      const rest = { ...c }
      delete rest[key]
      return rest
    })

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
                      const open = isOpen(base, pathname === base || pathname.startsWith(base + "/"))
                      const status = fleet?.find((f) => f.id === r.id)
                      return (
                        <SidebarMenuItem key={r.id}>
                          <SidebarMenuButton asChild isActive={pathname === base} tooltip={r.name}>
                            <Link href={base} onClick={() => follow(base)}>
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
                          <SidebarMenuAction aria-label={`${r.name} pages`} aria-expanded={open} onClick={() => choose(base, !open)}>
                            <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
                          </SidebarMenuAction>
                          {open && (
                            <SidebarMenuSub>
                              {ROUTER_PAGES.map((p) => {
                                const href = base + p.href
                                // A section with pages opens while one of them is shown, until closed (#90).
                                const inside = !!p.children && isOpen(href, pathname === href || pathname.startsWith(href + "/"))
                                return (
                                  <SidebarMenuSubItem key={p.label} className="relative">
                                    <SidebarMenuSubButton asChild isActive={pathname === href && !p.children} className={p.children ? "pr-8" : undefined}>
                                      <Link href={href} onClick={() => p.children && follow(href)}>
                                        {p.label}
                                      </Link>
                                    </SidebarMenuSubButton>
                                    {p.children && (
                                      <button
                                        type="button"
                                        aria-label={`${p.label} pages`}
                                        aria-expanded={inside}
                                        onClick={() => choose(href, !inside)}
                                        className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring absolute top-1 right-1 flex size-5 items-center justify-center rounded-md outline-hidden focus-visible:ring-2"
                                      >
                                        <ChevronRightIcon className={cn("size-4 transition-transform", inside && "rotate-90")} />
                                      </button>
                                    )}
                                    {inside && (
                                      <SidebarMenuSub aria-label={p.label} className="mr-0 pr-0">
                                        {p.children!.map((c) => (
                                          <SidebarMenuSubItem key={c.label}>
                                            <SidebarMenuSubButton asChild size="sm" isActive={pathname === href + c.href}>
                                              <Link href={href + c.href}>{c.label}</Link>
                                            </SidebarMenuSubButton>
                                          </SidebarMenuSubItem>
                                        ))}
                                      </SidebarMenuSub>
                                    )}
                                  </SidebarMenuSubItem>
                                )
                              })}
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
