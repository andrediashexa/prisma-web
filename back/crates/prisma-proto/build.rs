fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../../proto";
    let fds = protox::compile(["prisma/v1/prisma.proto"], [proto_root])?;

    // Serialize on every message, so the back end hands the data to the front end
    // as JSON with no manual conversion. Timestamps and enums have their own serializers.
    // Server traits get a default for every rpc (answering UNIMPLEMENTED), so a
    // new rpc in an existing Prisma service does not break the mock's build (#22).
    let mut cfg = tonic_prost_build::configure()
        .generate_default_stubs(true)
        .type_attribute(".prisma.v1", "#[derive(serde::Serialize)]")
        .field_attribute(
            "prisma.v1.Diagnostic.severity",
            "#[serde(serialize_with = \"crate::ser::severity\")]",
        )
        .field_attribute("prisma.v1.Diagnostics.reason", "#[serde(serialize_with = \"crate::ser::reason\")]")
        .field_attribute("prisma.v1.CheckResponse.reason", "#[serde(serialize_with = \"crate::ser::reason\")]")
        .field_attribute("prisma.v1.LineVerdict.reason", "#[serde(serialize_with = \"crate::ser::reason\")]");
    // The typed objects a client sends to SetConfig (Prisma 0.149.20/0.149.22, #46): the
    // front end posts them as JSON, a field left out at its default.
    for m in [
        "InterfaceConfig", "PoolConfig", "PortForwardConfig", "LogCollectorConfig", "LoggingConfig",
        "StaticRouteConfig", "Nat64PoolConfig", "BfdPeerConfig", "BfdProfileConfig", "BfdTimers", "BgpNeighborEdit", "BgpNeighborConfig", "BgpNeighborFamilyEdit", "BgpNeighborFamilyConfig",
        "KeyValue",
    ] {
        cfg = cfg.type_attribute(format!(".prisma.v1.{m}"), "#[derive(serde::Deserialize)] #[serde(default)]");
    }
    for ts in [
        "prisma.v1.Revision.committed_at",
        "prisma.v1.CommitResponse.confirm_deadline",
        "prisma.v1.TelemetryUpdate.at",
        // Uptime breakdown, Prisma 0.148.7 (#20).
        "prisma.v1.SystemInfo.boot_time",
        "prisma.v1.SystemInfo.dataplane_started",
        "prisma.v1.SystemInfo.control_plane_started",
        "prisma.v1.SystemInfo.vty_started",
        "prisma.v1.SystemInfo.release_installed_at",
        // Prisma 0.149.2 (#23).
        "prisma.v1.GetHistoryRequest.since",
        "prisma.v1.HistorySample.at",
        "prisma.v1.ListRoutesResponse.snapshot_at", "prisma.v1.LogStream.last_progress", "prisma.v1.LoggingState.at",
        "prisma.v1.OpenCandidateResponse.expires_at", "prisma.v1.EditResponse.last_activity", "prisma.v1.EditResponse.expires_at",
        "prisma.v1.PendingConfirm.deadline", "prisma.v1.PendingConfirm.committed_at",
        "prisma.v1.CandidateInfo.created_at", "prisma.v1.CandidateInfo.last_activity", "prisma.v1.CandidateInfo.expires_at",
        "prisma.v1.SetConfigResponse.last_activity", "prisma.v1.SetConfigResponse.expires_at",
        // Prisma 0.149.25 (#48).
        "prisma.v1.LogEvent.at", "prisma.v1.LogEvent.boot_time", "prisma.v1.UpgradeProgress.started_at",
        // Prisma 0.150.3 (#63).
        "prisma.v1.HaStatus.peer_copied",
        // Prisma 0.150.10 (#66).
        "prisma.v1.BfdEvent.at",
        // Prisma 0.151.14 (#75): `show log`.
        "prisma.v1.BoxEvent.time",
        // Prisma 0.152.2 (#79): remote syslog's last send.
        "prisma.v1.LoggingDestinationState.last_sent",
        // Prisma 0.152.9 (#87): when the per-CPU usage's window ended.
        "prisma.v1.SystemInfo.cpu_usage_at",
    ] {
        cfg = cfg.field_attribute(ts, "#[serde(serialize_with = \"crate::ser::timestamp\")]");
    }
    cfg.compile_fds(fds)?;
    println!("cargo:rerun-if-changed={proto_root}");
    Ok(())
}
