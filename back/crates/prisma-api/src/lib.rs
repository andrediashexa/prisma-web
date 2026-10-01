//! Contrato da API HTTP que o Prisma expõe para o prisma-web.
//!
//! Todas as rotas ficam sob `/v1`, trafegam JSON e aceitam autenticação opcional
//! por `Authorization: Bearer <token>`. Endereços são sempre representados em
//! notação CIDR (`192.0.2.1/24`, `2001:db8::1/64`), tratando IPv4 e IPv6 da mesma forma.

use std::fmt;
use std::net::IpAddr;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[cfg(feature = "client")]
mod client;
#[cfg(feature = "client")]
pub use client::{PrismaClient, PrismaError};

pub mod paths {
    pub const SYSTEM: &str = "/v1/system";
    pub const INTERFACES: &str = "/v1/interfaces";
    pub const ROUTES: &str = "/v1/routes";
    pub const METRICS_TRAFFIC: &str = "/v1/metrics/traffic";
}

/// Limites de MTU aceitos. 1280 é o mínimo exigido pelo IPv6 (RFC 8200).
pub const MTU_MIN: u32 = 1280;
pub const MTU_MAX: u32 = 9216;

/// Endereço IP com comprimento de prefixo, serializado como `addr/prefix`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct IpCidr {
    pub addr: IpAddr,
    pub prefix_len: u8,
}

impl IpCidr {
    pub fn new(addr: IpAddr, prefix_len: u8) -> Result<Self, String> {
        let max = if addr.is_ipv4() { 32 } else { 128 };
        if prefix_len > max {
            return Err(format!("prefixo /{prefix_len} inválido para {addr}"));
        }
        Ok(Self { addr, prefix_len })
    }

    pub fn family(&self) -> AddressFamily {
        AddressFamily::of(&self.addr)
    }
}

impl fmt::Display for IpCidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix_len)
    }
}

impl FromStr for IpCidr {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (addr, prefix) = s
            .split_once('/')
            .ok_or_else(|| format!("'{s}' não está em notação CIDR"))?;
        let addr: IpAddr = addr.parse().map_err(|_| format!("endereço inválido: '{addr}'"))?;
        let prefix: u8 = prefix.parse().map_err(|_| format!("prefixo inválido: '{prefix}'"))?;
        Self::new(addr, prefix)
    }
}

impl TryFrom<String> for IpCidr {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl From<IpCidr> for String {
    fn from(c: IpCidr) -> Self {
        c.to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressFamily {
    Ipv4,
    Ipv6,
}

impl AddressFamily {
    pub fn of(addr: &IpAddr) -> Self {
        match addr {
            IpAddr::V4(_) => Self::Ipv4,
            IpAddr::V6(_) => Self::Ipv6,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub hostname: String,
    pub version: String,
    pub uptime_seconds: u64,
    pub cpu_cores: u32,
    pub cpu_percent: f32,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub load_average: [f32; 3],
    pub ipv6_forwarding: bool,
    pub ipv4_forwarding: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceKind {
    Ethernet,
    Bridge,
    Vlan,
    Wireguard,
    Loopback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperState {
    Up,
    Down,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Counters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
    pub rx_errors: u64,
    pub tx_errors: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interface {
    pub name: String,
    pub kind: InterfaceKind,
    pub description: Option<String>,
    pub mac: Option<String>,
    pub mtu: u32,
    pub admin_up: bool,
    pub oper_state: OperState,
    pub addresses: Vec<IpCidr>,
    pub counters: Counters,
}

/// Corpo de `PATCH /v1/interfaces/{name}`. Campos ausentes não são alterados.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InterfaceUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtu: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_up: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub family: AddressFamily,
    pub destination: IpCidr,
    pub gateway: Option<IpAddr>,
    pub interface: String,
    pub metric: u32,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficSample {
    pub timestamp: DateTime<Utc>,
    pub rx_bps: u64,
    pub tx_bps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficSeries {
    pub interface: String,
    pub step_seconds: u32,
    pub samples: Vec<TrafficSample>,
}

/// Formato de erro devolvido pelo Prisma em respostas não-2xx.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_roundtrip_v4_v6() {
        for s in ["192.0.2.1/24", "2001:db8::1/64", "::/0", "fe80::1/128"] {
            let c: IpCidr = s.parse().unwrap();
            assert_eq!(c.to_string(), s);
        }
    }

    #[test]
    fn cidr_rejects_bad_prefix() {
        assert!("192.0.2.1/33".parse::<IpCidr>().is_err());
        assert!("2001:db8::1/129".parse::<IpCidr>().is_err());
        assert!("2001:db8::1".parse::<IpCidr>().is_err());
    }
}
