# prisma-web × Prisma: o que falta do lado do Prisma

**TL;DR:** o que o prisma-web precisa saber ou receber do Prisma para usar o contrato `prisma.v1`
por inteiro. O guia da API e um equipamento de laboratório já responderam parte das perguntas.
O que bloqueia o uso com um equipamento real agora é o **mTLS obrigatório** (#4) e o equipamento
estar na 0.148.3, sem API. As lacunas da seção 2 são sugestões de campos novos, todas compatíveis
com a v1.

As palavras-chave MUST, SHOULD e MAY seguem a [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| 5W2H | |
|---|---|
| **What** | Perguntas abertas e lacunas do proto vistas pelo cliente web. |
| **Why** | A integração foi feita contra o proto e um mock. O que o mock supõe precisa ser confirmado pelo Prisma. |
| **Who** | Quem mantém o servidor de gerenciamento do Prisma. |
| **Where** | `back/proto/prisma/v1/prisma.proto` (cópia) e o servidor gRPC do Prisma. |
| **When** | Antes de cadastrar o primeiro equipamento real. Revisado em 2026-10-01 com o guia da API (issue #9). |
| **How** | Responder a seção 1. Os campos da seção 2 entram como adições no `prisma.v1`. |
| **How much** | 5 perguntas (1 respondida, 2 em parte, 2 abertas) e 6 sugestões. Nenhuma exige `prisma.v2`. |

Legenda: **🔴 bloqueia** · **🟡 dá para contornar** · **🟢 sugestão**

---

## 1. Perguntas

Fontes das respostas: **guia** é o `docs/prisma-api.md` (guia oficial da API, copiado sem
alterações) e **equipamento** é o `show running-config` e o `show version` de um Prisma 0.148.3
de laboratório, lidos em 2026-10-01 sem alterar nada (issue #9).

### 🟡 1.1 Gramática para editar uma interface — respondida em parte
O equipamento confirma `description <texto>`, `mtu <n>`, `shutdown` e **`ipv4 address <cidr>`**
(e não `ip address`). Cada bloco termina em `exit`, e o `shutdown` vem antes do `mtu`. O mock
segue esse formato desde a issue #9.

| Ação | `path` | `lines` | Situação |
|---|---|---|---|
| Descrição | `["interface <nome>"]` | `description <texto>` · `no description` | `description` confirmado; `no description` **não confirmado** |
| MTU | `["interface <nome>"]` | `mtu <n>` | confirmado |
| Desligar / ligar | `["interface <nome>"]` | `shutdown` · `no shutdown` | `shutdown` confirmado; `no shutdown` **não confirmado** |

Falta confirmar as formas com `no`. Fazer isso exigiria entrar em `configure` no equipamento, o
que não foi feito. O mapeamento fica num arquivo só (`front/src/lib/vty.ts`).

### 🔴 1.2 Acesso ao equipamento — respondida
- **Porta 50051** no endereço de gerência (`api listen-address`). A API vem desligada
  (`api enabled yes` a liga) e existe **a partir da 0.149.0**. O equipamento de laboratório está
  na 0.148.3 e ainda não tem API. (guia, equipamento)
- **Só mTLS**: o servidor não sobe sem `server.key`, `server.crt` e `clients-ca.crt`, e recusa
  cliente sem certificado. Não existe modo sem TLS. Por isso a #4 é pré-requisito para usar um
  equipamento real. (guia)
- **A conta é o CN do certificado do cliente**, e o papel vem do login do VTY: `prisma-admin`
  configura tudo, `prisma-cgnat` só o CGNAT e os demais só leem. (guia)
- O cliente MUST informar o nome que está no certificado do servidor (`domain_name`, por exemplo
  `prisma-api`), ou o certificado MUST trazer o endereço discado no `subjectAltName`. (guia)

### 🟡 1.3 `Show` e comandos que demoram — respondida em parte
O `Show` aceita `show`, `ping`, `traceroute`, `mtr` e `monitor` (guia). Ainda não se sabe quanto
tempo o Prisma segura uma chamada nem o que acontece com `monitor`, que tem saída contínua. O
console do prisma-web corta em **30 s**.

### 🟡 1.4 Candidatos abandonados — aberta
O guia diz que cada candidate aberto é **um processo no equipamento**, o que torna o vazamento
mais caro, mas não diz se o Prisma descarta candidates abandonados. O prisma-web fecha os seus ao
sair da tela e depois de 1 h.

### 🟡 1.5 Uma conta para todos os usuários da web — aberta, com uma indicação
O guia descreve **um certificado de cliente por conta**. Isso abre a opção de cada usuário da web
ter o próprio certificado e aparecer com o próprio nome na trilha do equipamento. A decisão ficou
para a #4. Até lá, todo commit leva `[prisma-web:<usuário>]` no comentário, e o `Confirm`, que vale
para a conta, só é aceito do autor ou de um admin, uma trava que existe só do lado da web.

---

## 2. Lacunas no proto que limitam a interface

### 🟡 2.1 CPU e memória só como texto
`SystemInfo` traz `cpu_text` e `memory_text` verbatim, sem números. O painel não consegue mostrar
medidor nem gráfico de uso. Hoje mostra os workers, hugepages e o texto.

Sugestão (campos novos, compatível com v1):
```proto
message SystemInfo {
  // ...
  uint64 memory_total_bytes = 10;
  uint64 memory_used_bytes = 11;
  // Carga de cada worker do VPP (vetores/chamada ou % de loops com trabalho),
  // já que o polling deixa a CPU sempre em 100%.
  repeated WorkerLoad worker_load = 12;
}
message WorkerLoad { uint32 cpu = 1; double vectors_per_call = 2; double busy_ratio = 3; }
```

### 🟡 2.2 Tabela de rotas não tipada
Não existe `ListRoutes`; a tela de roteamento mostra o texto de `show ip route` e
`show ipv6 route` pelo `Show`. Com um rpc tipado daria para filtrar, buscar e contar por protocolo:
```proto
rpc ListRoutes(ListRoutesRequest) returns (ListRoutesResponse);
message Route {
  string vrf = 1; string prefix = 2;              // "2001:db8::/32", ambas as famílias
  repeated string next_hops = 3; string protocol = 4; uint32 distance = 5; uint32 metric = 6;
  bool selected = 7;
}
```

### 🟢 2.3 Velocidade do link
`Interface` não tem velocidade. Com `uint64 speed_bps` daria para mostrar a utilização do link em %.

### 🟢 2.4 Histórico de contadores
`TelemetryService` só entrega amostras ao vivo, então o prisma-web guarda o histórico em memória
(24 h). Se o back reiniciar, o gráfico recomeça do zero. Se o Prisma tiver um histórico curto
(ex.: últimas 24 h em 1 min), um rpc para lê-lo deixaria os gráficos completos desde o início.

### 🟢 2.5 Identificar o próprio commit nos eventos
Os eventos `commit` do `Subscribe` entram no log do prisma-web como *alterações feitas no
equipamento*. Se `Event` trouxesse a `revision` (ou o comentário do commit), o prisma-web
conseguiria juntar o evento ao commit que ele mesmo fez, sem duplicar a entrada.

### 🟢 2.6 Health check
Hoje o prisma-web usa `GetVersion` para saber se o Prisma está vivo. Se o servidor expuser
`grpc.health.v1.Health`, fica mais leve e padrão.

---

## 3. Como o prisma-web usa cada rpc

| rpc | Onde aparece |
|---|---|
| `GetVersion`, `GetSystem`, `GetSessionsSummary` | Status da frota (a cada 5 s), painel do roteador |
| `ListInterfaces` | Interfaces, widget de interfaces |
| `Subscribe` (contadores, CGNAT, eventos) | Gráficos de tráfego e sessões; eventos vão para o log de mudanças |
| `ListPools`, `GetSubscriber` | Tela de CGNAT, busca de assinante |
| `ListBgpNeighbors`, `ListOspfNeighbors`, `ListIsisAdjacencies`, `ListVrrp`, `ListBundles` | Tela de roteamento |
| `Show` | Console de comandos (operador ou admin) e texto das rotas |
| `OpenCandidate` → `Edit` → `Compare` → `Check` → `Commit` → `CloseCandidate` | Editor de configuração e edição de interfaces |
| `Confirm` | Aviso de *commit confirmed* pendente, com contagem regressiva |
| `GetRunning`, `ListRevisions`, `Rollback`, `Save` | Tela de configuração |

## 4. Mantendo o proto em dia

O proto é copiado para `back/proto/prisma/v1/prisma.proto`. Ao mudar no Prisma, copie de novo e
rode o build: o cliente gRPC é gerado a partir dele. Pelas regras de compatibilidade do próprio
proto (só adicionar), um prisma-web antigo continua funcionando com um Prisma novo.
