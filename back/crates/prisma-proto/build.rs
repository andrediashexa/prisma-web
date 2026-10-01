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
        );
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
        "prisma.v1.ListRoutesResponse.snapshot_at",
    ] {
        cfg = cfg.field_attribute(ts, "#[serde(serialize_with = \"crate::ser::timestamp\")]");
    }
    cfg.compile_fds(fds)?;
    println!("cargo:rerun-if-changed={proto_root}");
    Ok(())
}
