//! `TelemetryService.Subscribe`: periodic samples of the counters and of CGNAT,
//! plus configuration events as they happen.

use std::time::Duration;

use chrono::Utc;
use prisma_proto::v1::telemetry_service_server::TelemetryService;
use prisma_proto::v1::telemetry_update::Update;
use prisma_proto::v1::*;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tonic::codegen::BoxStream;
use tonic::{Request, Response, Status};

use crate::state::{timestamp, SharedRef};

pub struct TelemetrySvc(pub SharedRef);

fn update(u: Update) -> Result<TelemetryUpdate, Status> {
    Ok(TelemetryUpdate { at: Some(timestamp(Utc::now())), update: Some(u), ..Default::default() })
}

#[tonic::async_trait]
impl TelemetryService for TelemetrySvc {
    // With default stubs (#22) the streaming rpc returns a boxed stream instead
    // of an associated type.
    async fn subscribe(&self, req: Request<SubscribeRequest>) -> Result<Response<BoxStream<TelemetryUpdate>>, Status> {
        let req = req.into_inner();
        if req.interval_ms < 500 {
            return Err(Status::invalid_argument("interval_ms must be at least 500"));
        }
        let (tx, rx) = mpsc::channel(32);
        let shared = self.0.clone();
        let mut events = shared.events.subscribe();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(u64::from(req.interval_ms)));
            loop {
                let mut out = Vec::new();
                tokio::select! {
                    _ = tick.tick() => {
                        let st = shared.state.lock().unwrap();
                        if req.interface_counters {
                            let samples = st
                                .sims
                                .iter()
                                .filter(|s| req.interfaces.is_empty() || req.interfaces.contains(&s.name))
                                .map(|s| InterfaceSample { name: s.name.clone(), counters: Some(s.counters), ..Default::default() })
                                .collect();
                            out.push(update(Update::Interfaces(InterfaceBatch { samples, ..Default::default() })));
                        }
                        if req.cgnat_totals {
                            out.push(update(Update::Cgnat(st.cgnat_totals())));
                        }
                    }
                    ev = events.recv(), if req.events || req.logging_events => match ev {
                        // Log export events only with logging_events, the others only with events (#555).
                        Ok(e) => {
                            let log = e.kind.starts_with("log-");
                            if (log && req.logging_events) || (!log && req.events) {
                                out.push(update(Update::Event(e)));
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    // The client cancelled: end the task.
                    _ = tx.closed() => break,
                }
                for u in out {
                    if tx.send(u).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    /// `monitor cgnat logging` (0.149.25, #49): STARTED, BOOT, then an ALLOC
    /// or RELEASE every half second and a DELIVERY every 10 s, with the
    /// monitor's filters, until `seconds` pass or the client cancels.
    async fn watch_logging(&self, req: Request<WatchLoggingRequest>) -> Result<Response<BoxStream<LogEvent>>, Status> {
        use log_event::Kind;
        if crate::typed::disabled() {
            return Err(Status::unimplemented("WatchLogging (MOCK_NO_TYPED: a box before 0.149.25)"));
        }
        let req = req.into_inner();
        let pools = self.0.state.lock().unwrap().running.pool_names();
        if !req.pool.is_empty() && !pools.contains(&req.pool) {
            return Err(Status::invalid_argument(format!("% Unknown pool {}", req.pool)));
        }
        if !["", "alloc", "release", "exhausted"].contains(&req.event.as_str()) {
            return Err(Status::invalid_argument(format!("% Unknown event {}", req.event)));
        }
        let boot = self.0.state.lock().unwrap().started;
        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(async move {
            let now = || Some(timestamp(Utc::now()));
            let ends = (req.seconds > 0).then(|| tokio::time::Instant::now() + Duration::from_secs(req.seconds.into()));
            let booted = Utc::now() - chrono::Duration::from_std(boot.elapsed()).unwrap_or_default();
            let first = [
                LogEvent { kind: Kind::Started as i32, at: now(), from_watch_ring: true, pools_named: true, ..Default::default() },
                LogEvent { kind: Kind::Boot as i32, at: now(), boot_time: Some(timestamp(booted)), ..Default::default() },
            ];
            for e in first {
                if tx.send(Ok(e)).await.is_err() {
                    return;
                }
            }
            let pool = req.pool.clone();
            let pool = if pool.is_empty() { pools.first().cloned().unwrap_or_else(|| "#1".into()) } else { pool };
            let (mut n, mut sent) = (0u32, 0u64);
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            loop {
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = tx.closed() => return,
                }
                if ends.is_some_and(|t| tokio::time::Instant::now() >= t) {
                    return;
                }
                n += 1;
                let kind = if n % 2 == 1 { Kind::Alloc } else { Kind::Release };
                let i = (n + 1) / 2;
                let subscriber = if req.subscriber.is_empty() { format!("100.64.{}.{}", i / 250 % 250, i % 250 + 1) } else { req.subscriber.clone() };
                let public_address = if req.public_address.is_empty() { format!("203.0.113.{}", i % 8 + 1) } else { req.public_address.clone() };
                let port_first = if req.port != 0 { req.port - req.port % 512 } else { 1024 + (i % 120) * 512 };
                let wanted = req.event.is_empty() || req.event == kind.as_str_name().to_ascii_lowercase();
                if wanted {
                    sent += 1;
                    let e = LogEvent {
                        kind: kind as i32,
                        at: now(),
                        subscriber,
                        public_address,
                        port_first,
                        port_last: port_first + 511,
                        pool: pool.clone(),
                        pool_id: 1,
                        identity: "prisma-mock".into(),
                        exported: true,
                        ..Default::default()
                    };
                    if tx.send(Ok(e)).await.is_err() {
                        return;
                    }
                }
                if n % 20 == 0 && !req.no_deliveries {
                    let d = LogEvent { kind: Kind::Delivery as i32, at: now(), stream: "syslog".into(), collector: "192.0.2.50:514".into(), sent, ..Default::default() };
                    if tx.send(Ok(d)).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    async fn get_history(&self, req: Request<GetHistoryRequest>) -> Result<Response<BoxStream<HistorySample>>, Status> {
        let req = req.into_inner();
        let since = req.since.map(|t| (t.seconds, t.nanos));
        let samples: Vec<Result<HistorySample, Status>> = self
            .0
            .state
            .lock()
            .unwrap()
            .history
            .iter()
            .filter(|s| since.is_none_or(|since| s.at.is_some_and(|at| (at.seconds, at.nanos) > since)))
            .map(|s| Ok(filter_sample(s, &req)))
            .collect();
        Ok(Response::new(Box::pin(tokio_stream::iter(samples))))
    }
}

/// Keeps only what the request asked for. The mock records no worker load.
fn filter_sample(s: &HistorySample, req: &GetHistoryRequest) -> HistorySample {
    HistorySample {
        at: s.at,
        interfaces: if req.interface_counters {
            s.interfaces.iter().filter(|i| req.interfaces.is_empty() || req.interfaces.contains(&i.name)).cloned().collect()
        } else {
            vec![]
        },
        cgnat: if req.cgnat_totals { s.cgnat } else { None },
        memory_used_bytes: if req.memory { s.memory_used_bytes } else { 0 },
        ..Default::default()
    }
}
