"use client"

import { useParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { CornerDownLeftIcon, Loader2Icon, TerminalIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useRouters } from "@/hooks/use-routers"
import { useRouterRole } from "@/hooks/use-routers"
import { api, errorMessage } from "@/lib/api"
import { roleAtLeast, routerApi } from "@/lib/types"
import { cn } from "@/lib/utils"

const SUGGESTIONS = ["show version", "show bgp summary", "show ip route", "show ipv6 route", "show interfaces", "ping 2001:db8:100::1"]

interface Entry {
  command: string
  output: string
  error: boolean
}

/** Operational console: `show`/`ping` commands as at the prompt. Prisma rejects configuration commands. */
export default function ConsolePage() {
  const { id } = useParams<{ id: string }>()
  const myRole = useRouterRole(id)
  const { data: routers } = useRouters()
  const name = routers?.find((r) => r.id === id)?.name ?? "prisma"
  const [entries, setEntries] = useState<Entry[]>([])
  const [command, setCommand] = useState("")
  const [running, setRunning] = useState(false)
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [entries, running])

  if (!roleAtLeast(myRole, "operator")) {
    return <p className="text-muted-foreground text-sm">The console is available to operators and administrators.</p>
  }

  async function run(cmd: string) {
    const c = cmd.trim()
    if (!c) return
    setRunning(true)
    setCommand("")
    setHistoryIdx(null)
    try {
      const r = await api.post<{ text: string }>(routerApi(id, "/show"), { command: c })
      setEntries((e) => [...e, { command: c, output: r.text, error: false }])
    } catch (err) {
      setEntries((e) => [...e, { command: c, output: errorMessage(err), error: true }])
    } finally {
      setRunning(false)
    }
  }

  const history = entries.map((e) => e.command)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalIcon className="size-4" /> Console
        </CardTitle>
        <CardDescription>Operational VTY commands. Every command is recorded in the change log.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={() => setEntries([])} disabled={entries.length === 0}>
            <Trash2Icon /> Clear
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <Button key={s} variant="outline" size="sm" className="font-mono text-xs" onClick={() => run(s)} disabled={running}>
              {s}
            </Button>
          ))}
        </div>
        <div className="h-[60vh] overflow-y-auto rounded-lg border bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-100">
          {entries.length === 0 && !running && <div className="text-zinc-500">Type a command below, e.g. show bgp summary</div>}
          {entries.map((e, i) => (
            <div key={i} className="mb-3">
              <div>
                <span className="text-violet-300">{name}</span>
                <span className="text-zinc-500">&gt; </span>
                {e.command}
              </div>
              <pre className={cn("whitespace-pre-wrap", e.error && "text-red-400")}>{e.output}</pre>
            </div>
          ))}
          {running && <Loader2Icon className="size-4 animate-spin text-zinc-500" />}
          <div ref={bottom} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            run(command)
          }}
          className="flex items-center gap-2 rounded-lg border px-3 font-mono text-sm focus-within:ring-2 focus-within:ring-ring/50"
        >
          <span className="text-muted-foreground shrink-0">{name}&gt;</span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (history.length === 0) return
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault()
                const next =
                  e.key === "ArrowUp"
                    ? historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1)
                    : historyIdx === null ? null : historyIdx + 1 >= history.length ? null : historyIdx + 1
                setHistoryIdx(next)
                setCommand(next === null ? "" : history[next])
              }
            }}
            maxLength={256}
            autoFocus
            spellCheck={false}
            className="h-10 flex-1 bg-transparent outline-none"
            placeholder="show bgp summary"
            aria-label="Command"
          />
          <Button type="submit" size="sm" variant="ghost" disabled={running || !command.trim()} aria-label="Run">
            <CornerDownLeftIcon />
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
