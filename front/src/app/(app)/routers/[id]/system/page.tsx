"use client"

import { useParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, PowerIcon, RefreshCwIcon, RotateCcwIcon, SearchIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useFleetStatus, useHasSystemService, useRouterAccess, useRouterRole, useRouters } from "@/hooks/use-routers"
import { api, ApiError, errorMessage, fetcher } from "@/lib/api"
import { releaseOf } from "@/lib/routing-config"
import { readEvents } from "@/lib/sse"
import { roleAtLeast, routerApi, type UpgradeProgress } from "@/lib/types"

type Action = "restart-dataplane" | "reboot" | "shutdown"

const ACTIONS: Record<Action, { title: string; does: string; done: string }> = {
  "restart-dataplane": {
    title: "Restart the dataplane",
    does:
      "The dataplane stops and starts again: no traffic is forwarded until it is back, and every CGNAT session ends. " +
      "If this router's management address is on a dataplane interface, it drops off the network too, and prisma-web loses it until the dataplane is back.",
    done: "The dataplane restarted.",
  },
  reboot: {
    title: "Reboot",
    does: "The box restarts: no traffic is forwarded and its API is away until it is back.",
    done: "The box is rebooting.",
  },
  shutdown: {
    title: "Shut down",
    does: "The box powers off and stays off: someone has to power it on again where it is.",
    done: "The box is shutting down.",
  },
}

/** What a refusal's reason means, and whether `force` may go past it. */
const REASON_TEXT: Record<string, { text: string; force: boolean }> = {
  unsaved: { text: "The running configuration is not saved: the next boot loads another one. Save it first, or go on anyway.", force: true },
  confirm_pending: { text: "A commit confirmed is waiting for its confirmation: the box would roll it back while it is down. Confirm it first, or go on anyway.", force: true },
  busy: { text: "Another upgrade or dataplane restart is running on the box.", force: false },
  permission: { text: "The box gives these to root only: prisma-web's account may not run them there.", force: false },
}

/**
 * The box itself (Prisma 0.149.25, #50): upgrade, dataplane restart, reboot and
 * shutdown, an administrator's, each after the router's name is typed.
 */
export default function SystemPage() {
  const { id } = useParams<{ id: string }>()
  const myRole = useRouterRole(id)
  const has = useHasSystemService(id)
  if (!roleAtLeast(myRole, "admin")) return <p className="text-muted-foreground text-sm">The system actions are available to administrators.</p>
  if (!has) return <p className="text-muted-foreground text-sm">This router&apos;s Prisma has no system actions (they came with 0.149.25).</p>
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <UpgradeCard routerId={id} />
      <PowerCard routerId={id} />
    </div>
  )
}

/**
 * Whether prisma-web's account may run the actions (Prisma 0.149.26, #51): true with
 * `can_operate`, false on a box that reports it (0.149.26 on) without it, null where the box
 * cannot tell (0.149.25): there the box answers, refusing in its words.
 */
function useCanOperate(id: string): boolean | null {
  const { access } = useRouterAccess(id)
  const release = releaseOf(useFleetStatus().data?.find((r) => r.id === id)?.version?.release)
  if (access?.can_operate) return true
  const reports = !!release && (release[0] > 0 || release[1] > 149 || (release[1] === 149 && release[2] >= 26))
  return access && reports ? false : null
}

/**
 * Prisma 0.149.25 and 0.149.26 stop the containers on a dataplane restart and never start them
 * again (prismarouting #564, seen on 192.0.2.198); 0.149.27 refuses it (#53); 0.149.28 and
 * 0.149.29 never start it (#54, #55); 0.149.30 renames the interfaces (#56). The back refuses it on those releases, and the page says why.
 */
function useRestartBroken(id: string) {
  const r = releaseOf(useFleetStatus().data?.find((x) => x.id === id)?.version?.release)
  return !!r && r[0] === 0 && r[1] === 149 && r[2] >= 25 && r[2] < 32
}

/** How the box's administrator grants the actions to prisma-web's account. */
function GrantNote({ account }: { account: string }) {
  return (
    <div className="bg-muted/50 space-y-2 rounded-lg border p-3 text-sm" data-grant>
      <p>
        The router does not let <span className="font-mono">{account}</span> upgrade, reboot, shut down or restart the dataplane. Its
        administrator (root) grants it at the router&apos;s prompt, then commits:
      </p>
      <pre className="font-mono text-xs">{`user ${account}\n role administrator\n operator\nexit`}</pre>
    </div>
  )
}

function useRouterName(id: string) {
  const { data } = useRouters()
  return data?.find((r) => r.id === id)?.name ?? ""
}

