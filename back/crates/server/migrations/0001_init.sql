-- Usuários locais do prisma-web. Senhas guardadas apenas como hash Argon2id.
CREATE TABLE users (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username             TEXT NOT NULL,
    password_hash        TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
    disabled             BOOLEAN NOT NULL DEFAULT FALSE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

-- Sessões de login. Só o SHA-256 do token fica no banco.
CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   BYTEA NOT NULL UNIQUE,
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    ip           INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Log de mudanças e eventos de segurança. Só recebe INSERT pela aplicação.
-- username é copiado para o registro sobreviver à exclusão do usuário.
CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id    UUID REFERENCES users (id) ON DELETE SET NULL,
    username   TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    success    BOOLEAN NOT NULL,
    ip         INET,
    details    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action);
