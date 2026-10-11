//! `show log` (Prisma 0.151.14, prismarouting #588, prisma-web #75): the box's record of what
//! happened on it, and why the dataplane and the routing daemons last started.

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use prisma_proto::v1::{BoxEvent, ListEventsRequest, ListEventsResponse};
use tonic::Status;

/// The release the record exists from.
pub fn recorded() -> bool {
    crate::operational::release_at_least((0, 151, 14))
}

/// What the box sees happen (0.152.0, #588 phase 2, prisma-web #78): subject and reason, kinds.
pub fn seen() -> bool {
    crate::operational::release_at_least((0, 152, 0))
}

/// What already stands at the first reading of a boot (0.152.2, #588 phase 3, prisma-web #79).
pub fn standing() -> bool {
    crate::operational::release_at_least((0, 152, 2))
}

pub const KINDS: [&str; 18] = [
    "commit", "rollback", "confirm", "confirm-expired", "asked", "start", "boot", "upgraded", "link", "transceiver", "bgp", "bfd", "pool", "collector",
    "login", "settings", "gave-up",
    // 0.152.7 (#84): a VRF move whose wait for zebra ran out.
    "vrf-settle",
];

pub const SEVERITIES: [&str; 4] = ["error", "warning", "notice", "info"];
pub const SOURCES: [&str; 5] = ["vty", "api", "host", "dataplane", "routing"];

fn ts(t: DateTime<Utc>) -> Option<prost_types::Timestamp> {
    Some(prost_types::Timestamp { seconds: t.timestamp(), nanos: 0 })
}

/// One event; `component` and `cause` for a start, or an `asked` that brings one about.
#[allow(clippy::too_many_arguments)]
pub fn event(at: DateTime<Utc>, severity: &str, source: &str, kind: &str, text: String, account: &str, origin: &str, start: Option<(&str, &str)>) -> BoxEvent {
    let (component, cause) = start.unwrap_or_default();
    BoxEvent {
        time: ts(at),
        severity: severity.into(),
        source: source.into(),
        text,
        account: account.into(),
        origin: origin.into(),
        kind: kind.into(),
        component: component.into(),
        cause: cause.into(),
        ..Default::default()
    }
}

/// What the box saw happen (0.152.0, #78): about `subject`, `reason` why.
pub fn happened(at: DateTime<Utc>, severity: &str, source: &str, kind: &str, subject: &str, reason: &str, text: String) -> BoxEvent {
    BoxEvent { subject: subject.into(), reason: reason.into(), ..event(at, severity, source, kind, text, "", "the box", None) }
}

/// The boot and the two starts it brought about, as the record opens.
pub fn seed(boot: DateTime<Utc>) -> Vec<BoxEvent> {
    let mut log = vec![
        event(boot, "notice", "host", "boot", "the box booted".into(), "", "the box", None),
        event(boot + chrono::Duration::seconds(40), "info", "dataplane", "start", "the dataplane started (boot)".into(), "", "the box", Some(("dataplane", "boot"))),
        event(boot + chrono::Duration::seconds(50), "info", "routing", "start", "the routing daemons started (boot)".into(), "", "the box", Some(("routing", "boot"))),
    ];
    if seen() {
        let login = boot + chrono::Duration::hours(1);
        log.push(BoxEvent {
            account: "admin".into(),
            origin: "ssh 192.0.2.10".into(),
            ..happened(login, "notice", "host", "login", "admin", "", "admin logged in from ssh 192.0.2.10".into())
        });
        log.push(happened(login + chrono::Duration::minutes(1), "warning", "host", "login", "root", "authentication failed", "a login as root from ssh 198.51.100.7 failed: authentication failed".into()));
    }
    if seen() && crate::operational::release_at_least((0, 152, 11)) {
        // 0.152.11 (#95): a card Linux holds is recorded too, from the host, and a flap
        // between two readings is no longer missed.
        let at = boot + chrono::Duration::minutes(90);
        log.push(happened(at, "warning", "host", "link", "eno1", "down", "interface eno1 (held by Linux): link went down".into()));
        log.push(happened(at + chrono::Duration::seconds(30), "notice", "host", "link", "eno1", "up", "interface eno1 (held by Linux): link came up".into()));
        log.push(happened(
            at + chrono::Duration::minutes(10),
            "warning",
            "dataplane",
            "link",
            "wan0",
            "flap",
            "interface wan0: link went down and came back between two readings (2 time(s)): the wire or the far end".into(),
        ));
    }
    if standing() {
        // The dirty fibre on lan0 (#76) was already there at the boot's first reading.
        let at = boot + chrono::Duration::seconds(70);
        let e = happened(at, "warning", "dataplane", "transceiver", "lan0", "rx power low-warning", "standing at start: lan0's module: rx power low-warning (-16.02 dBm)".into());
        log.insert(3, e);
    }
    log
}

