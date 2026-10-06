/**
 * Why the dataplane and the routing daemons last started (Prisma 0.151.14, #75), as the box
 * recorded it: "boot", "operator", "upgrade", "unexpected", or "" when it has not recorded that
 * start (a release before 0.151.14 started it). Only "unexpected" is "by itself"; "" is "not
 * recorded", never a guess.
 */
export type StartCause = "boot" | "operator" | "upgrade" | "unexpected" | ""

export const CAUSE_TEXT: Record<StartCause, string> = {
  boot: "at boot",
  operator: "on request (system dataplane restart)",
  upgrade: "for an upgrade",
  unexpected: "by itself (nothing on the box asked for it)",
  "": "cause not recorded",
}

export interface RestartNote {
  /** "destructive" only for a start nothing asked for. */
  tone: "destructive" | "warning" | "info"
  /** A badge's few words. */
  short: string
  /** The sentence the Uptime card shows. */
  long: string
}

const cause = (v: string | undefined): StartCause => (v === "boot" || v === "operator" || v === "upgrade" || v === "unexpected" ? v : "")

/** What to say of a dataplane younger than the box; null when it is not. */
export function restartNote(sys: { dataplane_restarted?: boolean; dataplane_start_cause?: string } | undefined | null): RestartNote | null {
  if (!sys?.dataplane_restarted) return null
  const c = cause(sys.dataplane_start_cause)
  const dropped = "Every session it carried was dropped at that moment."
  switch (c) {
    case "unexpected":
      return { tone: "destructive", short: "dataplane restarted by itself", long: `The dataplane restarted by itself after the box booted: nothing on the box asked for it. ${dropped}` }
    case "operator":
      return { tone: "info", short: "dataplane restarted on request", long: `The dataplane was restarted on request (system dataplane restart) after the box booted. ${dropped}` }
    case "upgrade":
      return { tone: "info", short: "dataplane restarted for an upgrade", long: `The dataplane restarted for an upgrade after the box booted. ${dropped}` }
    case "boot":
      return null
    default:
      return {
        tone: "warning",
        short: "dataplane restarted",
        long: `The dataplane started after the box booted, and the box has not recorded why (it records causes from Prisma 0.151.14). ${dropped}`,
      }
  }
}

export const causeText = (v: string | undefined) => (v === undefined ? null : CAUSE_TEXT[cause(v)])
