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
and the mapping lives in `front/src/lib/vty.ts`.

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
| `back/proto/prisma/v1/prisma.proto` | `api/prisma/v1/prisma.proto` at v0.149.8 | `269fb5c94a754c7c44719c6983a58860e69fbbc9bcff8abce58f26aaace3106f` |
| `docs/prisma-api.md` | `docs/api.md` at v0.149.8 | `4a30bfdc49379463d72f5c58467a7de78226e08afcdca827d932704120b1a857` |

Read up to 0.149.8 in `clients.md` and already handled:
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
