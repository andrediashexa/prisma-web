"use client"

import { useParams } from "next/navigation"
import { Fragment, useState } from "react"
import useSWR from "swr"
import { FlaskConicalIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react"

import { ConfigView } from "@/components/config/diff-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useRouterRole } from "@/hooks/use-routers"
import { api, errorMessage, fetcher } from "@/lib/api"
import { formatNumber } from "@/lib/format"
import { roleAtLeast, routerApi, type Policy, type PolicyUseCounters, type TestPolicyResponse } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Attach points `test policy ... at` takes; the box refuses others with INVALID_ARGUMENT. */
const ATTACH_POINTS = ["import", "export", "table", "vrf-import", "fib bgp", "fib static", "ospf static"]

function ThenBadge({ then }: { then: string }) {
  if (!then) return <span className="text-muted-foreground text-xs">—</span>
  const tone =
    then === "accept"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : then === "reject"
        ? "bg-destructive/15 text-destructive"
        : ""
  return (
    <Badge variant="secondary" className={tone}>
      {then}
    </Badge>
  )
}

/** Routing policies of a Prisma (0.148.12, #21): definitions, per-term counters and a simulator. */
export default function PoliciesPage() {
  const { id } = useParams<{ id: string }>()
  const myRole = useRouterRole(id)
  const { data, error } = useSWR<{ policies: Policy[] }>(routerApi(id, "/policies"), fetcher)
  const { data: counters } = useSWR<{ uses: PolicyUseCounters[] }>(routerApi(id, "/policies/counters"), fetcher, {
    refreshInterval: 15_000,
  })
  const [open, setOpen] = useState<string | null>(null)

  if (error) return <p className="text-destructive text-sm">{error.message}</p>
  if (!data) return <Skeleton className="h-64 w-full rounded-xl" />

  return (
    <>
      <Card className="py-0">
        <CardHeader className="pt-6">
          <CardTitle>Policies</CardTitle>
          <CardDescription>Every policy-statement under policy-options and where the running routing applies it</CardDescription>
        </CardHeader>
        {data.policies.length === 0 ? (
          <CardContent className="text-muted-foreground pb-6 text-sm">This router has no routing policy configured.</CardContent>
        ) : (
          <div className="overflow-x-auto pb-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Policy</TableHead>
                  <TableHead>Terms</TableHead>
                  <TableHead>Default action</TableHead>
                  <TableHead className="pr-6">Applied at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.policies.map((p) => (
                  <Fragment key={p.name}>
                    <TableRow className="cursor-pointer align-top" onClick={() => setOpen(open === p.name ? null : p.name)}>
                      <TableCell className="pl-6 font-mono font-medium">{p.name}</TableCell>
                      <TableCell>
                        <div className="space-y-1.5">
                          {p.terms.map((t) => (
                            <div key={t.name} className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono font-medium">{t.name}</span>
                              <ThenBadge then={t.then} />
                              <span className="text-muted-foreground font-mono">{t.lines.join(" · ")}</span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ThenBadge then={p.default_action} />
                      </TableCell>
                      <TableCell className="pr-6 font-mono text-xs">
                        {p.applied.length ? p.applied.map((a) => <div key={a}>{a}</div>) : <span className="text-muted-foreground">not applied</span>}
                      </TableCell>
                    </TableRow>
                    {open === p.name && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="px-6">
                          <ConfigView text={p.text} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <CountersCard uses={counters?.uses} />
      {roleAtLeast(myRole, "operator") && <TestCard routerId={id} policies={data.policies} />}
    </>
  )
}

function CountersCard({ uses }: { uses: PolicyUseCounters[] | undefined }) {
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>Counters</CardTitle>
        <CardDescription>
          Routes each term matched at each place a policy is applied, counted by the daemon each time it runs the map
        </CardDescription>
      </CardHeader>
      {!uses ? (
        <CardContent className="pb-6">
          <Skeleton className="h-24 w-full" />
        </CardContent>
      ) : uses.length === 0 ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">No policy is applied anywhere, so there is nothing to count.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Policy / use</TableHead>
                <TableHead>Applied at</TableHead>
                <TableHead className="pr-6">Hits per term</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uses.map((u) => (
                <TableRow key={`${u.route_map}-${u.attach_point}`} className="align-top">
                  <TableCell className="pl-6">
                    <div className="font-mono font-medium">{u.policy}</div>
                    <div className="text-muted-foreground text-xs">
                      {u.attach_point} · {u.daemon} · route-map <span className="font-mono">{u.route_map}</span>
                      {u.called && " · called from a policy"}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {u.applied_at.map((a) => (
                      <div key={a}>{a}</div>
                    ))}
                  </TableCell>
                  <TableCell className="pr-6">
                    {!u.counted ? (
                      <Badge variant="outline" title="The daemon reported no such map: there is no counter, which is not the same as zero.">
                        no counter
                      </Badge>
                    ) : (
                      <div className="space-y-1">
                        {u.terms.map((t) => (
                          <div key={`${t.policy}-${t.term}`} className="flex items-center justify-between gap-4 text-xs">
                            <span className="font-mono">{t.term || "default-action"}</span>
                            {t.compiled ? (
                              <span className="font-medium tabular-nums">{formatNumber(t.hits)}</span>
                            ) : (
                              <Badge variant="outline" title="This term compiled to no clause at this use, so it can never match here.">
                                not compiled here
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}

function TestCard({ routerId, policies }: { routerId: string; policies: Policy[] }) {
  const [policy, setPolicy] = useState(policies[0]?.name ?? "")
  const [prefix, setPrefix] = useState("")
  const [at, setAt] = useState("import")
  const [rib, setRib] = useState(false)
  const [neighbor, setNeighbor] = useState("")
  const [vrf, setVrf] = useState("")
  const [attrs, setAttrs] = useState<{ k: string; v: string }[]>([{ k: "community", v: "" }])
  const [result, setResult] = useState<TestPolicyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function run(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const attributes = Object.fromEntries(attrs.filter((a) => a.k.trim() && a.v.trim()).map((a) => [a.k.trim(), a.v.trim()]))
      setResult(
        await api.post<TestPolicyResponse>(routerApi(routerId, "/policies/test"), {
          policy,
          prefix,
          attach_point: at,
          attributes: rib ? {} : attributes,
          rib,
          neighbor,
          vrf,
        }),
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConicalIcon className="size-4" /> Test a policy
        </CardTitle>
        <CardDescription>
          Simulates what a policy does with a route at a given use, as the routing daemon would run it. Nothing changes on the
          router.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {policies.length === 0 ? (
          <p className="text-muted-foreground text-sm">There is no policy to test on this router.</p>
        ) : (
          <form onSubmit={run} className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel>Policy</FieldLabel>
              <Select value={policy} onValueChange={setPolicy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {policies.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Only the policies configured on this router are listed.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Use (attach point)</FieldLabel>
              <Select value={at} onValueChange={setAt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTACH_POINTS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="tp-prefix">Prefix</FieldLabel>
              <Input id="tp-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="203.0.113.0/24" className="font-mono" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="tp-neighbor">Neighbor</FieldLabel>
              <Input id="tp-neighbor" value={neighbor} onChange={(e) => setNeighbor(e.target.value)} placeholder="optional: whose path, or where it goes" className="font-mono" />
            </Field>
            <Field className="md:col-span-2">
              <div className="flex items-center gap-3">
                <Switch checked={rib} onCheckedChange={setRib} aria-label="Read the route from the RIB" />
                <span className="text-sm">Read the route from the router&apos;s RIB instead of describing it</span>
                {rib && <Input value={vrf} onChange={(e) => setVrf(e.target.value)} placeholder="vrf (default)" className="ml-auto max-w-48 font-mono" />}
              </div>
            </Field>
            {!rib && (
              <Field className="md:col-span-2">
                <FieldLabel>Route attributes</FieldLabel>
                <div className="space-y-2">
                  {attrs.map((a, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        value={a.k}
                        onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
                        placeholder="community"
                        className="max-w-48 font-mono"
                        aria-label="Attribute"
                      />
                      <Input
                        value={a.v}
                        onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
                        placeholder="65001:10 65001:20"
                        className="font-mono"
                        aria-label="Value"
                      />
                      <Button type="button" variant="ghost" size="icon" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))} aria-label="Remove attribute">
                        <Trash2Icon />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={() => setAttrs([...attrs, { k: "", v: "" }])}>
                    <PlusIcon /> Attribute
                  </Button>
                </div>
                <FieldDescription>
                  A condition the route does not state is taken as not matching, and the result lists it under &ldquo;assumed&rdquo;.
                </FieldDescription>
              </Field>
            )}
            {error && <FieldError className="md:col-span-2">{error}</FieldError>}
            <div className="md:col-span-2">
              <Button type="submit" disabled={pending}>
                {pending && <Loader2Icon className="animate-spin" />}
                Run test
              </Button>
            </div>
          </form>
        )}

        {result && <TestResult r={result} />}
      </CardContent>
    </Card>
  )
}

function TestResult({ r }: { r: TestPolicyResponse }) {
  const keys = Array.from(new Set([...Object.keys(r.route), ...Object.keys(r.route_after)])).sort()
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "rounded-md px-2.5 py-1 text-sm font-semibold uppercase",
            r.verdict === "accept" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-destructive/15 text-destructive",
          )}
        >
          {r.verdict}
        </span>
        <span className="text-sm">
          decided by <span className="font-mono">{r.decided_by}</span>
          {r.decided_policy && (
            <>
              {" "}
              of <span className="font-mono">{r.decided_policy}</span>
            </>
          )}
        </span>
        <span className="text-muted-foreground text-xs">
          at {r.attach_point} · {r.daemon} · route-map {r.route_map}
        </span>
      </div>

      <ol className="space-y-1 text-sm">
        {r.steps.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground w-5 text-right tabular-nums">{i + 1}.</span>
            <span className="font-mono">
              {s.policy} › {s.term || "default"}
            </span>
            <Badge
              variant="outline"
              className={s.outcome === "match" ? "border-emerald-500/40" : s.outcome === "unknown" ? "border-amber-500/40" : ""}
            >
              {s.outcome}
            </Badge>
            <span className="text-muted-foreground">{s.why}</span>
          </li>
        ))}
      </ol>

      {keys.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Attribute</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>After the sets</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k}>
                <TableCell className="font-mono text-xs">{k}</TableCell>
                <TableCell className="font-mono text-xs">{r.route[k] ?? "—"}</TableCell>
                <TableCell className={cn("font-mono text-xs", r.route_after[k] !== r.route[k] && r.verdict === "accept" && "text-emerald-700 dark:text-emerald-300")}>
                  {r.verdict === "accept" ? (r.route_after[k] ?? "—") : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {(
        [
          ["Assumed", r.assumed, "The answer holds only if these are true."],
          ["Notes", r.notes, ""],
          ["Sets that change nothing here", r.said, ""],
          ["Refused at this use", r.refused, ""],
        ] as const
      )
        .filter(([, list]) => list.length > 0)
        .map(([title, list, hint]) => (
          <div key={title} className="text-sm">
            <div className="font-medium">{title}</div>
            {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
            <ul className="text-muted-foreground mt-1 list-disc pl-5">
              {list.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  )
}
