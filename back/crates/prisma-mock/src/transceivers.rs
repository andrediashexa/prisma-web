//! `show interface transceiver` (Prisma 0.151.15, prismarouting #590, prisma-web #76): a module
//! per port of the simulated box, one of each status, the levels against their thresholds.

use prisma_proto::v1::transceiver::Status;
use prisma_proto::v1::transceiver_level::Level;
use prisma_proto::v1::{Transceiver, TransceiverLane, TransceiverLevel, Transceivers};

/// From this release the box answers it.
pub fn answered() -> bool {
    crate::operational::release_at_least((0, 151, 15))
}

fn dbm(mw: f64) -> f64 {
    if mw > 0.0 { 10.0 * mw.log10() } else { 0.0 }
}

/// A level against its four thresholds (high alarm, low alarm, high warning, low warning).
fn level(value: f64, t: Option<[f64; 4]>, power: bool) -> TransceiverLevel {
    let mut l = TransceiverLevel { known: true, value, ..Default::default() };
    match t {
        Some([ha, la, hw, lw]) => {
            l.thresholds_known = true;
            (l.high_alarm, l.low_alarm, l.high_warning, l.low_warning) = (ha, la, hw, lw);
            l.level = if value >= ha {
                Level::HighAlarm
            } else if value <= la {
                Level::LowAlarm
            } else if value >= hw {
                Level::HighWarning
            } else if value <= lw {
                Level::LowWarning
            } else {
                Level::Normal
            } as i32;
        }
        None => l.level = Level::Unknown as i32,
    }
    if power {
        l.no_light = value == 0.0;
        l.dbm = dbm(value);
        (l.high_alarm_dbm, l.low_alarm_dbm, l.high_warning_dbm, l.low_warning_dbm) = (dbm(l.high_alarm), dbm(l.low_alarm), dbm(l.high_warning), dbm(l.low_warning));
    }
    l
}

const RX: [f64; 4] = [1.0, 0.0158, 0.794, 0.0316];
const TX: [f64; 4] = [1.26, 0.1, 1.0, 0.126];

fn optical(name: &str, device: &str, serial: &str, rx_mw: f64) -> Transceiver {
    Transceiver {
        name: name.into(),
        source: "dpdk".into(),
        device: device.into(),
        map: "sff-8472".into(),
        status: Status::Ddm as i32,
        identifier: "SFP/SFP+/SFP28".into(),
        connector: "LC".into(),
        vendor: "FINISAR CORP.".into(),
        oui: "00:90:65".into(),
        part_number: "FTLX8574D3BCL".into(),
        revision: "A".into(),
        serial_number: serial.into(),
        date_code: "2023-08-15".into(),
        wavelength_nm: 850,
        calibration: "internal".into(),
        rx_power_average: true,
        temperature_c: Some(level(38.2, Some([75.0, -5.0, 70.0, 0.0]), false)),
        voltage_v: Some(level(3.31, Some([3.6, 3.0, 3.5, 3.1]), false)),
        lanes: vec![TransceiverLane {
            lane: 1,
            bias_ma: Some(level(6.8, Some([13.0, 2.0, 12.0, 3.0]), false)),
            tx_power_mw: Some(level(0.55, Some(TX), true)),
            rx_power_mw: Some(level(rx_mw, Some(RX), true)),
        }],
        ..Default::default()
    }
}

/// Between an upgrade and the dataplane's restart (0.151.16, #77): the plugin it runs cannot read
/// modules, so no dataplane port is listed; the Linux card still is.
pub fn old_plugin() -> Transceivers {
    let mut t = list(&[], 0.48);
    t.transceivers.retain(|x| x.source == "linux");
    t.text = "    note: the dataplane runs a plugin older than this VTY, which cannot read\n    its ports' modules; 'system dataplane restart' loads the one this release\n    carries\n".into();
    t
}

/// Every module, `rx` the RX power of wan0 (a test hook moves it), narrowed to `names`.
pub fn list(names: &[String], wan0_rx_mw: f64) -> Transceivers {
    let all = vec![
        optical("wan0", "0000:03:00.0", "FNS1A2B3C4", wan0_rx_mw),
        // A dirty fibre: past its low warning.
        optical("lan0", "0000:03:00.1", "FNS5D6E7F8", 0.025),
        Transceiver {
            name: "lan1".into(),
            source: "dpdk".into(),
            device: "0000:04:00.0".into(),
            map: "sff-8472".into(),
            status: Status::Copper as i32,
            why: "a copper module: no optical levels".into(),
            identifier: "SFP/SFP+/SFP28".into(),
            connector: "copper pigtail".into(),
            vendor: "FS".into(),
            part_number: "SFP-10G-DAC".into(),
            copper: true,
            ..Default::default()
        },
        Transceiver {
            name: "lan2".into(),
            source: "dpdk".into(),
            device: "0000:04:00.1".into(),
            status: Status::Absent as i32,
            why: "no module answered: the cage is empty".into(),
            ..Default::default()
        },
        Transceiver {
            name: "eno1".into(),
            source: "linux".into(),
            device: "eno1".into(),
            map: "sff-8472".into(),
            status: Status::NoDdm as i32,
            why: "the module does not implement diagnostics".into(),
            identifier: "SFP/SFP+/SFP28".into(),
            connector: "LC".into(),
            vendor: "OEM".into(),
            part_number: "SFP-1G-SX".into(),
            wavelength_nm: 850,
            ..Default::default()
        },
    ];
    let known: Vec<&str> = all.iter().map(|t| t.name.as_str()).collect();
    let missing = names.iter().filter(|n| !known.contains(&n.as_str())).cloned().collect();
    let transceivers: Vec<Transceiver> = all.into_iter().filter(|t| names.is_empty() || names.contains(&t.name)).collect();
    let text = transceivers.iter().map(|t| format!("{:<6} {:?} {} {}", t.name, Status::try_from(t.status).unwrap_or_default(), t.vendor, t.part_number)).collect::<Vec<_>>().join("\n");
    Transceivers { dataplane_answered: true, transceivers, missing, text }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_stand_against_their_thresholds() {
        let t = list(&[], 0.48);
        assert_eq!(t.transceivers.len(), 5);
        let rx = |t: &Transceivers, n: &str| t.transceivers.iter().find(|x| x.name == n).unwrap().lanes[0].rx_power_mw.clone().unwrap();
        assert_eq!(rx(&t, "wan0").level, Level::Normal as i32);
        assert_eq!(rx(&t, "lan0").level, Level::LowWarning as i32);
        let dark = list(&["wan0".into(), "nope".into()], 0.0);
        assert_eq!((dark.transceivers.len(), dark.missing.clone()), (1, vec!["nope".to_string()]));
        let r = rx(&dark, "wan0");
        assert!(r.no_light && r.dbm == 0.0 && r.level == Level::LowAlarm as i32, "0 mW is no light, an alarm, no dBm");
        assert!((rx(&t, "wan0").dbm - (-3.188)).abs() < 0.01);
    }
}
