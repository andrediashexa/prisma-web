fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../../proto";
    let fds = protox::compile(["prisma/v1/prisma.proto"], [proto_root])?;

    // Serialize em todas as mensagens, para o back entregar os dados como JSON
    // ao front sem conversão manual. Timestamps e enums têm serializadores próprios.
    let mut cfg = tonic_prost_build::configure()
        .type_attribute(".prisma.v1", "#[derive(serde::Serialize)]")
        .field_attribute(
            "prisma.v1.Diagnostic.severity",
            "#[serde(serialize_with = \"crate::ser::severity\")]",
        );
    for ts in [
        "prisma.v1.Revision.committed_at",
        "prisma.v1.CommitResponse.confirm_deadline",
        "prisma.v1.TelemetryUpdate.at",
    ] {
        cfg = cfg.field_attribute(ts, "#[serde(serialize_with = \"crate::ser::timestamp\")]");
    }
    cfg.compile_fds(fds)?;
    println!("cargo:rerun-if-changed={proto_root}");
    Ok(())
}
