# Changelog

**TL;DR:** o que mudou em cada versão do prisma-web, da mais nova para a mais antiga, com as issues
fechadas. Em cada versão vêm primeiro as mudanças de comportamento, depois as correções e por último
o trabalho interno. As versões seguem `0.x.y` e cada uma tem um nome (ver `CONTRIBUTING.md`, seção 5):
versões minor são publicadas como release, e versões patch como pré-release.

| 5W2H | |
|---|---|
| **What** | Histórico das releases. |
| **Why** | Quem atualiza precisa saber o que muda para si, e não a lista de commits. |
| **Who** | Quem opera ou atualiza o prisma-web. |
| **Where** | Cada versão tem uma tag `X.Y.Z` e uma release `X.Y.Z - <nome>` no GitHub, com o mesmo texto. |
| **When** | Uma entrada a cada merge no `master`. |
| **How** | Escrito à mão a partir das issues, nunca gerado dos commits. |
| **How much** | Uma seção por versão. |

## 0.3.0 - Integração gRPC — 2026-10-01

### Mudanças incompatíveis
- O prisma-web passa a falar com o Prisma **só por gRPC** (`prisma.v1`). O contrato JSON e o token de acesso deixam de existir. Roteadores já cadastrados precisam do endereço gRPC (`http://host:50051`), e `https://` é recusado até existir mTLS (#4) (#3).

### Novidades
- Alterações pelo modelo do VTY: candidate, diff, `commit check`, confirmação explícita dos portões `remap`/`cutoff`/`diverge` e `commit confirmed` com aviso e contagem regressiva. O Prisma desfaz sozinho se ninguém confirmar (#3).
- Recusas do VTY aparecem com a mensagem, o caminho e a linha citados (#3).
- Telas novas por roteador: Configuração (em uso, revisões, rollback, editor, salvar para o boot), CGNAT (pools e busca de assinante), Roteamento (BGP, OSPF, IS-IS, VRRP, bundles e rotas) e Console (#3).
- Gráficos de tráfego e de CGNAT alimentados pela telemetria do Prisma. Os widgets novos são CGNAT e vizinhos BGP (#3).
- O log de mudanças guarda o diff de cada commit, as confirmações, os comandos do console e os eventos do próprio equipamento, como o rollback automático (#3).
- O comentário de todo commit leva `[prisma-web:<usuário>]` para a trilha do equipamento (#3).

### Correções
- A tabela de Pools ficava escondida na tela de CGNAT por um problema de layout (#3).

### Interno
- Cliente gRPC gerado do proto com protox, sem `protoc`. Mock gRPC dos três serviços (#3).
- `scripts/e2e.py` (40 verificações pela API) e `scripts/check-docs.py` (regras do CONTRIBUTING) (#3).
- Adoção do CONTRIBUTING: documentação, issues e releases. As versões 0.1.0 e 0.2.0 foram registradas retroativamente (#1, #2, #3).

### Limites
- Sem TLS/mTLS (#4). O histórico dos gráficos fica em memória e zera quando o back reinicia (#7). Os papéis valem para todos os roteadores (#6).

## 0.2.0 - Vários Prismas e homepage — 2026-10-01

### Novidades
- Vários Prismas: cadastro com teste de conexão, status da frota em cache (de ~3 s para 4–7 ms com um roteador offline) e log de mudanças por roteador (#2).
- Homepage em widgets, salva por usuário (#2).

### Limites
- Os papéis valem para todos os roteadores.

## 0.1.0 - Estrutura inicial — 2026-09-30

### Novidades
- Primeira versão: containers separados (proxy, front, back, db, mock), acesso IPv4 e IPv6, contas locais com Argon2id, log de mudanças, painel com gráficos (#1).
