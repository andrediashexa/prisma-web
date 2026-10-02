-- Per-router access (#6). With no row, a user's global role applies to the
-- router, as before. A row overrides it for that router, up or down; 'none'
-- hides the router from the user. Global administrators are never limited.
CREATE TABLE router_access (
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    router_id  UUID NOT NULL REFERENCES routers (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('none', 'viewer', 'operator', 'admin')),
    granted_by TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, router_id)
);
CREATE INDEX router_access_router ON router_access (router_id);
