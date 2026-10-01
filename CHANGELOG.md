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

## 0.4.1 - Hostname do Prisma — 2026-10-01

### Correções
- O nome dos Prismas 0.148.4 aparecia vazio: a API deles devolve o hostname vazio (bug do Prisma, corrigido na 0.148.6). O prisma-web passa a tirar o nome da configuração em uso, lida no máximo a cada 10 min (#13).
- "Reinício pendente" passa a dizer "reboot pendente para concluir o upgrade" e explica que o dataplane só troca de versão no reboot (#13).

## 0.4.0 - mTLS com o Prisma real — 2026-10-01

### Mudanças de comportamento
- O prisma-web conecta a um Prisma real por **mTLS**. Cada roteador escolhe um perfil TLS (diretório de certificados do host, montado somente leitura) e o nome do servidor no certificado. O teste de conexão mostra a conta (CN) usada (#4).
- `https://` exige um perfil TLS, e `http://` fica só para os simulados (#4).
- O `prisma-mock-2` passa a exigir mTLS como o equipamento. Os certificados de desenvolvimento são gerados pelo serviço `dev-certs` (#4).
- As interfaces `tap*` internas que o Prisma 0.148.4 lista são escondidas até a 0.148.5 (#4).
- O gráfico de tráfego começa por uma interface com link (#4).

### Correções
- A documentação dizia que a API do Prisma existia na 0.148.3, por uma leitura feita no meio de um upgrade. Ela existe a partir da 0.148.4 (`fix/api-desde-0.148.4`).
- As respostas da equipe do Prisma às perguntas de integração foram registradas em `docs/prisma-integracao.md` (`fix/api-desde-0.148.4`).

### Interno
- `scripts/e2e.py`: 49 verificações, incluindo os casos de recusa do mTLS, e o modo `--lab`, só de leitura, para um Prisma real (10 verificações passaram contra o 0.148.4) (#4).

### Limites
- Trocar ou incluir certificados exige acesso ao host, e não à tela (#4).

## 0.3.1 - Guia da API do Prisma — 2026-10-01

### Mudanças de comportamento
- O Prisma simulado imprime e aceita a configuração de interface do jeito do equipamento real: `ipv4 address` (e não mais `ip address`), `shutdown` antes do `mtu` e o bloco fechado com `exit` (#9).

### Correções
- O README dizia que um Prisma real podia ser cadastrado com `http://`. O guia da API mostra que o servidor do Prisma só aceita mTLS, então isso só funciona depois da #4 (#9).

### Interno
- Guia oficial da API (`docs/prisma-api.md`) e proto mais novo copiados sem alterações. O código gerado é idêntico ao anterior (#9).
- Perguntas ao Prisma respondidas com a fonte de cada resposta em `docs/prisma-integracao.md` (#9).
- Formato de versões: tag `X.Y.Z`, release `X.Y.Z - nome`, patch como pré-release e major proibida. Tags e releases anteriores migradas (#8).

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
