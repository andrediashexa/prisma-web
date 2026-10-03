//! Types, gRPC client and server of the Prisma API (`prisma.v1`), generated from
//! `back/proto/prisma/v1/prisma.proto`. To update, copy Prisma's new proto
//! there and rebuild.

pub mod vty;

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

    /// `REASON_STALE_BASE` → `"stale_base"`; unknown or unset → `"unspecified"` (#558).
    pub fn reason<S: Serializer>(v: &i32, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::reason_name(*v))
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

#[cfg(test)]
mod tests {
    use crate::v1::SystemInfo;

    /// A field the box could not read is unset and MUST reach the UI as null,
    /// never as the epoch (#20).
    #[test]
    fn unset_and_set_timestamps_serialize() {
        let mut s = SystemInfo::default();
        let v = serde_json::to_value(&s).unwrap();
        assert!(v["boot_time"].is_null() && v["release_installed_at"].is_null());
        s.boot_time = Some(prost_types::Timestamp { seconds: 1_790_000_000, nanos: 0 });
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["boot_time"], "2026-09-21T14:13:20+00:00");
        assert_eq!(v["dataplane_restarted"], false);
    }
}

/// A refusal reason (Prisma 0.149.18) by name, lowercase, as the web API shows it.
pub fn reason_name(v: i32) -> String {
    v1::diagnostics::Reason::try_from(v)
        .map(|r| r.as_str_name().trim_start_matches("REASON_").to_ascii_lowercase())
        .unwrap_or_else(|_| "unspecified".into())
}
