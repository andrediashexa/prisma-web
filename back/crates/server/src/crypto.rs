//! Criptografia simétrica dos segredos guardados no banco (tokens dos roteadores).

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

const NONCE_LEN: usize = 12;

pub struct SecretBox(ChaCha20Poly1305);

impl SecretBox {
    pub fn new(key: &[u8; 32]) -> Self {
        Self(ChaCha20Poly1305::new(Key::from_slice(key)))
    }

    /// `aad` amarra o segredo ao seu dono (ex.: id do roteador), impedindo
    /// que um valor cifrado seja copiado para outra linha.
    pub fn encrypt(&self, plain: &str, aad: &[u8]) -> Vec<u8> {
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ct = self
            .0
            .encrypt(&nonce, Payload { msg: plain.as_bytes(), aad })
            .expect("ChaCha20-Poly1305 não falha ao cifrar");
        let mut out = nonce.to_vec();
        out.extend(ct);
        out
    }

    pub fn decrypt(&self, data: &[u8], aad: &[u8]) -> anyhow::Result<String> {
        anyhow::ensure!(data.len() > NONCE_LEN, "segredo cifrado truncado");
        let (nonce, ct) = data.split_at(NONCE_LEN);
        let plain = self
            .0
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
            .map_err(|_| anyhow::anyhow!("não foi possível decifrar o segredo (APP_SECRET_KEY mudou?)"))?;
        Ok(String::from_utf8(plain)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_aad_binding() {
        let b = SecretBox::new(&[7u8; 32]);
        let c = b.encrypt("tok3n", b"router-a");
        assert_eq!(b.decrypt(&c, b"router-a").unwrap(), "tok3n");
        assert!(b.decrypt(&c, b"router-b").is_err());
        assert!(SecretBox::new(&[8u8; 32]).decrypt(&c, b"router-a").is_err());
    }
}
