//! Prisma simulado: implementa o contrato de `prisma-api` com dados sintéticos
//! para que o prisma-web possa ser desenvolvido antes do roteador real existir.

use std::collections::{HashMap, VecDeque};
use std::f64::consts::TAU;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use prisma_api::{
    paths, ApiError, Counters, Interface, InterfaceKind, InterfaceUpdate, IpCidr,
    OperState, Route, SystemInfo, TrafficSample, TrafficSeries, MTU_MAX, MTU_MIN,
};
use rand::Rng;
use serde::Deserialize;

/// Intervalo de amostragem e retenção do histórico (24h).
const SAMPLE_SECS: u64 = 5;
const HISTORY: usize = (24 * 3600 / SAMPLE_SECS) as usize;
/// Pontos máximos devolvidos por série (o resto é agregado).
const MAX_POINTS: usize = 180;

struct IfaceSim {
    iface: Interface,
    /// Pico de tráfego em bits/s para a curva sintética.
    peak_bps: f64,
    /// Fatores de variação que mudam devagar, para a curva parecer tráfego real.
    drift: (f64, f64),
    history: VecDeque<TrafficSample>,
}

struct Mock {
    started: Instant,
    cpu_percent: f32,
    mem_used: u64,
    ifaces: Vec<IfaceSim>,
}

type Shared = Arc<Mutex<Mock>>;

#[derive(Clone)]
struct AppState {
    mock: Shared,
    token: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck("/v1/system");
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let mock = Arc::new(Mutex::new(Mock::new()));
    {
        let mut m = mock.lock().unwrap();
        m.backfill();
    }
    tokio::spawn(ticker(mock.clone()));

    let state = AppState {
        mock,
        token: std::env::var("PRISMA_API_TOKEN").ok().filter(|t| !t.is_empty()),
    };

    let app = Router::new()
        .route(paths::SYSTEM, get(system))
        .route(paths::INTERFACES, get(interfaces))
        .route("/v1/interfaces/{name}", get(interface).patch(update_interface))
        .route(paths::ROUTES, get(routes))
        .route(paths::METRICS_TRAFFIC, get(traffic))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize))
        .with_state(state);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "[::]:8080".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "prisma-mock ouvindo");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// Usado pelo HEALTHCHECK do container (a imagem não tem shell nem curl).
