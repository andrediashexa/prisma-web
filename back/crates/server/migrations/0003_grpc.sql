-- O Prisma autentica por mTLS (certificado do cliente), não por token.
-- Os campos de certificado entram numa migração própria quando o mTLS for ligado.
ALTER TABLE routers DROP COLUMN token_enc;
