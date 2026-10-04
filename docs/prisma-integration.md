# prisma-web × Prisma: what is missing on the Prisma side

**TL;DR:** what prisma-web needs to know or receive from the Prisma to use the `prisma.v1` contract
in full. The five questions are answered, and the suggestions for new fields were accepted by the
Prisma (prismarouting #533). The API exists from 0.148.4 onwards, is enabled on the lab device, and
prisma-web already connects to it over mTLS (#4). The gaps in section 2 are suggestions for new
fields, all compatible with v1.

The key words MUST, SHOULD and MAY follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| 5W2H | |
|---|---|
| **What** | Open questions and gaps in the proto as seen by the web client. |
| **Why** | The integration was built against the proto and a mock. What the mock assumes needs to be confirmed by the Prisma. |
| **Who** | Whoever maintains the Prisma's management server. |
| **Where** | `back/proto/prisma/v1/prisma.proto` (copy) and the Prisma's gRPC server. |
| **When** | Before registering the first real device. Reviewed on 2026-10-01 with the API guide (issue #9). |
| **How** | Answer section 1. The fields in section 2 go in as additions to `prisma.v1`. |
| **How much** | 5 questions, all answered, and 6 suggestions, accepted as prismarouting #533. None requires `prisma.v2`. |

Legend: **🔴 blocks** · **🟡 can be worked around** · **🟢 suggestion**

---

## 1. Questions

Sources: **guide** is `docs/prisma-api.md`; **device** is the lab Prisma `192.0.2.166`;
**Prisma** are the answers from the session that maintains Prisma Routing, checked against the code
or the device and relayed on 2026-10-01.

### ✅ 1.1 Grammar for editing an interface — answered
Inside `interface <name>` the valid lines are `description <text>`, `no description`, `mtu <n>`,
`shutdown`, `no shutdown` and **`ipv4 address <cidr>`** (not `ip address`). Blocks close with
`exit`. The `no` forms were confirmed with `commit check` on the device, without applying anything,
and produce the expected diff in `compare` (Prisma). The mock follows this format since issue #9,
and the mapping lives in `front/src/lib/interface-config.ts` (#40).

### ✅ 1.2 Access to the device — answered
- **The API exists from 0.148.4 onwards** and ships disabled; `api enabled yes` turns it on. The
  guide said "0.149.0", which will be corrected in 0.148.5. The published 0.148.3 does **not** have
  `apiserver.py` (Prisma, confirmed by inspecting the `prisma-mgmt:0.148.3` image). In the lab,
  0.148.4 has the API **enabled** and the certificates in `/etc/prisma-routing/api/`.
- **Port 50051** on the management address. Test endpoint: `https://192.0.2.166:50051`.
- **mTLS only**: the server does not start without certificates and refuses a client without a
  certificate (guide).
- **Hostname:** 0.148.4 and 0.148.5 return an empty `hostname` in `GetVersion` and `GetSystem`.
  prisma-web takes it from the running configuration (#13). 0.148.6 fills it in directly (verified
  in the lab on 2026-10-01).
- **The account is the CN of the client certificate**, and the role comes from the VTY. The
  prisma-web certificate has CN `prisma-web`, with an administrator role (Prisma). Since 0.149.2
  `SessionService.WhoAmI` says so directly: the connection test, the router list and the router
  page show the account and role, and with a read-only login the change actions are disabled and
  the back refuses `OpenCandidate`, `Confirm` and `Save` itself (#28, closing #12). Verified on the
  lab box on 2026-10-01: `prisma-web` is `administrator`.
- **Server name in the certificate: `prisma-api`**, and the IP is also in the SAN (Prisma).
- 0.148.4 lists the internal linux_cp `tap*` interfaces in `ListInterfaces`. 0.148.5 already omits
  them (Prisma; verified in the lab on 2026-10-01), and the back's filter only has an effect on
  0.148.4.

### ✅ 1.3 `Show` and commands that take long — answered
Each call runs in the account's process, with a **300 s** limit on the server; past that time, the
response is `UNAVAILABLE`. The console's 30 s cut-off is shorter, and that is acceptable. From
0.148.5 onwards, `Show` refuses `monitor`, which redraws a terminal the call does not have. Live
counters come from `TelemetryService.Subscribe`. Each session serves **one request at a time**: a
candidate is one process, and the account's operational reads are another (guide, section *Limits
a client meets*). The effect of this on prisma-web is in issue #14. (Prisma, guide)

### ✅ 1.4 Abandoned candidates — answered
The server closes a candidate **idle for 30 min** and an account's operational process idle for
5 min. The cleanup happens on the next API call, not on a timer (Prisma). prisma-web treats a
candidate idle for 25 min, counted from its last call, as expired, and turns the box's `NOT_FOUND`
for a candidate into `candidate_expired` (410) with the reason. The configuration screen then
offers to reopen and apply the same lines again, in order (#11).

### ✅ 1.5 One account for all web users — answered
One certificate per user is the recommendation for the future, so each one appears under their own
name in the device's audit trail. To start with, the `prisma-web` account with
`[prisma-web:<user>]` in the commit comment is acceptable. `Confirm` applies to the whole account on
the device (Prisma).

### Suggestions from section 2
They were accepted by the Prisma as **prismarouting issue #533**, all as compatible additions to
`prisma.v1`. `ListRoutes` will need pagination and filtering, because a full table has about
1 million routes.

---

## 2. Gaps in the proto that limit the interface

### ✅ 2.1 CPU and memory only as text — delivered in 0.149.2, used since #25
`SystemInfo` carried only `cpu_text` and `memory_text` verbatim, with no numbers. Prisma 0.149.2
added `memory_total_bytes`, `memory_used_bytes`, `memory_hugepages_bytes` and a `WorkerLoad` per
worker (fields 17-20). The dashboard's **Dataplane load** widget and the memory card of the key
metrics use them (#25). `busy_ratio` saturates at about **0.5**, not 1 (see `docs/prisma-api.md`,
"A worker's load"), so the worker bar MUST read 0.5 as full and the raw ratio is shown beside it.
A box that reports 0 / no workers (before 0.149.2) MUST get the verbatim text, never a 0% bar.

The original suggestion, kept for the record:

Suggestion (new fields, compatible with v1):
```proto
message SystemInfo {
  // ...
  uint64 memory_total_bytes = 10;
  uint64 memory_used_bytes = 11;
  // Load of each VPP worker (vectors/call or % of loops with work),
  // since polling keeps the CPU always at 100%.
  repeated WorkerLoad worker_load = 12;
}
message WorkerLoad { uint32 cpu = 1; double vectors_per_call = 2; double busy_ratio = 3; }
```

### ✅ 2.2 Untyped route table — answered
Prisma 0.149.2 added `RouteService` (`ListRoutes`, paged from a snapshot and filtered by VRF,
family, prefix, protocol and selected; `GetRouteSummary`, RIB and FIB counts), and the Routing tab
uses it from #27 (`docs/architecture.md`, *Routing table*). The text of `show ip route` stays as
the fallback for boxes that answer `UNIMPLEMENTED`. The original suggestion was:
```proto
rpc ListRoutes(ListRoutesRequest) returns (ListRoutesResponse);
message Route {
  string vrf = 1; string prefix = 2;              // "2001:db8::/32", both families
  repeated string next_hops = 3; string protocol = 4; uint32 distance = 5; uint32 metric = 6;
  bool selected = 7;
}
```

### ✅ 2.3 Link speed — delivered in 0.149.2, used since #25
`Interface.speed_bps` (field 10) gives the link speed; the interfaces page and widget show it and
the utilization, the busier direction of the latest telemetry rate over the speed (#25). 0 means
the dataplane reports none. **4294967295000** is VPP's "unknown" (u32 max in kbps) passed on by
0.149.2; it MUST be treated as 0. With an unknown speed no percentage is shown.

### ✅ 2.4 Counter history — answered
Prisma 0.149.2 keeps 24 h at one sample a minute and serves it through
`TelemetryService.GetHistory`. On every connection prisma-web first reads what it missed (all of
it after a restart, the outage after a reconnection) and then follows the live stream, so a
restart of the back no longer empties the charts (#26, closing #7). A box without the rpc answers
`UNIMPLEMENTED` and the charts start from the live stream, as before.

### ✅ 2.5 Identifying its own commit in the events — delivered in 0.149.2, used since #30
`Event` carries `revision` and `comment` since 0.149.2. prisma-web remembers the revisions it
committed, and a `commit` event with one of them is its own echo. Any other revision is logged as a
change made on the device, even right after a web action; the box event can arrive before the
`Commit` reply, so during the 8 s window the decision waits for that reply. An empty revision
(another commit landed while the box read it) falls back to the time window.

### ✅ 2.6 Health check — answered
Prisma 0.149.2 serves `grpc.health.v1.Health`. The fleet monitor checks
`prisma.v1.OperationalService` alongside the status reads; `NOT_SERVING` (the dataplane's
statistics segment does not answer) shows as *not serving*, with the reason, instead of
*offline* (#29). A box without the service keeps the old behaviour. Verified on the lab box on
2026-10-01: `SERVING`.

---

## 3. How prisma-web uses each rpc

| rpc | Where it shows up |
|---|---|
| `GetVersion`, `GetSystem`, `GetSessionsSummary` | Fleet status (every 5 s), router dashboard |
| `ListInterfaces` | Interfaces, interfaces widget |
| `Subscribe` (counters, CGNAT, events) | Traffic and session charts; events go to the change log |
| `ListPools`, `GetSubscriber` | CGNAT screen, subscriber lookup |
| `ListBgpNeighbors`, `ListOspfNeighbors`, `ListIsisAdjacencies`, `ListVrrp`, `ListBundles` | Routing screen |
| `ListRoutes`, `GetRouteSummary` | Routing screen: route table, paged and filtered, and the RIB/FIB summary (#27) |
| `Show` | Command console (operator or admin), and route text on boxes without `RouteService` |
| `OpenCandidate` → `Edit` → `Compare` → `Check` → `Commit` → `CloseCandidate` | Configuration editor and interface editing |
| `Confirm` | Pending *commit confirmed* warning, with countdown |
| `GetRunning`, `ListRevisions`, `Rollback`, `Save` | Configuration screen |
| `GetHistory` | Fills the charts on every connection of the telemetry stream (#26) |
| `grpc.health.v1.Health/Check` | Fleet status: *not serving* when `OperationalService` is `NOT_SERVING` (#29) |
| `GetLogging`, `Subscribe` with `logging_events`, Health `prisma.v1.LogExport` | Log export card on the CGNAT tab; *log export stalled* in the fleet and on the router (#34) |
| `WhoAmI` | Account and role in the connection test, router list and router page; read-only enforcement (#28) |

## 4. Keeping the proto up to date

The proto is copied to `back/proto/prisma/v1/prisma.proto`. When it changes on the Prisma, copy it
again and run the build: the gRPC client is generated from it. By the proto's own compatibility
rules (add only), an old prisma-web keeps working with a new Prisma.

Since 0.149.6 the Prisma keeps `docs/clients.md`: per release, what changes for an API client
(contract sha256, behaviour, fields, known bugs, the lab box's version and upgrade windows).
prisma-web compares it with the release recorded below and follows every entry.

| Vendored | From prismarouting | sha256 |
|---|---|---|
| `back/proto/prisma/v1/prisma.proto` | `api/prisma/v1/prisma.proto` at v0.149.26 | `3f8ac0fc80f46252af5a36829b142201d6054af82f0ac0254993f2bd7e4268c8` |
| `docs/prisma-api.md` | `docs/api.md` at v0.149.26 | `a7b449b8fe4cfe173c6798cde4c38d9b234c6343519945ee2d4d76c20c37b40c` |
| `docs/prisma-api-coverage.md` | `docs/api-coverage.md` at v0.149.26 | `a719e26695f58c0485192998f9ec0aacd1d6f30bdf1c1e89303d2ec20e7678aa` |

0.149.23 changed none of the three; 0.149.24 (#47) and 0.149.25 (#48) change all three; 0.149.26 (#51) the proto and the coverage map.

Read up to 0.149.30 in `clients.md` and already handled:
- 0.149.3 made an unknown `speed_bps` 0; prisma-web still treats 4294967295000 as unknown for
  0.149.2 boxes (#25).
- 0.149.4: after an upgrade the API can refuse connections for a while on older boxes; the monitor
  and the telemetry stream retry forever with backoff (up to 30 s).
- 0.149.5: after a dataplane crash the box restores its configuration in about 10 s. Counters
  restart from zero (no spike, by the reset rule) and Health answers `NOT_SERVING` meanwhile, which
  the fleet shows as *not serving* (#29).
- `GetHistory` survives upgrades but **not a reboot** of the box: after one, the charts start from
  the reboot.
- A route snapshot not paged for 10 min is dropped; its token answers `FAILED_PRECONDITION` and the
  route table offers a new snapshot (#27).
- 0.149.7 (CGNAT log export no longer endangers the dataplane) changes nothing a client reads: its
  logging drop counters are only in `show cgnat logging` until the export moves to its own
  container (prismarouting #550), which `clients.md` announces before it ships.
- 0.149.8 fixes a dataplane stop: before it, committing `logging syslog disable` on a box whose
  syslog was never enabled closes the dataplane's stdin and the next operation stops it until a
  reboot, with no client-side recovery. prisma-web MUST NOT send that commit: on a box older than
  0.149.8 whose running configuration has no `logging syslog <collector>`, the back end refuses it
  (409) with the reason (#31). Only a diff carrying the line costs the extra `GetVersion` and
  `GetRunning`.
- 0.149.9 starts the dataplane again after a clean exit nobody asked for (up to five times a boot),
  like a crash since 0.149.5: the same `NOT_SERVING` window and counters from zero, already shown
  and handled.
- 0.149.10 refuses, at commit, a `cgnat identity file|dhcp-leases <path>` of 256 characters or more
  with `FAILED_PRECONDITION` naming the 255 limit. prisma-web has no form for it (the editor is free
  text), so the box's message reaches the user as a refusal. If the base also moved, the stale-base
  check (#10) answers first; the reopened change then gets the box's own refusal.
- 0.149.11 and 0.149.12 move CGNAT log export out of the dataplane (its event rings into a segment
  of their own, then the TCP streams into a `logger` container). Nothing an API client calls
  changes; only the text `Show` returns for `show cgnat logging` gains lines, and prisma-web does
  not parse it. The logging counters and a health status for the export are not in the API yet
  (prismarouting #550 announces them in `clients.md` first).
- 0.149.13 roots PRISMA-ROUTING-MIB at `.1.3.6.1.4.1.67033`, NetConfig's IANA Private Enterprise
  Number; prisma-web does not use SNMP.
- 0.149.14 sends the UDP IPFIX export from the log container too; again only the `show cgnat
  logging` text changes.
- 0.149.15 puts the CGNAT log export in the API (additions only): `GetLogging`, `log-*` events on
  `Subscribe` (`logging_events`) and the health name `prisma.v1.LogExport`. prisma-web shows it on
  the CGNAT tab, flags a stalled export in the fleet and on the router (without calling the router
  offline), and keeps the last 50 log events per router in memory, out of the change log: they are
  operational, not configuration changes (#34). A box before 0.149.15 answers `UNIMPLEMENTED` and
  the card is hidden; checked on the lab box on 0.149.14.
- 0.149.16 adds `monitor cgnat logging` to the VTY only (`Show` refuses `monitor`); `GetLogging`
  stays the API's view of the export. Nothing to change in prisma-web.
- 0.149.17 publishes `docs/api-coverage.md` (vendored here as `docs/prisma-api-coverage.md`):
  every VTY command classified as typed, text or not reachable, with the rpc that serves it, and
  the #558 phases in the order prisma-web asked for (refusal reasons, the pending commit confirmed
  and candidate lifecycle first). It is the map for what prisma-web can type next.
- 0.149.18 is phase 1 of #558, prisma-web's items 1-3: `Diagnostics.reason` on every refused
  configuration call (and `CheckResponse.reason`), `GetPendingConfirm` and the candidate lifecycle
  (`ListCandidates`, `expires_at`). prisma-web uses all three and drops its guesses where the box
  answers: stale base from the reason, expiry from `expires_at` and the reason, the pending banner
  from the box, so it survives a restart of the back (#37). Each guess stays as the fallback for a
  box before 0.149.18, such as the lab box on 0.149.14.
- 0.149.19 changes only the VTY's completion.
- 0.149.20 is phase 2 of #558: `GetSchema` (the whole configuration grammar from the VTY's own
  tree), `GetConfig`/`SetConfig`/`DeleteConfig` (interfaces, pools and log collectors as fields),
  `ValidateLines` and `TypedConfig.box_owned`. prisma-web's Settings editor takes its grammar from
  `GetSchema` when the box has it (the coverage map otherwise), shows the box's own lines read only
  with the box's reason, and checks a setting with `ValidateLines` before staging it; the 0.149.8
  guard reads `configured` from `GetConfig` (#44). The dedicated forms (#40, #41, #42/#43) still
  wrote lines through `Edit` then; #46 moved interfaces, pools and collectors to `SetConfig`.
  The coverage map also gained `<A.B.C.D|X:X::X:X>` for a value of either family.
- 0.149.21 fixes two box-side bugs. An account with no configuration role waited about 90 s for any
  read of the running configuration; prisma-web gives those reads (`GetRunning`, `GetConfig`) a
  120 s deadline, as `clients.md` asks for older boxes (#44). And `no mtu` now really returns an
  interface to the default MTU; the running configuration still names an MTU for every interface.
- 0.149.22 is phase 3 of #558 (additions only): GetConfig's routing areas (`static`, `bgp`,
  `ospf`, `ospf6`, `isis`, `interface_routing`, each block's leftovers in `other`) and typed edits
  of a static route and a BGP neighbor (`SetConfig`), removed with `DeleteConfig`. prisma-web's
  Interfaces, CGNAT and Routing forms read with GetConfig and write with SetConfig/DeleteConfig
  where the box answers GetConfig for their area, and keep their lines where it answers 501 (#46).
  Every SetConfig names its fields: an empty mask sets every field, so the back end refuses one
  (422) before it reaches the box. A BGP password is write-only: the form starts empty, sends it
  only when typed (`password` named only then, so an empty field never clears it), and no reply or
  read shows it (the back end also masks any `password <secret>` in a reply's lines). A family
  listed for a neighbor is set whole, so the form lists only the families that changed, each built
  from what the box read (a `default-originate` the form does not show is kept). A neighbor is
  removed with `DeleteConfig`, statement by statement as the box reads them, never a bare
  `no neighbor` (refused by frr-reload next to family statements there). `default_ipv4_unicast`
  decides whether a neighbor with no IPv4 `activate` line is active in IPv4 unicast. A VRF's static
  route is listed read only (`REASON_USAGE` on SetConfig: a line of its `vrf` block). OSPF and
  OSPF6 are read typed and still written as lines; IS-IS has no form.
- 0.149.23 (contract and guide unchanged) makes an `Edit` with `no neighbor X` at a `router bgp`
  path remove the neighbor and every statement naming it, and commit clean; a peer-group a member
  still names is refused (`REASON_GRAMMAR`, nothing staged, the message naming the members), and
  `no <statement>` removes it in the block of the path it is sent at. The routing forms' line
  implementation therefore removes a neighbor with a bare `no neighbor` before 0.149.20 (as always)
  and from 0.149.23, and statement by statement (families first, `remote-as` last) on 0.149.20 to
  0.149.22; a box that types BGP (0.149.22 on) gets `DeleteConfig`. The refusal of a peer-group is
  shown with the change it came from and the box's message; the mock refuses it the same way (#46).
- On 2026-10-03 the read-only checks ran against 192.0.2.198 on 0.149.22 (typed reads of every
  area, held to its running configuration) and on 192.0.2.166 on 0.149.14 (GetConfig answers 501:
  the forms keep the lines). After .198's upgrade to 0.149.24 the typed reads still pass there; the
  #45 check that every operator line matches its GetSchema failed on two lines with 0.149.24's new
  schema until #47 (below).
- 0.149.24 changes the shape of `GetSchema`: a statement's `words` are literal keywords only, and
  each `SchemaArgument` says where it stands among them (`position`, the number of words before
  it), whether keyword-led parts come in any order (`unordered`, `group`) and whether it takes
  several values to the end of the line (`many`). From a box at 0.149.24 or later prisma-web places
  each form's arguments among the words by `position` (`neighbor <address> remote-as <asn>`,
  `<prefix> next-hop <address>`); an older box's schema is read as before. It also adds
  `SetConfig` objects (`System`, `VrfDevice`) and a `KeyValue` message; the mock answers
  *unimplemented* for the new objects (#47).
- 0.149.25 (phase 5 of #558, additive) leaves nothing the VTY does out of the API's reach.
  `OperationalService.Clear` is followed (#48): the Interfaces, Routing and CGNAT screens offer the
  clears of interface counters, a BGP session (soft, soft in, soft out, hard), the OSPF process and
  an OSPF neighbor, an IS-IS adjacency and a CGNAT subscriber's sessions, each after a confirmation
  that says what it disrupts, to operators and above; `POST /api/routers/{id}/clear` records each
  one (`router.clear`), refused or not. A box has them when its `prisma.v1.SystemService` answers
  health (it came in the same release; the fleet status carries it as `system_service`); an older
  box is offered none. `TelemetryService.WatchLogging` and `SystemService` (reboot, shutdown,
  dataplane restart, upgrade) are followed below; their calls are root's on the box, so
  prisma-web's `prisma-web` account gets `PERMISSION_DENIED` for them today. The mock simulates
  `Clear` (a hard BGP clear restarts the session; a name that is not one word is
  `INVALID_ARGUMENT`; an unknown neighbor or interface `FAILED_PRECONDITION`) and the line-only
  mock stands for a box before it. 192.0.2.198 is on 0.149.25 since 2026-10-03 (with a reboot);
  no clear is sent to a real box by the tests.
- `TelemetryService.WatchLogging` (0.149.25) is followed (#49): the CGNAT screen's **Live log**
  watches the box's `monitor cgnat logging` through `GET /api/routers/{id}/logging/watch`, which
  relays the stream as Server-Sent Events (`log` with one `LogEvent` as JSON, the kind by name;
  `error` when the stream breaks; `end`). Filters are the monitor's (subscriber, public address
  with port, event, pool); a watch lasts at most 30 minutes (the box's `seconds`) and leaving the
  page cancels it. It says who had which public address, so it is an operator's and each watch is
  audited (`router.log_watch`) with its filters. `LOST` (events this reader missed) and `DELIVERY`
  (what each log stream sent) are shown as such. The mock streams allocations and releases every
  half second and a `DELIVERY` every 10 s; the line-only mock answers *unimplemented*.
- `SystemService` (0.149.25) is followed (#50): a **System** tab, an administrator's on a box that
  has it, checks for and runs an upgrade (Server-Sent Events of `UpgradeProgress` through `POST
  /api/routers/{id}/system/upgrade`, `GET` for `GetUpgradeStatus`) and sends a dataplane restart,
  a reboot or a shutdown (`POST …/system/{restart-dataplane,reboot,shutdown}`). Each asks for the
  router's name typed; an upgrade check (empty version) does not, as it changes nothing. A
  refusal is shown in the box's words with what its reason means: `REASON_UNSAVED` and
  `REASON_CONFIRM_PENDING` may then be forced (reboot, shutdown), `REASON_BUSY` says another run
  is in progress, `REASON_PERMISSION` that the box gives these to root only. The fleet status
  carries `maintenance` (what, since, until): from an upgrade's `STARTED` until
  `api_away_seconds` after its `API_RESTART` (a `FAILED` ends it), and from a reboot or shutdown
  until the box answers again a minute or more later. Every attempt is audited
  (`router.system.*`). On the box these calls are root's today, so prisma-web's account is
  refused there; granting them is the maintainer's and the user's decision. The mock without
  `MOCK_SYSTEM_DENIED` lets them run (nothing really reboots; an upgrade to `0.149.26-mock` goes
  through every phase, any other version fails with the run's output) and refuses a reboot while
  a commit is not saved; prisma-mock-2 refuses them as the real box does. `--lab` sends only
  `GetUpgradeStatus` and an upgrade check. On 2026-10-03 on 192.0.2.198 (0.149.25)
  `GetUpgradeStatus` answered `NOT_FOUND` ("no upgrade was started through the API on this box",
  read as no run), and the check was not refused to prisma-web's account: it came back `FAILED`,
  "the newest release could not be read" (the management container had no DNS; 0.149.26 reads it
  through the host).
- 0.149.26 (#563, additive) is followed (#51). `WhoAmIResponse.can_operate` says whether the
  account may run `SystemService` (root, or `operator` in its user block: `user prisma-web` /
  `role administrator` / `operator` / `exit`, committed by the box's root); `UserConfig.operator`
  reads it in GetConfig's accounts. The access badge shows *operator*; on a box that reports it
  (0.149.26 on) without it, the System tab shows that grant instead of the actions, keeping the
  upgrade check, which is every account's since 0.149.26. A grant reached the API only after the
  API restarted on 0.149.26 (prismarouting #565); from 0.149.27 a role or `operator` change
  reaches it at once (revoked and re-granted on 192.0.2.198, `can_operate` followed), and a
  candidate opened before it is closed and answers `CANDIDATE_EXPIRED`, which prisma-web shows as
  an expired change (#11).
- **A dataplane restart through the API is refused on 0.149.25 to 0.149.31** (#51, #53-#56): the
  containers' stop fails early and the restart script gives up without starting them again, and
  every client connection meanwhile counts against the API socket's trigger limit, which keeps
  the API down even after (prismarouting #564). 0.149.27 runs the restart as a host unit of its
  own and resets the socket, but on 192.0.2.198 on 2026-10-04 the host refused to start that
  unit ("could not be started the host's door"), safely (#53). 0.149.28 lets it through the door,
  but on 192.0.2.166 (upgraded from 0.149.14 with a reboot, `operator` granted) the call hung
  for its 180 s deadline without reaching the host (`/run/prisma-routing/api/` missing); the box
  stayed up and prisma-web's monitor, polling every 5 s with a telemetry stream, never lost its
  API (76 of 76 polls answered) (#54). 0.149.29 makes a detached action fail at once with its
  reason (`FAILED_PRECONDITION`, `apply_failed`) when it writes nothing in 20 s; on .166 the
  restart failed so, "the host would not start it" (the host's door refuses the API's command),
  the dataplane untouched (#55); that refusal came from the old API still running against the
  new door during the upgrade. On 0.149.30, on .166 once its API was on 0.149.30 too, the restart
  ran end to end and the API socket came back, but the dataplane came up with its interfaces
  renamed (`eth0`, `eth1`, `eth2`: the restart stopped the boot tuner that names the cards and
  did not run it again), the saved configuration was refused, and the box, managed through the
  dataplane, went dark until its VM was reset. Fixed as 0.149.32 (0.149.31 only cleans up
  tests): prisma-web offers the restart from there (`RESTART_FIXED`), raised again if a lab box
  shows otherwise (#56). On 2026-10-04 one on
  192.0.2.198, whose management address is on a dataplane interface (ens18), took it off the
  network until a VM reboot. Since #52 the monitor leaves a box in maintenance alone: no call
  before the `until` the box gave, otherwise a probe at most every 15 s growing to 60 s, and no
  telemetry stream until it is out. The back answers 409 before calling the box, and the page says
  why. A restart that loses the connection on any release (`Unavailable`, "Socket closed")
  leaves the box in maintenance (`dataplane`) until it answers again, and its audit entry
  records `connection_lost`; the confirmation says a box with its management on the dataplane
  drops off the network. The mock reports `can_operate`; prisma-mock-2 is a 0.149.26 box
  (`MOCK_RELEASE`) whose account has no `operator`, and `mock restart-dataplane drops` makes the
  next restart lose the connection. prisma-web sends no power action or upgrade to a real box.
- The lab box was on 0.149.13 from 2026-10-02 (upgraded from 0.149.4 with a reboot). The read-only
  checks (`scripts/e2e.py --lab`) pass there, the history included: after the reboot it only holds
  samples since then, as `clients.md` says for 0.149.2.