fn healthcheck(path: &str) -> anyhow::Result<()> {
    use std::io::{Read, Write};
    let port = std::env::var("BIND_ADDR")
        .ok()
        .and_then(|a| a.parse::<SocketAddr>().ok())
        .map_or(8080, |a| a.port());
    let mut s = std::net::TcpStream::connect_timeout(
        &SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        Duration::from_secs(2),
    )?;
    s.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(s, "GET {path} HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    let mut buf = [0u8; 12];
    s.read_exact(&mut buf)?;
    anyhow::ensure!(&buf[9..12] == b"200", "status inesperado");
    Ok(())
}

async fn ticker(mock: Shared) {
    let mut tick = tokio::time::interval(Duration::from_secs(SAMPLE_SECS));
    loop {
        tick.tick().await;
        mock.lock().unwrap().step(Utc::now());
    }
}

fn cidr(s: &str) -> IpCidr {
    s.parse().expect("CIDR fixo inválido")
}

impl Mock {
    fn new() -> Self {
        let mk = |name: &str, kind, desc: &str, mac: Option<&str>, mtu, addrs: &[&str], peak| IfaceSim {
            iface: Interface {
                name: name.into(),
                kind,
                description: Some(desc.into()),
                mac: mac.map(Into::into),
                mtu,
                admin_up: true,
                oper_state: OperState::Up,
                addresses: addrs.iter().map(|a| cidr(a)).collect(),
                counters: Counters::default(),
            },
            peak_bps: peak,
            drift: (1.0, 1.0),
            history: VecDeque::with_capacity(HISTORY),
        };

        Self {
            started: Instant::now(),
            cpu_percent: 12.0,
            mem_used: 1_400 * 1024 * 1024,
            ifaces: vec![
                mk(
                    "wan0",
                    InterfaceKind::Ethernet,
                    "Uplink operadora",
                    Some("52:54:00:a1:00:01"),
                    1500,
                    &["203.0.113.10/29", "2001:db8:100::2/64", "fe80::5054:ff:fea1:1/64"],
                    850e6,
                ),
                mk(
                    "lan0",
                    InterfaceKind::Bridge,
                    "Rede interna",
                    Some("52:54:00:a1:00:02"),
                    1500,
                    &["192.168.10.1/24", "2001:db8:200:10::1/64", "fe80::5054:ff:fea1:2/64"],
                    600e6,
                ),
                mk(
                    "lan0.20",
                    InterfaceKind::Vlan,
                    "VLAN convidados",
                    Some("52:54:00:a1:00:02"),
                    1500,
                    &["192.168.20.1/24", "2001:db8:200:20::1/64"],
                    120e6,
                ),
                mk(
                    "wg0",
                    InterfaceKind::Wireguard,
                    "VPN de acesso remoto",
                    None,
                    1420,
                    &["10.8.0.1/24", "fd00:8::1/64"],
                    60e6,
                ),
                mk("lo", InterfaceKind::Loopback, "Loopback", None, 65536, &["127.0.0.1/8", "::1/128"], 1e5),
            ],
        }
    }

    /// Preenche o histórico das últimas 24h para os gráficos já nascerem com dados.
    fn backfill(&mut self) {
        let now = Utc::now();
        for i in (1..HISTORY as i64).rev() {
            self.step(now - chrono::Duration::seconds(i * SAMPLE_SECS as i64));
        }
    }

    fn step(&mut self, at: DateTime<Utc>) {
        let mut rng = rand::thread_rng();
        // Curva diária com pico às 21h (horário de Brasília, UTC-3).
        let hour = ((at.timestamp() as f64 / 3600.0) - 3.0).rem_euclid(24.0);
        let daily = 0.55 + 0.45 * ((hour - 21.0) / 24.0 * TAU).cos();

        let mut total = 0.0;
        for sim in &mut self.ifaces {
            let walk = |v: f64, rng: &mut rand::rngs::ThreadRng| (v + rng.gen_range(-0.04..0.04)).clamp(0.7, 1.2);
            sim.drift = (walk(sim.drift.0, &mut rng), walk(sim.drift.1, &mut rng));
            let (rx, tx) = if sim.iface.admin_up {
                let jitter = |rng: &mut rand::rngs::ThreadRng| rng.gen_range(0.97..1.03);
                let rx = sim.peak_bps * daily * sim.drift.0 * jitter(&mut rng);
                // Download domina; upload ~25% do download.
                let tx = sim.peak_bps * daily * 0.25 * sim.drift.1 * jitter(&mut rng);
                (rx as u64, tx as u64)
            } else {
                (0, 0)
            };
            total += (rx + tx) as f64 / sim.peak_bps.max(1.0);

            let c = &mut sim.iface.counters;
            let rx_bytes = rx / 8 * SAMPLE_SECS;
            let tx_bytes = tx / 8 * SAMPLE_SECS;
            c.rx_bytes += rx_bytes;
            c.tx_bytes += tx_bytes;
            c.rx_packets += rx_bytes / 900;
            c.tx_packets += tx_bytes / 600;
            if rng.gen_ratio(1, 2000) {
                c.rx_errors += 1;
            }

            if sim.history.len() == HISTORY {
                sim.history.pop_front();
            }
            sim.history.push_back(TrafficSample { timestamp: at, rx_bps: rx, tx_bps: tx });
        }

        let load = total / self.ifaces.len() as f64;
        let target = 6.0 + 30.0 * load as f32 + rng.gen_range(-3.0..3.0);
        self.cpu_percent = (self.cpu_percent * 0.7 + target * 0.3).clamp(1.0, 100.0);
        let jitter: i64 = rng.gen_range(-8..=8) * 1024 * 1024;
        self.mem_used = (self.mem_used as i64 + jitter).clamp(1_100 << 20, 2_200 << 20) as u64;
    }

    fn find(&mut self, name: &str) -> Option<&mut IfaceSim> {
        self.ifaces.iter_mut().find(|s| s.iface.name == name)
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ApiError { error: msg.into() })).into_response()
}

/// Exige `Authorization: Bearer <PRISMA_API_TOKEN>` quando o token está configurado.
async fn authorize(State(s): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(expected) = &s.token {
        let ok = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|t| t == expected);
        if !ok {
            return err(StatusCode::UNAUTHORIZED, "token inválido");
        }
    }
    next.run(req).await
}

async fn system(State(s): State<AppState>) -> Response {
    let m = s.mock.lock().unwrap();
    let load = m.cpu_percent / 100.0 * 4.0;
    Json(SystemInfo {
        hostname: "prisma-mock".into(),
        version: format!("prisma-mock {}", env!("CARGO_PKG_VERSION")),
        // Finge que o roteador já estava ligado há 3 dias.
        uptime_seconds: m.started.elapsed().as_secs() + 3 * 86_400 + 7_342,
        cpu_cores: 4,
        cpu_percent: (m.cpu_percent * 10.0).round() / 10.0,
        memory_total_bytes: 4 << 30,
        memory_used_bytes: m.mem_used,
        load_average: [load, load * 0.9, load * 0.8].map(|v| (v * 100.0).round() / 100.0),
        ipv4_forwarding: true,
        ipv6_forwarding: true,
    })
    .into_response()
}

