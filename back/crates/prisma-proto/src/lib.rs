//! Types, gRPC client and server of the Prisma API (`prisma.v1`), generated from
//! `back/proto/prisma/v1/prisma.proto`. To update, copy Prisma's new proto
//! there and rebuild.

pub mod v1 {
    tonic::include_proto!("prisma.v1");
}

/// Serializers used by the attributes generated in build.rs.
mod ser {
    use serde::Serializer;

    use crate::v1::diagnostic::Severity;

    /// Protobuf timestamp as RFC 3339 (what the front end understands).
    pub fn timestamp<S: Serializer>(ts: &Option<prost_types::Timestamp>, s: S) -> Result<S::Ok, S::Error> {
        match ts.as_ref().and_then(|t| chrono::DateTime::from_timestamp(t.seconds, t.nanos.max(0) as u32)) {
            Some(dt) => s.serialize_str(&dt.to_rfc3339()),
            None => s.serialize_none(),
        }
    }

    pub fn severity<S: Serializer>(v: &i32, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(match Severity::try_from(*v) {
            Ok(Severity::Error) => "error",
            Ok(Severity::Warning) => "warning",
            Ok(Severity::Note) => "note",
            _ => "unspecified",
        })
    }
}

/// Response metadata carrying the VTY's report on a rejected call.
pub const DIAGNOSTICS_KEY: &str = "prisma-diagnostics-bin";

/// Extracts the `Diagnostics` that Prisma attaches to an error status.
pub fn diagnostics(status: &tonic::Status) -> Option<v1::Diagnostics> {
    use prost::Message;
    let raw = status.metadata().get_bin(DIAGNOSTICS_KEY)?.to_bytes().ok()?;
    v1::Diagnostics::decode(raw).ok()
}

/// Attaches `Diagnostics` to an error status (used by the mock).
pub fn with_diagnostics(mut status: tonic::Status, diag: &v1::Diagnostics) -> tonic::Status {
    use prost::Message;
    status.metadata_mut().insert_bin(
        DIAGNOSTICS_KEY,
        tonic::metadata::MetadataValue::from_bytes(&diag.encode_to_vec()),
    );
    status
}
