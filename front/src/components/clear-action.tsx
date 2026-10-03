"use client"

import { useState } from "react"
import { EraserIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHasSystemService, useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { api, errorMessage } from "@/lib/api"
import { roleAtLeast, routerApi, type ClearResponse, type ClearTarget } from "@/lib/types"

/**
 * The VTY's `clear` lines (Prisma 0.149.25, #48): offered on a box that has
 * them (its SystemService answers health, as it came in the same release) to
 * whoever may change the router, the box's account included.
 */
export function useClears(routerId: string) {
  const has = useHasSystemService(routerId)
  const role = useRouterRole(routerId)
  const { readOnly } = useRouterAccess(routerId)
  return has && roleAtLeast(role, "operator") && !readOnly
}

const BGP_MODES = [
  { value: "soft", label: "soft (in and out, the session stays up)" },
  { value: "soft_in", label: "soft in (asks the peer to resend)" },
  { value: "soft_out", label: "soft out (resends to the peer)" },
  { value: "hard", label: "hard (drops the session)" },
] as const

/**
 * A button that clears one thing on the router after a confirmation that
 * says what it disrupts. The box's refusal is shown in the dialog, in its words.
 */
export function ClearAction({
  routerId,
  target,
  name = "",
  title,
  disrupts,
  label = "Clear",
  onDone,
}: {
  routerId: string
  target: ClearTarget
  name?: string
  title: string
  /** What the clear does to traffic or to the data shown, said before it is sent. */
  disrupts: string
  label?: string
  onDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [bgp, setBgp] = useState<string>("soft")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<ClearResponse>(routerApi(routerId, "/clear"), { target, name, bgp: target === "bgp" ? bgp : "" })
      toast.success(r.command ? `Done: ${r.command}` : "Done")
      setOpen(false)
      onDone?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={`${label} ${title}`}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        <EraserIcon /> {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear {title}?</DialogTitle>
            <DialogDescription>{disrupts}</DialogDescription>
          </DialogHeader>
          {target === "bgp" && (
            <div className="grid gap-1">
              <Label className="text-xs">How</Label>
              <Select value={bgp} onValueChange={setBgp}>
                <SelectTrigger aria-label="BGP clear mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BGP_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={run}>
              Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