async fn interfaces(State(s): State<AppState>) -> Response {
    let m = s.mock.lock().unwrap();
    Json(m.ifaces.iter().map(|s| s.iface.clone()).collect::<Vec<_>>()).into_response()
}

async fn interface(State(s): State<AppState>, Path(name): Path<String>) -> Response {
    let mut m = s.mock.lock().unwrap();
    match m.find(&name) {
        Some(sim) => Json(sim.iface.clone()).into_response(),
        None => err(StatusCode::NOT_FOUND, format!("interface '{name}' não existe")),
    }
}

async fn update_interface(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(up): Json<InterfaceUpdate>,
) -> Response {
    let mut m = s.mock.lock().unwrap();
    let Some(sim) = m.find(&name) else {
        return err(StatusCode::NOT_FOUND, format!("interface '{name}' não existe"));
    };
    if sim.iface.kind == InterfaceKind::Loopback && up.admin_up == Some(false) {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "a loopback não pode ser desativada");
    }
    if let Some(mtu) = up.mtu {
        if !(MTU_MIN..=MTU_MAX).contains(&mtu) {
            return err(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("MTU deve estar entre {MTU_MIN} e {MTU_MAX}"),
            );
        }
        sim.iface.mtu = mtu;
    }
    if let Some(d) = up.description {
        sim.iface.description = Some(d).filter(|d| !d.is_empty());
    }
    if let Some(up) = up.admin_up {
        sim.iface.admin_up = up;
        sim.iface.oper_state = if up { OperState::Up } else { OperState::Down };
    }
    Json(sim.iface.clone()).into_response()
}

async fn routes(State(s): State<AppState>) -> Response {
    let m = s.mock.lock().unwrap();
    let up: HashMap<&str, bool> = m.ifaces.iter().map(|s| (s.iface.name.as_str(), s.iface.admin_up)).collect();
    let r = |dst: &str, gw: Option<&str>, dev: &str, metric, proto: &str| {
        let destination = cidr(dst);
        Route {
            family: destination.family(),
            destination,
            gateway: gw.map(|g| g.parse().expect("gateway fixo inválido")),
            interface: dev.into(),
            metric,
            protocol: proto.into(),
        }
    };
    let all = vec![
        r("0.0.0.0/0", Some("203.0.113.9"), "wan0", 100, "static"),
        r("203.0.113.8/29", None, "wan0", 0, "kernel"),
        r("192.168.10.0/24", None, "lan0", 0, "kernel"),
        r("192.168.20.0/24", None, "lan0.20", 0, "kernel"),
        r("10.8.0.0/24", None, "wg0", 0, "kernel"),
        r("172.16.0.0/16", Some("10.8.0.2"), "wg0", 50, "static"),
        r("::/0", Some("fe80::1"), "wan0", 1024, "ra"),
        r("2001:db8:100::/64", None, "wan0", 256, "kernel"),
        r("2001:db8:200:10::/64", None, "lan0", 256, "kernel"),
        r("2001:db8:200:20::/64", None, "lan0.20", 256, "kernel"),
        r("fd00:8::/64", None, "wg0", 256, "kernel"),
        r("fe80::/64", None, "wan0", 256, "kernel"),
        r("fe80::/64", None, "lan0", 256, "kernel"),
    ];
    let routes: Vec<_> = all
        .into_iter()
        .filter(|r| up.get(r.interface.as_str()).copied().unwrap_or(false))
        .collect();
    Json(routes).into_response()
}

#[derive(Deserialize)]
struct TrafficQuery {
    interface: String,
    #[serde(default = "default_minutes")]
    minutes: u32,
}

fn default_minutes() -> u32 {
    60
}

async fn traffic(State(s): State<AppState>, Query(q): Query<TrafficQuery>) -> Response {
    let minutes = q.minutes.clamp(1, 24 * 60);
    let mut m = s.mock.lock().unwrap();
    let Some(sim) = m.find(&q.interface) else {
        return err(StatusCode::NOT_FOUND, format!("interface '{}' não existe", q.interface));
    };

    let wanted = (minutes as u64 * 60 / SAMPLE_SECS) as usize;
    let skip = sim.history.len().saturating_sub(wanted);
    let window: Vec<&TrafficSample> = sim.history.iter().skip(skip).collect();
    let bucket = window.len().div_ceil(MAX_POINTS).max(1);
    let samples = window
        .chunks(bucket)
        .map(|c| TrafficSample {
            timestamp: c.last().unwrap().timestamp,
            rx_bps: c.iter().map(|s| s.rx_bps).sum::<u64>() / c.len() as u64,
            tx_bps: c.iter().map(|s| s.tx_bps).sum::<u64>() / c.len() as u64,
        })
        .collect();

    Json(TrafficSeries {
        interface: q.interface,
        step_seconds: (bucket as u64 * SAMPLE_SECS) as u32,
        samples,
    })
    .into_response()
}
