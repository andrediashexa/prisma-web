"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

/** A section's pages in a row above them (#88, #89): in sight on a phone, where the sidebar is closed. */
export function SubNav({ label, base, pages }: { label: string; base: string; pages: readonly { href: string; label: string }[] }) {
  const pathname = usePathname()
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b pb-2">
      {pages.map((p) => {
        const href = base + p.href
        const active = pathname === href
        return (
          <Link
            key={p.label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors",
              active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            {p.label}
          </Link>
        )
      })}
    </nav>
  )
}
