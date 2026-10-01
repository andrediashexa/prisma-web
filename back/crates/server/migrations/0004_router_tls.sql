-- mTLS por roteador (issue #4). O perfil aponta para um diretório com ca.crt e o
-- par do cliente; nenhum segredo fica no banco.
ALTER TABLE routers
    ADD COLUMN tls_profile TEXT,
    ADD COLUMN tls_server_name TEXT;

-- https:// exige perfil e http:// não aceita perfil: o banco não guarda meio-termo.
ALTER TABLE routers ADD CONSTRAINT routers_tls_consistent CHECK (
    (api_url LIKE 'https://%') = (tls_profile IS NOT NULL)
    AND (tls_profile IS NULL) = (tls_server_name IS NULL)
);