const PHASE_LABEL: Record<UpgradeProgress["phase"], string> = {
  PHASE_UNSPECIFIED: "no run",
  CHECKED: "checked",
  STARTED: "started",
  DOWNLOAD: "download",
  VERIFY: "verify",
  INSTALL: "install",
  INSTALLED: "installed",
  API_RESTART: "API restarting",
  FAILED: "failed",
}

function UpgradeCard({ routerId }: { routerId: string }) {
  const name = useRouterName(routerId)
  // The check is every account's since 0.149.26; the upgrade itself needs `operator` (#51).
  const canOperate = useCanOperate(routerId)
  const fleet = useFleetStatus()
  const release = fleet.data?.find((r) => r.id === routerId)?.version?.release
  const last = useSWR<UpgradeProgress>(routerApi(routerId, "/system/upgrade"), fetcher, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [phases, setPhases] = useState<UpgradeProgress[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newest, setNewest] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [typed, setTyped] = useState("")

  async function run(version: string) {
    setRunning(true)
    setError(null)
    if (version) setPhases([])
    try {
      const res = await fetch(`/api${routerApi(routerId, "/system/upgrade")}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, confirm: typed }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new ApiError(res.status, body?.error?.code ?? "unknown", body?.error?.message ?? `Error ${res.status}`, body?.error?.diagnostics)
      }
      await readEvents(res, (event, data) => {
        if (event === "progress") {
          const p = JSON.parse(data) as UpgradeProgress
          if (p.phase === "CHECKED") setNewest(p.newest)
          else setPhases((xs) => [...xs, p])
          // Maintenance begins, gets its end or is over: show it now, not at the next poll.
          if (["STARTED", "API_RESTART", "FAILED"].includes(p.phase)) void fleet.mutate()
        } else if (event === "error") setError(data)
      })
      void last.mutate()
    } catch (err) {
      setError(refusal(err))
    } finally {
      setRunning(false)
    }
  }

  const away = phases.find((p) => p.phase === "API_RESTART")
  const failed = phases.find((p) => p.phase === "FAILED")
  return (
    <Card data-upgrade>
      <CardHeader>
        <CardTitle>Upgrade</CardTitle>
        <CardDescription>
          Prisma {release ?? "?"} now. The box downloads, verifies and installs the release, then restarts its API: it shows as in
          maintenance until it is back.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={running} onClick={() => void run("")}>
            {running && !phases.length ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Check for a release
          </Button>
          {newest && (
            <>
              <span className="text-sm">
                Newest: <span className="font-mono">{newest}</span>
                {newest === release && <span className="text-muted-foreground"> (installed)</span>}
              </span>
              {newest !== release && (
                <Button
                  disabled={running || canOperate === false}
                  title={canOperate === false ? "The router does not let prisma-web's account upgrade it" : undefined}
                  onClick={() => {
                    setTyped("")
                    setConfirm(newest)
                  }}
                >
                  <UploadIcon /> Upgrade to {newest}
                </Button>
              )}
            </>
          )}
        </div>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {phases.length > 0 && (
          <ol className="space-y-1 text-sm" data-phases>
            {phases.map((p, i) => (
              <li key={i} className="flex items-start gap-2" data-phase={p.phase}>
                {p.phase === "FAILED" ? (
                  <CircleAlertIcon className="text-destructive mt-0.5 size-4 shrink-0" />
                ) : (
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                )}
                <span>
                  <Badge variant="outline" className="mr-2">
                    {PHASE_LABEL[p.phase]}
                  </Badge>
                  {p.message}
                </span>
              </li>
            ))}
            {running && (
              <li className="text-muted-foreground flex items-center gap-2">
                <Loader2Icon className="size-4 animate-spin" /> waiting for the box…
              </li>
            )}
          </ol>
        )}
        {away && <p className="text-sm">The API restarts now and is away for about {away.api_away_seconds} s; the router comes back by itself.</p>}
        {failed?.output && <pre className="bg-muted/50 overflow-x-auto rounded-lg border p-3 font-mono text-xs">{failed.output}</pre>}
        {!phases.length && last.data && last.data.phase !== "PHASE_UNSPECIFIED" && (
          <p className="text-muted-foreground text-sm">
            Last run: {PHASE_LABEL[last.data.phase]}
            {last.data.version && <> to <span className="font-mono">{last.data.version}</span></>}
            {last.data.started_at && <>, started {new Date(last.data.started_at).toLocaleString("en-US")}</>}
            {last.data.message && <> — {last.data.message}</>}
          </p>
        )}
        {last.error && <p className="text-muted-foreground text-sm">Last run: {refusal(last.error)}</p>}
      </CardContent>
      <ConfirmByName
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Upgrade to ${confirm}?`}
        does="The box installs the release and restarts its API; traffic goes on, but the router cannot be managed until it is back."
        name={name}
        typed={typed}
        setTyped={setTyped}
        action="Upgrade"
        onConfirm={() => {
          const v = confirm!
          setConfirm(null)
          void run(v)
        }}
      />
    </Card>
  )
}

/** A refusal in the box's words, with what its reason means. */
function refusal(err: unknown): string {
  const reason = err instanceof ApiError ? err.diagnostics?.reason : undefined
  const why = reason && REASON_TEXT[reason]
  return why ? `${errorMessage(err)}. ${why.text}` : errorMessage(err)
}

function PowerCard({ routerId }: { routerId: string }) {
  const name = useRouterName(routerId)
  const fleet = useFleetStatus()
  const canOperate = useCanOperate(routerId)
  const { access } = useRouterAccess(routerId)
  const restartBroken = useRestartBroken(routerId)
  const [action, setAction] = useState<Action | null>(null)
  const [typed, setTyped] = useState("")
  const [force, setForce] = useState(false)
  const [forceable, setForceable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function open(a: Action) {
    setAction(a)
    setTyped("")
    setForce(false)
    setForceable(false)
    setError(null)
  }

  async function run() {
    if (!action) return
    setBusy(true)
    setError(null)
    try {
      await api.post(routerApi(routerId, `/system/${action}`), { confirm: typed, force })
      toast.success(ACTIONS[action].done)
      setAction(null)
      void fleet.mutate()
    } catch (err) {
      if (action === "restart-dataplane" && err instanceof ApiError && err.code === "router_unavailable") {
        // The box answers when the restart has finished; it went away instead (#51).
        setError(
          "The router dropped off the network during the restart: its management address is probably on a dataplane interface. It shows as in maintenance until it answers again.",
        )
        void fleet.mutate()
        return
      }
      setError(refusal(err))
      const reason = err instanceof ApiError ? err.diagnostics?.reason : undefined
      setForceable(!!reason && !!REASON_TEXT[reason]?.force && action !== "restart-dataplane")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-power>
      <CardHeader>
        <CardTitle>Power</CardTitle>
        <CardDescription>Each stops traffic; the router&apos;s name is asked before it is sent, and every attempt is in the audit log.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canOperate === false && <GrantNote account={access?.account ?? "prisma-web"} />}
        {restartBroken && (
          <p className="text-sm text-amber-800 dark:text-amber-200" data-restart-broken>
            This router&apos;s Prisma cannot restart the dataplane through its API (prismarouting #564): 0.149.25 and 0.149.26 leave
            the router off the network until it reboots, 0.149.27 refuses it, 0.149.28 and 0.149.29 never start it, and 0.149.30
            brings the dataplane up with its interfaces renamed, which takes the router off the network. The restart is offered from
            0.149.32.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={canOperate === false || restartBroken} onClick={() => open("restart-dataplane")}>
            <RefreshCwIcon /> Restart the dataplane
          </Button>
          <Button variant="outline" disabled={canOperate === false} onClick={() => open("reboot")}>
            <RotateCcwIcon /> Reboot
          </Button>
          <Button variant="outline" className="text-destructive" disabled={canOperate === false} onClick={() => open("shutdown")}>
            <PowerIcon /> Shut down
          </Button>
        </div>
      </CardContent>
      <ConfirmByName
        open={action !== null}
        onOpenChange={(o) => !o && setAction(null)}
        title={action ? `${ACTIONS[action].title}?` : ""}
        does={action ? ACTIONS[action].does : ""}
        name={name}
        typed={typed}
        setTyped={setTyped}
        action={action ? ACTIONS[action].title : ""}
        busy={busy}
        error={error}
        extra={
          forceable && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={force} onCheckedChange={setForce} aria-label="Go on anyway" /> Go on anyway
            </label>
          )
        }
        onConfirm={() => void run()}
      />
    </Card>
  )
}

function ConfirmByName({
  open,
  onOpenChange,
  title,
  does,
  name,
  typed,
  setTyped,
  action,
  onConfirm,
  busy,
  error,
  extra,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  does: string
  name: string
  typed: string
  setTyped: (v: string) => void
  action: string
  onConfirm: () => void
  busy?: boolean
  error?: string | null
  extra?: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{does}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="confirm-name" className="text-sm">
            Type <span className="font-mono">{name}</span> to confirm
          </Label>
          <Input id="confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
        </div>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {extra}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy || typed.trim() !== name} onClick={onConfirm}>
            {busy && <Loader2Icon className="animate-spin" />} {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
