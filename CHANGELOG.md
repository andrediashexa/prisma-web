# Changelog

**TL;DR:** what changed in each version of prisma-web, newest first, with the issues closed. Within
each version, behaviour changes come first, then fixes, and internal work last. Versions follow
`0.x.y` and each one has a name (see `CONTRIBUTING.md`, section 5): minor versions are published as
a release, and patch versions as a pre-release. Release names published before 2026-10-01 are in
Portuguese and are kept as published (issue #15).

| 5W2H | |
|---|---|
| **What** | The history of the releases. |
| **Why** | Whoever upgrades needs to know what changes for them, not the list of commits. |
| **Who** | Whoever operates or upgrades prisma-web. |
| **Where** | Each version has a tag `X.Y.Z` and a release `X.Y.Z - <name>` on GitHub, with the same text. |
| **When** | One entry per merge into `master`. |
| **How** | Written by hand from the issues, never generated from the commits. |
| **How much** | One section per version. |

## 0.15.0 - Interface forms — 2026-10-03

### New
- **Interfaces:** one form per port and per bundle: description, MTU, enabled, IPv4 and IPv6 addresses side by side, VRF, CGNAT side, uRPF, router advertisements, VLAN, Linux name and MAC; for a bundle its member ports, LACP mode and rate, and load balancing. A new bundle can be created. The form shows the exact lines it will send, and wrong addresses (family, network or broadcast, overlap with another interface in the VRF, duplicates) are refused before anything is sent. Changes go through the usual review (#40).

### Changed
- The Settings page opens straight on one instance (`?at=`), so the interface form links there for the statements it does not show (#40).
- The MTU in the form stays 1280-9216, IPv6's minimum, although the VTY's grammar accepts from 576 (#40).

## 0.14.0 - Settings — 2026-10-03

### New
- **Settings** tab per router: every part of the configuration (system, interfaces, CGNAT and its pools, BGP, OSPF, IS-IS, static routes, RPKI, policies, route-maps, users, SNMP) is listed with what is set, and every setting can be added, changed or removed through a form generated from the VTY's own grammar, with values checked by type before anything is sent. Changes accumulate and go through the usual review: diff, check, gates and commit confirmed (#39).

### Internal
- The VTY's grammar is extracted from the vendored Prisma coverage map (`scripts/config-grammar.py`); the configuration is read as a tree and each line matched to its statement. 26 of 29 lines of the lab box's configuration match; the other three are box-owned and read-only (#39).

## 0.13.0 - Commit facts from the box — 2026-10-03

### New
- The configuration editor shows when Prisma closes the change if it is left idle (Prisma 0.149.18 or newer) (#37).
- The pending commit-confirmed banner warns when the deadline has passed and the box failed to roll back (#37).

### Fixed
- The pending commit-confirmed banner no longer disappears when the back end restarts during the window: it is read from the box (Prisma 0.149.18 or newer) (#37).
- A candidate the box does not know (closed elsewhere) is no longer reported as expired (#37).

### Internal
- Client regenerated from the Prisma 0.149.18 contract (additions only). Refusal reasons, the candidate expiry and the pending window come from the box; the previous rules remain for older boxes (#37).

## 0.12.1 - Prisma API coverage — 2026-10-03

### Internal
- Prisma 0.149.17 is followed: the guide is re-vendored and the Prisma's API coverage map (which VTY command the API reaches, and how) is vendored as `docs/prisma-api-coverage.md`. The contract is unchanged (#36).

## 0.12.0 - Plaintext opt-in — 2026-10-02

### Changed
- Plain `http://` (gRPC without TLS) is accepted only with `PRISMA_ALLOW_PLAINTEXT=true`, which `.env.example` sets for the simulated Prismas. A real Prisma only speaks mTLS. With it off, an `http://` address is refused with what to do instead, and an `http://` router already registered is shown offline with the reason. **Upgrading an install that uses the mocks:** add `PRISMA_ALLOW_PLAINTEXT=true` to `.env` (#35).

### Fixed
- A router that cannot be dialled (plaintext refused, a TLS profile gone) no longer makes the whole fleet status fail; it is listed with the reason (#35).
- The README gave `http://` for the second simulated Prisma; it is `https://` with the `dev/mock` profile (#35).

### Internal
- Prisma 0.149.16 is recorded in the integration notes: contract and guide unchanged; `monitor cgnat logging` is VTY only (#35).

## 0.11.0 - CGNAT log export — 2026-10-02

### New
- **Log export** card on the CGNAT tab (Prisma 0.149.15 or newer): syslog and IPFIX over TCP and UDP, who carries each stream, its collector and connection, whether it is delivering and why not, records and their rate, what was sent, the backlog and spill against its cap, drops, the box-wide counters and the recent log export events (#34).
- A stalled log export is flagged in the fleet and on the router page, apart from the router's own state (#34).

### Internal
- Client regenerated from the Prisma 0.149.15 contract (additions only). The simulated Prisma implements the log export, with a stall hook. Log export events are kept per router and do not go to the change log. `--lab` no longer fails its history check right after the box reboots (#34).

## 0.10.0 - Per-router access — 2026-10-02

### New
- **Router access** on the Users screen: an administrator can change a user's role on one router, up or down, or hide that router from them. With no change, the global role applies everywhere, as before. A hidden router disappears for that user from the fleet, the menus, its pages and the change log. Granting and revoking are logged (#6).

### Changed
- Editing or removing a router's registration requires the global administrator role; a per-router grant never gives it (#6).
- The router screens (configuration, interfaces, console, policy test) follow the user's role on that router (#6).

### Internal
- Migration `0005_router_access`. `scripts/e2e.py` has 121 checks and the browser tests 8. Prisma 0.149.14 is recorded in the integration notes (#6).

## 0.9.2 - Prisma 0.149.13 notes — 2026-10-02

### Internal
- Prisma 0.149.11 to 0.149.13 are recorded in the integration notes: contract and guide unchanged, nothing to change in prisma-web. The read-only lab checks pass against the lab box on 0.149.13 (#33).

## 0.9.1 - Prisma 0.149.10 notes — 2026-10-02

### Internal
- Prisma 0.149.9 and 0.149.10 are recorded in the integration notes: contract and guide unchanged, and nothing to change in prisma-web (#32).

## 0.9.0 - Reopen on a moved base — 2026-10-02

### New
- When a commit is refused because the router's configuration changed since the change was opened (another operator, someone at the prompt), the review offers **Reopen and apply again**: a new change on the current configuration with the same edits applied again, and a new review of the new diff. Nothing is committed on the way, and a line the new configuration refuses is shown like any refusal, with its lines back in the form. The interfaces page does the same for its edits (#10).

### Changed
- Such a commit answers 409 `candidate_stale` instead of the box's generic refusal (#10).

### Fixed
- The review dialog starts clean for every change instead of keeping the previous one's error and acknowledgements (#10).

## 0.8.3 - Syslog disable guard — 2026-10-02

### Fixed
- On a Prisma older than 0.149.8, a commit that disables a syslog that was never enabled is refused with the reason: on those boxes it stops the dataplane until a reboot (prismarouting #551). It goes through on 0.149.8 or newer, or when a syslog collector is configured (#31).

### Internal
- Prisma 0.149.8 is recorded in the integration notes; contract and guide unchanged (#31).

## 0.8.2 - Browser tests — 2026-10-02

### Internal
- Browser tests of the front end with Playwright (`scripts/ui-tests.sh`): gates keep Apply disabled, a VTY refusal shows its path and line, the pending-commit banner counts down and goes away, the Pools table is drawn, and the home page keeps its layout after a reload. Each test was shown to fail with its behaviour removed (#5).
- Prisma 0.149.7 is recorded in the integration notes: contract and guide unchanged, and its new logging counters are not in the API yet (#30).

## 0.8.1 - Prisma 0.149.6 notes — 2026-10-01

### Fixed
- A configuration commit made on the device right after an action through the web is logged again. The web's own commit is now recognised by its revision, not only by an 8 s window that swallowed both (#30).

### Internal
- Follows Prisma 0.149.6: the API guide is re-vendored, and `docs/prisma-integration.md` records the vendored release and what the Prisma's new `docs/clients.md` says up to 0.149.6. The contract is unchanged (#30).

## 0.8.0 - Prisma 0.149 screens — 2026-10-01

### New
- Router dashboard: memory (used, total, hugepages) and a **Dataplane load** widget with one bar per worker, full at 0.5 busy (VPP's saturation), plus vectors per call and loops per second. Also available on the homepage (#25).
- Interfaces: link speed and utilization. An unknown speed (0, or VPP's 4294967295000) shows no percentage (#25).
- Charts keep their past across restarts: on every connection the back end fills the series from the box's own 24 h history, then follows the live stream (#26, closes #7).
- **Routing** tab: a typed route table with prefix search, VRF, family and protocol filters, selected-only, server-side paging and the snapshot time, plus a RIB/FIB summary per protocol. Older boxes keep the text view (#27).
- The account and role each Prisma gives prisma-web are shown in the connection test, the router list and the router page. With a read-only login the change actions are disabled and the back end refuses the changes itself (#28, closes #12).
- The fleet monitor uses the standard gRPC health check: a box whose dataplane statistics do not answer shows as **not serving** with the reason, not as offline (#29).

### Changed
- A candidate idle for 25 minutes (from its last action, under the box's 30) is expired, and a candidate the box already closed answers with that reason instead of "not found". The configuration screen offers to reopen and apply the same lines again (#11).
- An rpc an older box does not implement answers 501 `router_unimplemented` instead of 502 (#27).

### Internal
- The simulated Prisma implements GetHistory, RouteService, WhoAmI (role from the client certificate's CN), the health service and idle candidate expiry. New dev profile `dev/readonly`. `scripts/e2e.py` has 97 checks and `--lab` 21, passed against the lab box on Prisma 0.149.4 (#24).

## 0.7.2 - Prisma 0.149.2 contract — 2026-10-01

### Internal
- Client regenerated from the Prisma 0.149.2 contract: memory and worker load, link speed, commit revision in events, telemetry history, routes, account role and the standard health check. No screen uses them yet (#23).
- A field added to an existing Prisma message no longer breaks the build. Every message built in the back end and the simulated Prisma leaves new fields at their default (#23).
- Fixed after 0.7.1 without a release of its own: the documentation records that Prisma 0.148.13 lifted the `then reject` + `from policy` limit.

## 0.7.1 - Default gRPC stubs — 2026-10-01

### Internal
- An rpc that the simulated Prisma does not implement now answers `UNIMPLEMENTED`; before, any new rpc in an existing Prisma service broke the build. This lets prisma.v1 keep its services grouped by domain (#22).

## 0.7.0 - Routing policies — 2026-10-01

### New
- **Policies** tab per router: every routing policy with its terms, default action, where it is applied and its VTY text (#21).
- Per-term counters at each place a policy is applied. "no counter" is shown apart from 0, and a term that compiles to nothing at a use is marked (#21).
- Policy test: simulate a policy on a described route, or on one read from the router's RIB, at a given attach point. It shows the verdict, the deciding term, every step and the route before and after the sets. Needs Prisma 0.148.12 or newer (#21).

### Internal
- Client regenerated from the Prisma 0.148.12 contract (three new read-only rpcs). The mock implements them. `scripts/e2e.py` has 63 checks, and `--lab` has 14 checks, passed against the 0.148.12 lab box (#21).

### Limits
- A `then reject` term with `from policy X` rejects more than X accepts on the Prisma until 0.148.13 (Prisma #542); prisma-web shows what the box answers (#21).

## 0.6.0 - Uptime breakdown — 2026-10-01

### New
- Uptime card per router: since when the box, the dataplane, the routing daemons and the management container run, why the box last booted (as recorded by the box) and when the running release was installed. Needs Prisma 0.148.7 or newer (#20).
- Warning when the dataplane restarted by itself after the box booted, in the router dashboard and in the fleet: every session it carried was dropped (#20).

### Internal
- Client regenerated from the Prisma 0.148.7 contract (additions only); unset timestamps reach the UI as `null` and are shown as "unknown" (#20).
- `prisma-mock-2` simulates a dataplane restart (`MOCK_DATAPLANE_RESTARTED=1`). `scripts/e2e.py` has 55 checks, and `--lab` has 12 checks, passed against the 0.148.7 lab box (#20).

## 0.5.0 - English — 2026-10-01

### Behaviour changes
- prisma-web is now written in **English**: every screen, message, error and toast, the documentation and the source comments. Dates and numbers are formatted as en-US (#15, #16, #17, #18, #19).
- Error messages returned by the API are in English. Clients that matched the Portuguese texts need to match the new ones (#17).
- `docs/arquitetura.md` and `docs/prisma-integracao.md` are now `docs/architecture.md` and `docs/prisma-integration.md` (#19).
- The simulated Prismas are now named `prisma-hq` and `prisma-branch`, and the development TLS profiles `dev/other-ca` and `dev/intruder` (#17).

### Internal
- `scripts/check-docs.py` enforces English in every `*.md` file and source comment; tool-generated files have their own exception block in CONTRIBUTING (#16).
- Fixed after the 0.4.2 release, without a release of their own: the Prisma 0.148.6 behaviour (hostname filled directly; `Show` no longer blocks the reads, measured on the lab box) is recorded in the documentation.

### Limits
- Issues #1–#14, the releases published before this one and their names stay in Portuguese, as historical record. So do the comments of SQL migrations already applied, which sqlx checksums, and the audit rows written before the change (#15, #17).

## 0.4.2 - Console sem falso offline — 2026-10-01

### Fixed
- A long-running console command, such as `ping` or `traceroute`, made the router appear **offline** on Prisma 0.148.4 and 0.148.5, which serve one call at a time per account. It now appears as **busy (console)**, with the latest data (#14).

### Internal
- The simulated Prisma reproduces the one-call-at-a-time lock and a `ping` with `count` that really takes time (#14).
- Proto and API guide updated to Prisma 0.148.5, which only changes comments. The lab on 0.148.5 passed `--lab` (`fix/proto-0.148.5`).

## 0.4.1 - Hostname do Prisma — 2026-10-01

### Fixed
- The name of Prisma 0.148.4 routers was shown empty: their API returns an empty hostname (a Prisma bug, fixed in 0.148.6). prisma-web now takes the name from the running configuration, read at most every 10 min (#13).
- "Restart pending" now reads "reboot pending to finish the upgrade" and explains that the dataplane only switches version on reboot (#13).

## 0.4.0 - mTLS com o Prisma real — 2026-10-01

### Behaviour changes
- prisma-web connects to a real Prisma over **mTLS**. Each router chooses a TLS profile (a host certificate directory, mounted read-only) and the server name in the certificate. The connection test shows the account (CN) used (#4).
- `https://` requires a TLS profile, and `http://` is only for the simulated ones (#4).
- `prisma-mock-2` now requires mTLS like the device. The development certificates are generated by the `dev-certs` service (#4).
- The internal `tap*` interfaces that Prisma 0.148.4 lists are hidden until 0.148.5 (#4).
- The traffic chart starts on an interface with link (#4).

### Fixed
- The documentation said the Prisma API existed in 0.148.3, from a reading taken in the middle of an upgrade. It exists from 0.148.4 onwards (`fix/api-desde-0.148.4`).
- The Prisma team's answers to the integration questions were recorded in `docs/prisma-integration.md` (`fix/api-desde-0.148.4`).

### Internal
- `scripts/e2e.py`: 49 checks, including the mTLS refusal cases, and the read-only `--lab` mode for a real Prisma (10 checks passed against 0.148.4) (#4).

### Limits
- Replacing or adding certificates requires access to the host, not to the screen (#4).

## 0.3.1 - Guia da API do Prisma — 2026-10-01

### Behaviour changes
- The simulated Prisma prints and accepts interface configuration the way the real device does: `ipv4 address` (no longer `ip address`), `shutdown` before `mtu`, and the block closed with `exit` (#9).

### Fixed
- The README said a real Prisma could be registered with `http://`. The API guide shows that the Prisma server only accepts mTLS, so that only works after #4 (#9).

### Internal
- Official API guide (`docs/prisma-api.md`) and newest proto copied without changes. The generated code is identical to the previous one (#9).
- Questions to the Prisma answered, with the source of each answer, in `docs/prisma-integration.md` (#9).
- Version format: tag `X.Y.Z`, release `X.Y.Z - name`, patch as a pre-release and major forbidden. Previous tags and releases migrated (#8).

## 0.3.0 - Integração gRPC — 2026-10-01

### Breaking changes
- prisma-web now talks to the Prisma **only over gRPC** (`prisma.v1`). The JSON contract and the access token no longer exist. Routers already registered need the gRPC address (`http://host:50051`), and `https://` is refused until mTLS exists (#4) (#3).

### New
- Changes through the VTY model: candidate, diff, `commit check`, explicit confirmation of the `remap`/`cutoff`/`diverge` gates and `commit confirmed` with a warning and countdown. The Prisma undoes the change by itself if nobody confirms (#3).
- VTY refusals are shown with the message, the path and the line cited (#3).
- New per-router screens: Configuration (running, revisions, rollback, editor, save for boot), CGNAT (pools and subscriber lookup), Routing (BGP, OSPF, IS-IS, VRRP, bundles and routes) and Console (#3).
- Traffic and CGNAT charts fed by the Prisma's telemetry. The new widgets are CGNAT and BGP neighbors (#3).
- The change log stores the diff of each commit, the confirmations, the console commands and the device's own events, such as the automatic rollback (#3).
- The comment of every commit carries `[prisma-web:<user>]` for the device's audit trail (#3).

### Fixed
- The Pools table was hidden on the CGNAT screen by a layout problem (#3).

### Internal
- gRPC client generated from the proto with protox, without `protoc`. gRPC mock of the three services (#3).
- `scripts/e2e.py` (40 checks through the API) and `scripts/check-docs.py` (CONTRIBUTING rules) (#3).
- Adoption of CONTRIBUTING: documentation, issues and releases. Versions 0.1.0 and 0.2.0 were recorded retroactively (#1, #2, #3).

### Limits
- No TLS/mTLS (#4). The chart history lives in memory and resets when the back restarts (#7). Roles apply to all routers (#6).

## 0.2.0 - Vários Prismas e homepage — 2026-10-01

### New
- Several Prismas: registration with a connection test, fleet status cached (from ~3 s to 4–7 ms with one router offline) and a change log per router (#2).
- Widget homepage, saved per user (#2).

### Limits
- Roles apply to all routers.

## 0.1.0 - Estrutura inicial — 2026-09-30

### New
- First version: separate containers (proxy, front, back, db, mock), IPv4 and IPv6 access, local accounts with Argon2id, change log, dashboard with charts (#1).
