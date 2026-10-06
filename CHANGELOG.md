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

## 0.34.0 - Pool prefix-lists — 2026-10-06

### Added
- On a router with Prisma 0.151.12 or newer, each side of a CGNAT pool can be given by one of the router's prefix-lists instead of prefixes: the pool form offers the lists, and switching a side stages the removal of the other way. The pools table shows a side's list, the prefixes it resolved to, the sources it leaves untranslated and the public addresses it excludes (#73).

### Internal
- Client regenerated from the Prisma 0.151.12 contract, and the built-in grammar from its coverage map; integration notes read up to 0.151.12 (0.151.10 and 0.151.11 change nothing for prisma-web). The simulated Prisma keeps prefix-lists, resolves a pool's lists and refuses what the router refuses (#73).

## 0.33.2 - Listen address lists — 2026-10-06

### Fixed
- On a router with Prisma 0.151.8 or newer, `api listen-address` and `snmp listen-address` with several addresses (IPv4 and IPv6) match their statements on the configuration screen, and the statement's form takes a list, each value checked as an address (#72).

### Internal
- The front has unit tests of its libraries (`npm test`, `node:test`, no dependency). Integration notes read up to Prisma 0.151.9 (0.151.6 to 0.151.9 change nothing through the API) (#72).

## 0.33.1 - Blackhole next hops — 2026-10-05

### Fixed
- A static route to `blackhole`, `Null0`, `reject` or an interface matches its statement on the configuration screen, and the statement's form takes such a next hop: the router's schema calls the next hop an address, though it takes all of these (#71).
- On a router with Prisma 0.151.5, `bgp router-id`, `network` and the other statements of a BGP level that the router describes in more than one part match their statements again on the configuration screen (#71).

## 0.33.0 - Pending configuration — 2026-10-05

### Added
- On a router with Prisma 0.151.5 or newer, a saved configuration the router applied only in part at boot, a card being missing, shows on the router page: the missing cards, the statements left out and since when, with saving refused meanwhile. An operator can give the statements up from there, through a confirmation. The fleet status carries the configuration's health (#70).

### Fixed
- The integration notes' paragraph on dataplane restarts had been split by a later insertion; it is whole again (#70).

### Internal
- Client regenerated from the Prisma 0.151.5 contract; integration notes read up to 0.151.5 (0.151.3 and 0.151.4 change nothing through the API). The simulated Prisma can leave part of its configuration pending (`mock pending on|off`), refuses `save` meanwhile, and gives it up on `clear configuration pending` (#70).

## 0.32.0 - Third-party SFP+ — 2026-10-05

### Added
- On a router with Prisma 0.151.2 or newer, the Interfaces tab shows whether SFP+ modules the network driver does not list are allowed, as configured and as the router booted, says when the next boot will change it, and stages allowing or refusing them for the review (#69).

### Internal
- Client regenerated from the Prisma 0.151.2 contract; integration notes read up to 0.151.2 (0.151.1 changes nothing through the API). The simulated Prisma reports the setting and boots with it (#69).

## 0.31.0 - NAT64 hierarchy — 2026-10-05

### Changed
- On a router with Prisma 0.151.0 or newer, NAT64 pools are their own hierarchy, `nat > nat64`: the CGNAT tab lists them (marked NAT64) beside the CGNAT pools, creates a pool with IPv6 inside prefixes there, and removes it from there. A pool stays CGNAT or NAT64: turning one into the other is refused in the form; add a new pool instead (#68).
- The pool mode `dynamic` is `bpa` from Prisma 0.151.0; the form offers "BPA (dynamic)" there, and "Dynamic" on older routers (#68).
- Routers on Prisma 0.150.x keep working as before (#68).

### Internal
- Client regenerated from the Prisma 0.151.0 contract (breaking); integration notes read up to 0.151.0. The shape is chosen by the router's grammar. The simulated Prisma follows 0.151.0 (#68).

## 0.30.0 - BFD configuration — 2026-10-05

### Added
- On a router with Prisma 0.150.12 or newer, the Routing tab adds, edits and removes BFD sessions (peer, interface or local address, multi-hop, VRF, profile, timers) and BFD timer profiles, each staged and reviewed like every change (#67).

### Changed
- A static route's BFD (and a BGP neighbor's BFD profile) is read from the router's typed fields from Prisma 0.150.12 on (#67).

### Internal
- Client regenerated from the Prisma 0.150.12 contract; integration notes read up to 0.150.12 (0.150.11 fixes BFD over SNMP), with the breaking change the next Prisma release announces (NAT64 to its own area, `mode dynamic` to `mode bpa`). The simulated Prisma serves and takes the `bfd` area (#67).

## 0.29.0 - BFD live — 2026-10-05

### Added
- On a router with Prisma 0.150.10 or newer, the Routing tab shows the BFD sessions with their state, time in it, timers and counters, kept live: a session that goes down or comes back is redrawn as it happens and listed with the time (#66).

### Internal
- Client regenerated from the Prisma 0.150.10 contract; integration notes read up to 0.150.10 (0.150.9 fixes removing BFD). `GET /api/routers/{id}/bfd/watch` relays `WatchBfd` as Server-Sent Events, opened at once even while the router has nothing to report. The simulated Prisma answers both BFD calls (#66).

## 0.28.1 - BFD statements — 2026-10-05

### Changed
- The Settings editor knows Prisma 0.150.8's BFD statements (the `bfd` block, `neighbor X bfd profile`, `bfd` on a static route) on a router that does not serve its own grammar; through the API they are lines for now (#65).

### Internal
- Integration notes read up to Prisma 0.150.8 (contract unchanged), with the known bug that a committed BFD configuration cannot be removed yet (prismarouting #570) (#65).

## 0.28.0 - Probes and screens — 2026-10-04

### Added
- On a router with Prisma 0.150.6 or newer:
  - The console page runs ping, traceroute and mtr from the router, a line at a time, with the summary at the end; stopping or leaving the page stops the probe. Probes are an operator's and recorded with the console's commands (#64).
  - The Routing tab shows the OSPF interfaces (marking an MTU that differs from the dataplane's, which keeps an adjacency from forming), the IS-IS circuits and how each routing daemon logs (#64).
  - The Interfaces tab shows the network cards the host has, those the dataplane holds and the one the default route leaves by, and downloads the router's MIB and a Zabbix 7.0 template with its enterprise number (#64).

### Internal
- Client regenerated from the Prisma 0.150.6 contract; integration notes read up to 0.150.6 (0.150.4 and 0.150.5 change nothing through the API). The simulated Prisma answers the new screens and probes (#64).

## 0.27.0 - CGNAT diagnostics — 2026-10-04

### Added
- On a router with Prisma 0.150.3 or newer, the CGNAT tab has a **Diagnostics** card: which subscriber used a public address and port (an operator's, recorded in the audit log), the fullest subscribers, the port blocks per worker, the drops, the CGNAT memory, the ALGs and port forwards of each pool, the identity file and RADIUS, HA and the history file's verification. Each shows its main figures and the router's own screen (#63).

### Changed
- On Prisma 0.150.3, which fixes 0.150.2's typed interface writes, the interface form writes typed again (#63).

### Internal
- Client regenerated from the Prisma 0.150.3 contract; integration notes read up to 0.150.3. The simulated Prisma answers the ten new screens (#63).

## 0.26.1 - Interfaces as lines on 0.150.2 — 2026-10-04

### Fixed
- On Prisma 0.150.2, whose typed interface writes always fail on the router, the interface form and the shutdown toggle write lines instead; reads stay typed (#62).

## 0.26.0 - PREF64 — 2026-10-04

### Added
- On a router with Prisma 0.150.2 or newer, the interface form lists the NAT64 prefixes its router advertisements carry (PREF64, `ipv6 nd nat64`), so a subscriber's CLAT learns the NAT64 prefix. They are offered while advertisements are sent, and the router's refusals (no advertisements, a prefix no NAT64 pool translates) are shown in its words (#61).

### Fixed
- The interface form read `ipv6 nd suppress-ra` from the configuration lines again: on routers without the typed configuration it always showed advertisements as sent (#61).

### Internal
- Client regenerated from the Prisma 0.150.2 contract; integration notes read up to 0.150.2. The simulated Prisma takes and refuses PREF64 as the router does (#61).

## 0.25.1 - FTP64 — 2026-10-04

### Changed
- A NAT64 pool offers the FTP application gateway, which Prisma 0.150.1 takes through NAT64; the other gateways stay hidden on one, as the router refuses them (#60).

### Internal
- Integration notes read up to Prisma 0.150.1 (contract unchanged). The simulated Prisma takes FTP on a NAT64 pool (#60).

## 0.25.0 - NAT64 — 2026-10-04

### Added
- On a router with Prisma 0.150.0 or newer, the pool form takes IPv6 inside prefixes, which make a NAT64 pool: it then asks for the prefix length each subscriber gets and the NAT64 prefix (empty is the well-known `64:ff9b::/96`), and offers no application gateway, which the router refuses on one. Changing the subscriber prefix length warns of the remap, as the block size does (#59).
- The live log filters a NAT64 subscriber by any address in its delegated prefix and shows the prefix (#59).

### Internal
- Client regenerated from the Prisma 0.150.0 contract; integration notes read up to 0.150.0. The simulated Prisma takes NAT64 pools and refuses an ALG or a bypass on one (#59).

## 0.24.7 - Restart's four minutes — 2026-10-04

### Fixed
- A dataplane restart gets the time Prisma 0.149.33 takes to confirm it (up to about four minutes; prisma-web waits 310 s), and one that runs past that shows the router as in maintenance instead of as a failure (#58).

### Internal
- Integration notes read up to Prisma 0.149.33 (contract unchanged): the restart measured working end to end on 192.0.2.166 (#58).

## 0.24.6 - Restart as maintenance — 2026-10-04

### Fixed
- A dataplane restart that ran puts the router in maintenance until it answers again, whatever the router replied: up to Prisma 0.149.32 a restart that worked can answer `apply_failed` or lose the connection before the router has finished starting. Such a reply is now worded as "wait for it", not as a plain failure (#57).

### Internal
- Integration notes read up to Prisma 0.149.32 (contract unchanged), with the restart measured working on 192.0.2.166 (#57).

## 0.24.5 - Restart guarded through 0.149.31 — 2026-10-04

### Fixed
- The dataplane restart is refused on Prisma 0.149.30 and 0.149.31: on 192.0.2.166 it brought the dataplane up with its interfaces renamed, the saved configuration was refused and the router, managed through its dataplane, went off the network. 0.24.4 offered it there; it is offered from 0.149.32 (#56).

### Internal
- Integration notes read up to Prisma 0.149.30 (contract unchanged) (#56).

## 0.24.4 - Restart held again — 2026-10-04

### Fixed
- The dataplane restart stays refused on Prisma 0.149.29, whose restart fails at once on the router without running (measured on 192.0.2.166); it is offered from 0.149.30 (#55).

### Internal
- Integration notes read up to Prisma 0.149.29 (contract unchanged) (#55).

## 0.24.3 - Restart still held — 2026-10-04

### Fixed
- The dataplane restart stays refused on Prisma 0.149.28, whose restart never starts on the router (measured on 192.0.2.166); it is offered from 0.149.29 (#54).

### Internal
- Integration notes read up to Prisma 0.149.28 (contract unchanged), with the measurement: prisma-web's monitoring never lost the router's API during the attempt (#54).

## 0.24.2 - Restart held — 2026-10-04

### Fixed
- The dataplane restart stays refused on Prisma 0.149.27, which refuses it on the router (prismarouting #564); it is offered from 0.149.28 (#53).

### Internal
- Integration notes read up to Prisma 0.149.27 (contract unchanged): role and `operator` changes reach the router's API at once (#53).

## 0.24.1 - Quiet maintenance — 2026-10-04

### Fixed
- prisma-web leaves a router in maintenance alone: nothing before the time the router said it would be back, otherwise a check every 15 s growing to 60 s, and no telemetry stream until it is out. Calling it every 5 s during a restart could keep the API of Prisma 0.149.25 and 0.149.26 down (prismarouting #564) (#52).

## 0.24.0 - Operator — 2026-10-04

### Added
- On a router with Prisma 0.149.26 or newer, the router's access badge says whether prisma-web's account is an **operator** (it may upgrade, reboot, shut down and restart the dataplane). Where it is not, the System tab shows how the router's administrator grants it instead of the actions; checking for a release stays available to every account (#51).

### Fixed
- A dataplane restart is refused on Prisma 0.149.25 and 0.149.26, which stop the dataplane and never start it again (prismarouting #564). Its confirmation now says that a router whose management address is on a dataplane interface drops off the network, and a restart that loses the connection shows the router as in maintenance until it answers again (#51).

### Internal
- Client regenerated from the Prisma 0.149.26 contract; integration notes read up to 0.149.26. The simulated Prisma reports `can_operate`; the one with mTLS is a 0.149.26 router without `operator` (#51).

## 0.23.0 - System — 2026-10-03

### Added
- On a router with Prisma 0.149.25 or newer, administrators have a **System** tab: check for a release and upgrade to it, following each phase as it happens, and restart the dataplane, reboot or shut the router down. Each asks for the router's name; a refusal is shown in the router's words with what it means, and an unsaved configuration or a pending commit confirmed can be overridden. Every attempt is recorded in the audit log (#50).
- The router shows as **in maintenance** from an upgrade's start until its API is back, and after a reboot or a shutdown until it answers again (#50).
- These calls are root's on the router today, so the router may refuse them to prisma-web's account; the page says so.

### Internal
- `POST /api/routers/{id}/system/{reboot,shutdown,restart-dataplane}`, `GET`/`POST /api/routers/{id}/system/upgrade` (the run as Server-Sent Events); the fleet status carries `maintenance`. The simulated Prisma runs them (nothing really reboots) and the one with mTLS refuses them as the real router does. `--lab` reads the upgrade status and checks for a release only (#50).

## 0.22.0 - Live log — 2026-10-03

### Added
- On a router with Prisma 0.149.25 or newer, the CGNAT screen has a **Live log**: the port blocks the router hands out and takes back as it exports them (subscriber, public address and ports, pool), filtered by subscriber, public address and port, event or pool, with what each log stream delivered and how many events the page missed. It is an operator's, each watch is recorded in the audit log with its filters, and a watch lasts at most 30 minutes; stopping or leaving the page ends it on the router (#49).

### Fixed
- The audit log's action filter found nothing for an action with an underscore in its name (#49).

### Internal
- `GET /api/routers/{id}/logging/watch` relays `TelemetryService.WatchLogging` as Server-Sent Events. The simulated Prisma streams allocations and releases; `--lab` takes a 3 s watch, read only (#49).

## 0.21.0 - Clears — 2026-10-03

### Added
- On a router with Prisma 0.149.25 or newer, the VTY's `clear` lines are a button where the object is shown: the interface counters (Interfaces), a BGP session soft, soft in, soft out or hard, the OSPF process, an OSPF neighbor and an IS-IS adjacency (Routing), and a subscriber's sessions (CGNAT lookup). Each asks for a confirmation that says what it disrupts, is offered to operators and above, and is recorded in the change log, refused or not; a refusal is shown in the router's words. Older routers are offered none (#48).

### Internal
- Client regenerated from the Prisma 0.149.25 contract; integration notes read up to 0.149.25. The fleet status carries the health of the router's `SystemService`. The simulated Prisma answers `Clear`; `WatchLogging` and `SystemService` answer *unimplemented* until their own issues (#48).

## 0.20.0 - Schema positions — 2026-10-03

### Changed
- On a router with Prisma 0.149.24 or newer, the Settings editor reads the grammar's new shape, where each value says where it stands among the words, so lines such as `neighbor 192.0.2.10 remote-as 65000` and `0.0.0.0/0 next-hop 192.0.2.10` match their statements again. Older routers are read as before (#47).

### Fixed
- A BGP neighbor's route map or prefix list in a family asks for its direction (`NAME in` or `NAME out`), as the router requires; a bare name was refused at the commit (#47).
- An OSPF area is added with its type (stub or nssa, optionally without summaries); a bare `area X` is not a statement of the router (#47).

### Internal
- Client regenerated from the Prisma 0.149.24 contract; integration notes read up to 0.149.24. The simulated Prisma answers the new schema shape and *unimplemented* for the new typed objects (#47).

## 0.19.0 - Typed configuration — 2026-10-03

### Changed
- On a router with Prisma 0.149.20 or newer, the interface, pool and log collector forms read and write the configuration as fields; from 0.149.22 the static route and BGP neighbor forms too. The review shows the lines the router wrote for them. Routers without those calls keep the line forms (#46).
- A BGP neighbor is removed the way the router removes it cleanly: with the typed call where it has one, statement by statement on 0.149.20 to 0.149.22, and a plain `no neighbor` before or from 0.149.23 (#46).
- What a routing block holds that no form field takes is shown read only (#46).

### Fixed
- A BGP password is never read or shown; leaving the field empty keeps the current one (#46).

### Internal
- Client regenerated from the Prisma 0.149.22 contract (additions only); integration notes read up to 0.149.23. A third simulated Prisma without the typed calls keeps the line forms tested (#46).

## 0.18.1 - Real box grammar — 2026-10-03

### Fixed
- On a router whose grammar comes from its GetSchema, static routes, BGP neighbors and syslog collectors were read only in Settings: the box's schema writes them in shapes the editor did not read. Every operator line of the test box now matches its setting (#45).

## 0.18.0 - Grammar from the router — 2026-10-03

### New
- **Settings** takes its grammar from the router itself on Prisma 0.149.20 or newer (`GetSchema`), and says where it came from (#44).
- **Check with the router:** a setting can be checked by the router's own VTY before it joins the changes; nothing is staged by the check (Prisma 0.149.20 or newer) (#44).
- The box's own lines (FRR's logging, the box's VRF) are shown read only with the router's reason (#44).

### Fixed
- Reads of the running configuration wait up to 120 s: before Prisma 0.149.21 an account without a configuration role took about 90 s for them and failed (#44).
- `<A.B.C.D|X:X::X:X>` values (either family) are recognised in the structured editor (#44).

### Internal
- Client regenerated from the Prisma 0.149.20 contract (additions only); integration notes read up to 0.149.21. The syslog-disable guard reads the configured collectors from the box (#44).
- Builds cache their compiled artifacts per compose project, and the mock image is named after the project: two checkouts building at once no longer reuse each other's output (#44).

## 0.17.0 - Routing forms — 2026-10-03

### New
- **BGP:** global settings, and the neighbors with their live state beside their configuration: add, change, shut down and remove a neighbor (remote AS, peer group, description, password, update source, multihop, timers, maximum prefixes, next hop self, BFD), and per IPv4 and IPv6 unicast its activation, route map, prefix list and soft reconfiguration; networks, aggregates and redistribution per family. A router without BGP can start it from a small form (#42).
- **OSPF and OSPF6:** router ID, areas, OSPFv2 networks, redistribution, and per interface its area, cost and passive switch (#43).
- **Static routes:** IPv4 and IPv6, by next hop or interface, with distance, tag and description (#43).
- Changes go through the usual review; the forms are offered to operators whose box account is an administrator (#42, #43).

## 0.16.0 - CGNAT forms — 2026-10-03

### New
- **CGNAT settings:** timeouts, block hold-down, inside and outside interfaces, subscriber identity, session table and memory, from one form (#41).
- **Pools:** add, change and remove a pool from a form: inside and outside prefixes, block size, mode, policy, limits, ports, alarms, filtering, TCP MSS and the ALGs. A change that remaps subscribers (a new block size, a prefix change, a removal) is announced in the form before the review (#41).
- **Log collectors:** syslog, IPFIX over TCP and IPFIX over UDP set or disabled from a form next to the log export card; disabling a syslog that was never enabled is warned about first (#41).
- Forms are offered to a box account that is an administrator or a CGNAT operator (#41).

### Fixed
- In the structured editor, values written `<on|off>` were read as two words, so no ALG setting matched its statement (#41).
- A refusal in the review is scrolled into view (#41).

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
