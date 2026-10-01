"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { TriangleAlertIcon } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { RouterStatus } from "@/components/router-status"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { useMe } from "@/hooks/use-me"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { data: user, error } = useMe()

  useEffect(() => {
    if (error) router.replace("/login")
  }, [error, router])

  if (!user) {
    return (
      <div className="flex min-h-svh">
        <Skeleton className="m-2 hidden w-64 md:block" />
        <div className="flex-1 space-y-4 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <RouterStatus />
          <div className="flex-1" />
          <ThemeToggle />
        </header>
        {user.must_change_password && (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlertIcon className="size-4 shrink-0" />
            <span className="flex-1">Your password is temporary. Set a personal password before continuing.</span>
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings">Change password</Link>
            </Button>
          </div>
        )}
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
