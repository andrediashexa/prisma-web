//! Tipos, cliente e servidor gRPC da API do Prisma (`prisma.v1`), gerados de
//! `back/proto/prisma/v1/prisma.proto`. Para atualizar, copie o proto novo do
//! Prisma para lá e recompile.

pub mod v1 {
    tonic::include_proto!("prisma.v1");
}

/// Serializadores usados pelos atributos gerados no build.rs.
mod ser {
    use serde::Serializer;

    use crate::v1::diagnostic::Severity;

    /// Timestamp do protobuf como RFC 3339 (o que o front entende).
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

/// Metadado de resposta com o relato do VTY sobre uma chamada recusada.
pub const DIAGNOSTICS_KEY: &str = "prisma-diagnostics-bin";

/// Extrai os `Diagnostics` que o Prisma anexa a um status de erro.
pub fn diagnostics(status: &tonic::Status) -> Option<v1::Diagnostics> {
    use prost::Message;
    let raw = status.metadata().get_bin(DIAGNOSTICS_KEY)?.to_bytes().ok()?;
    v1::Diagnostics::decode(raw).ok()
}

/// Anexa `Diagnostics` a um status de erro (usado pelo mock).
pub fn with_diagnostics(mut status: tonic::Status, diag: &v1::Diagnostics) -> tonic::Status {
    use prost::Message;
    status.metadata_mut().insert_bin(
        DIAGNOSTICS_KEY,
        tonic::metadata::MetadataValue::from_bytes(&diag.encode_to_vec()),
    );
    status
}
