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
    Ok(TelemetryUpdate { at: Some(timestamp(Utc::now())), update: Some(u) })
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
                                .map(|s| InterfaceSample { name: s.name.clone(), counters: Some(s.counters) })
                                .collect();
                            out.push(update(Update::Interfaces(InterfaceBatch { samples })));
                        }
                        if req.cgnat_totals {
                            let subscribers = st.subscribers as u64;
                            out.push(update(Update::Cgnat(CgnatTotals {
                                subscribers,
                                ports_in_use: subscribers * 180,
                                sessions: subscribers * 35,
                                refusals: st.refusals,
                            })));
                        }
                    }
                    ev = events.recv(), if req.events => match ev {
                        Ok(e) => out.push(update(Update::Event(e))),
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
}
