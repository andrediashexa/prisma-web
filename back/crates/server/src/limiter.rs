//! In-memory limit of login attempts per IP.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct LoginLimiter {
    max_failures: u32,
    window: Duration,
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl LoginLimiter {
    pub fn new(max_failures: u32, window: Duration) -> Self {
        Self { max_failures, window, failures: Mutex::new(HashMap::new()) }
    }

    /// `Some(minutes left)` if the IP is blocked.
    pub fn blocked(&self, ip: IpAddr) -> Option<u64> {
        let map = self.failures.lock().unwrap();
        let (count, since) = map.get(&key(ip))?;
        let elapsed = since.elapsed();
        (*count >= self.max_failures && elapsed < self.window)
            .then(|| (self.window - elapsed).as_secs().div_ceil(60).max(1))
    }

    pub fn record_failure(&self, ip: IpAddr) {
        let mut map = self.failures.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, (_, since)| now.duration_since(*since) < self.window);
        let entry = map.entry(key(ip)).or_insert((0, now));
        entry.0 += 1;
    }

    pub fn reset(&self, ip: IpAddr) {
        self.failures.lock().unwrap().remove(&key(ip));
    }
}

/// IPv6 clients usually control a whole /64; limiting by exact address
/// would let them bypass the block by changing the suffix.
fn key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::from([s[0], s[1], s[2], s[3], 0, 0, 0, 0])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_and_groups_ipv6_by_64() {
        let l = LoginLimiter::new(2, Duration::from_secs(60));
        let a: IpAddr = "2001:db8:1:2::10".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff::1".parse().unwrap();
        l.record_failure(a);
        assert!(l.blocked(b).is_none());
        l.record_failure(b);
        assert!(l.blocked(a).is_some());
        l.reset(a);
        assert!(l.blocked(b).is_none());
    }
}
