# Changelog

**TL;DR:** o que mudou em cada versão do prisma-web, da mais nova para a mais antiga, com as issues
fechadas. Em cada versão vêm primeiro as mudanças de comportamento, depois as correções e por último
o trabalho interno. As versões seguem `0.x.y` (ver `CONTRIBUTING.md`, seção 5).

| 5W2H | |
|---|---|
| **What** | Histórico das releases. |
| **Why** | Quem atualiza precisa saber o que muda para si, e não a lista de commits. |
| **Who** | Quem opera ou atualiza o prisma-web. |
| **Where** | Cada versão tem uma tag `vX.Y.Z` e uma release no GitHub com o mesmo texto. |
| **When** | Uma entrada a cada merge no `master`. |
| **How** | Escrito à mão a partir das issues, nunca gerado dos commits. |
| **How much** | Uma seção por versão. |

## [0.2.0] — 2026-10-01

### Novidades
- Vários Prismas: cadastro com teste de conexão, status da frota em cache (de ~3 s para 4–7 ms com um roteador offline) e log de mudanças por roteador (#2).
- Homepage em widgets, salva por usuário (#2).

### Limites
- Os papéis valem para todos os roteadores.

## [0.1.0] — 2026-09-30

### Novidades
- Primeira versão: containers separados (proxy, front, back, db, mock), acesso IPv4 e IPv6, contas locais com Argon2id, log de mudanças, painel com gráficos (#1).
