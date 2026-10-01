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
