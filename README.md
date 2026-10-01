# prisma-web

Interface web para o **Prisma**, roteador em desenvolvimento. Gerencia **vários Prismas ao mesmo
tempo**, roda inteira em Docker, com suporte completo a IPv4 e IPv6, contas locais, homepage
personalizável por usuário e log de todas as mudanças.

```
             IPv4 / IPv6 :80
                   │
             ┌─────▼─────┐
             │   proxy   │  Caddy — ponto único de entrada
             └──┬─────┬──┘
        /api/*  │     │  resto
          ┌─────▼─┐ ┌─▼─────┐
          │ back  │ │ front │  Rust (Axum)  ·  Next.js + shadcn/ui
          └─┬───┬─┘ └───────┘
            │   │ API HTTP (back/crates/prisma-api)
     ┌──────▼┐ ┌▼──────────────────────┐
     │  db   │ │ Prisma · Prisma · …   │  PostgreSQL  ·  N roteadores cadastrados
     └───────┘ └───────────────────────┘
```

| Container     | Papel                                                                 |
|---------------|-----------------------------------------------------------------------|
| `proxy`       | Caddy. Publica a porta 80 em IPv4 e IPv6 e roteia `/api` → back.      |
| `front`       | Next.js 16, shadcn/ui, Recharts. Painéis, gráficos e telas de gestão. |
| `back`        | Rust/Axum. Login, sessões, papéis, log de mudanças, ponte com o Prisma. |
| `db`          | PostgreSQL 17. Usuários (hash Argon2id), sessões e log de mudanças. Sem porta exposta. |
| `prisma-mock`, `prisma-mock-2` | Dois Prismas simulados (perfil `mock`) para desenvolver sem o roteador real. |

## Subindo

```bash
cp .env.example .env        # defina POSTGRES_PASSWORD e APP_SECRET_KEY (openssl rand -base64 32)
docker compose up -d --build
docker compose logs back | grep "administrador inicial"   # senha gerada do admin
```

Acesse `http://<ip-v4>/` ou `http://[<ip-v6>]/`. No primeiro login a troca de senha é exigida.

## Vários Prismas

Cada roteador é cadastrado em **Roteadores** (só administradores) com nome, URL da API e token
opcional — o botão *Testar* valida a conexão antes de salvar. O token fica cifrado no banco com
ChaCha20-Poly1305 usando `APP_SECRET_KEY`; se a chave mudar, os tokens precisam ser recadastrados.

O back mantém um monitor em segundo plano que consulta todos os Prismas a cada 5 s; a interface lê
esse cache, então um roteador lento ou fora do ar não atrasa as telas. Cada alteração no log de
mudanças registra em qual roteador aconteceu.

Para testar com os mocks: o primeiro (`http://prisma-mock:8080`) é cadastrado sozinho a partir de
`PRISMA_API_URL`; cadastre o segundo com `http://prisma-mock-2:8080` e token `filial-token-de-teste`.

## Homepage personalizável

A *Visão geral* é uma grade de widgets salva por usuário. Em **Personalizar** dá para adicionar,
remover, arrastar para reordenar, escolher a largura e configurar de qual Prisma cada widget mostra
dados. Widgets: frota de roteadores, recursos por roteador (gráfico comparativo), indicadores, tráfego,
interfaces e atividade recente. *Restaurar padrão* volta ao layout inicial.

## Acesso e auditoria

- **Papéis:** `admin` (tudo), `operator` (altera o roteador, vê o log), `viewer` (só leitura).
- **Sessões:** cookie `HttpOnly` + `SameSite=Strict`; no banco fica só o SHA-256 do token.
  Trocar senha, desativar ou mudar papel encerra as sessões do usuário afetado.
- **Força bruta:** 10 falhas em 15 min bloqueiam o IP — em IPv6, o /64 inteiro.
- **Log de mudanças** (`audit_log`): logins (com sucesso e falha), gestão de usuários e toda
  alteração no roteador com valor anterior e novo, usuário e IP de origem.
- Sempre resta ao menos um administrador ativo.

## IPv6

- As redes Docker são dual-stack (`enable_ipv6`, prefixos ULA `fd70:5057::/48`).
- Todos os serviços escutam em `[::]`; IPv4 mapeado (`::ffff:a.b.c.d`) é normalizado.
- A API usa notação CIDR para IPv4 e IPv6 igualmente; MTU mínimo é 1280 (RFC 8200).

> Conexões via `localhost`/`127.0.0.1` passam pelo proxy do Docker e aparecem no log com o IP
> do gateway da rede (`172.30.57.1`). Clientes reais, IPv4 ou IPv6, mantêm o IP de origem.

## Conectando ao Prisma real

O contrato está em [`docs/prisma-api.md`](docs/prisma-api.md) e, como código, em
`back/crates/prisma-api`. Quando o Prisma implementar a API, cadastre-o pela interface com a URL
(ex.: `http://[2001:db8::1]:8080`) e o token. Para desligar os mocks, deixe `COMPOSE_PROFILES=`
vazio no `.env`.

## HTTPS

Hoje o acesso é HTTP puro. Para ativar HTTPS: em `proxy/Caddyfile`, troque `:80` pelo
domínio e remova `auto_https off`; publique a 443 no compose; use `COOKIE_SECURE=true`.

## Desenvolvimento

```bash
# back: testes do workspace Rust
docker run --rm -v "$PWD/back":/src -w /src rust:1-bookworm cargo test --workspace

# front: lint e build
docker run --rm -v "$PWD/front":/w -w /w node:22-alpine sh -c "npm ci && npm run lint && npm run build"
```