/// `since` as `show log since` takes it: "30m", "1h", "2d", "1w", or an ISO date or time.
fn since(v: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, Status> {
    let bad = || Status::invalid_argument(format!("% since: '{v}' is not a time (30m, 1h, 2d, 1w, or an ISO date or time)"));
    if let Some((n, unit)) = v.split_at_checked(v.len().saturating_sub(1)) {
        if let Ok(n) = n.parse::<i64>() {
            let secs = match unit {
                "m" => 60,
                "h" => 3_600,
                "d" => 86_400,
                "w" => 604_800,
                _ => return Err(bad()),
            };
            return Ok(now - chrono::Duration::seconds(n * secs));
        }
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(v) {
        return Ok(t.with_timezone(&Utc));
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(v, f) {
            return Ok(t.and_utc());
        }
    }
    NaiveDate::parse_from_str(v, "%Y-%m-%d").map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc()).map_err(|_| bad())
}

pub fn list(log: &[BoxEvent], req: &ListEventsRequest, now: DateTime<Utc>) -> Result<ListEventsResponse, Status> {
    let rank = |s: &str| SEVERITIES.iter().position(|x| *x == s);
    let floor = match req.severity.as_str() {
        "" => None,
        s => Some(rank(s).ok_or_else(|| Status::invalid_argument(format!("% severity: '{s}' is not one of error, warning, notice, info")))?),
    };
    if !req.kind.is_empty() && (!seen() || !KINDS.contains(&req.kind.as_str())) {
        return Err(Status::invalid_argument(format!("% kind: '{}' is not a kind of event this box records", req.kind)));
    }
    if !req.source.is_empty() && !SOURCES.contains(&req.source.as_str()) {
        return Err(Status::invalid_argument(format!("% source: '{}' is not one of vty, api, host, dataplane, routing", req.source)));
    }
    let from = if req.since.is_empty() { None } else { Some(since(&req.since, now)?.timestamp()) };
    let mut events: Vec<BoxEvent> = log
        .iter()
        .filter(|e| floor.is_none_or(|f| rank(&e.severity).is_some_and(|r| r <= f)))
        .filter(|e| req.source.is_empty() || e.source == req.source)
        .filter(|e| req.kind.is_empty() || e.kind == req.kind)
        .filter(|e| from.is_none_or(|f| e.time.as_ref().is_some_and(|t| t.seconds >= f)))
        .cloned()
        .collect();
    // 0 with no `since` is the last 50; 0 with one is every one since.
    let last = if req.last == 0 && req.since.is_empty() { 50 } else { req.last as usize };
    if last > 0 && events.len() > last {
        events.drain(..events.len() - last);
    }
    let text = events
        .iter()
        .map(|e| {
            let at = e.time.as_ref().and_then(|t| DateTime::from_timestamp(t.seconds, 0)).map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default();
            format!("{at} {:<7} {:<9} {}", e.severity, e.source, e.text)
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ListEventsResponse { events, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_filters_and_an_event_says_what_and_why() {
        // Phase 2 (0.152.0, #78): the kind filter, subject and reason.
        let now = Utc::now();
        let log = vec![
            happened(now, "warning", "routing", "bfd", "192.168.10.2", "control detection time expired", "BFD down".into()),
            event(now, "notice", "api", "commit", "commit r2".into(), "prisma-web", "the API", None),
        ];
        let r = |kind: &str| list(&log, &ListEventsRequest { kind: kind.into(), ..Default::default() }, now);
        let bfd = r("bfd");
        // The kind filter needs a box that records phase 2; this test runs without MOCK_RELEASE.
        if seen() {
            let e = &bfd.unwrap().events;
            assert_eq!((e.len(), e[0].subject.as_str(), e[0].reason.as_str()), (1, "192.168.10.2", "control detection time expired"));
            assert!(r("weather").is_err());
        } else {
            assert!(bfd.is_err(), "a box before 0.152.0 has no kind filter");
        }
        assert_eq!(r("").unwrap().events.len(), 2);
    }

    #[test]
    fn the_filters_are_show_logs() {
        let now = Utc::now();
        let mut log = seed(now - chrono::Duration::days(3));
        log.push(event(now - chrono::Duration::minutes(5), "notice", "api", "commit", "commit r2 by prisma-web".into(), "prisma-web", "the API", None));
        log.push(event(now - chrono::Duration::minutes(1), "warning", "dataplane", "start", "the dataplane started (unexpected)".into(), "", "the box", Some(("dataplane", "unexpected"))));
        let r = |last, since: &str, severity: &str, source: &str| {
            list(&log, &ListEventsRequest { last, since: since.into(), severity: severity.into(), source: source.into(), ..Default::default() }, now)
        };
        assert_eq!(r(0, "", "", "").unwrap().events.len(), 5);
        assert_eq!(r(0, "1h", "", "").unwrap().events.len(), 2, "every one since");
        assert_eq!(r(1, "", "", "").unwrap().events[0].cause, "unexpected", "the newest last");
        assert_eq!(r(0, "", "warning", "").unwrap().events.len(), 1, "that severity and above");
        assert_eq!(r(0, "", "", "api").unwrap().events[0].account, "prisma-web");
        assert!(r(0, "yesterday", "", "").is_err() && r(0, "", "loud", "").is_err() && r(0, "", "", "kernel").is_err());
        assert_eq!(r(0, &(now - chrono::Duration::days(1)).format("%Y-%m-%d").to_string(), "", "").unwrap().events.len(), 2);
    }
}
