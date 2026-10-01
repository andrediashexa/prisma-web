-- Roteadores Prisma gerenciados por esta instância.
-- token_enc = nonce (12 bytes) || ChaCha20-Poly1305(token), com o id como dado associado.
CREATE TABLE routers (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    api_url     TEXT NOT NULL,
    token_enc   BYTEA,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX routers_name_key ON routers (lower(name));

-- Sem FK: o evento continua apontando para o roteador mesmo depois de removido.
ALTER TABLE audit_log ADD COLUMN router_id UUID;
CREATE INDEX audit_log_router_id_idx ON audit_log (router_id);

-- Layout da homepage de cada usuário. O formato é definido pelo front.
CREATE TABLE dashboards (
    user_id    UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    layout     JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
