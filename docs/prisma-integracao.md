# prisma-web × Prisma: o que falta do lado do Prisma

**TL;DR:** o que o prisma-web precisa saber ou receber do Prisma para usar o contrato `prisma.v1`
por inteiro. As cinco perguntas estão respondidas, e as sugestões de campos novos foram aceitas
pelo Prisma (prismarouting #533). A API existe a partir da 0.148.4, está habilitada no equipamento
de laboratório, e o prisma-web já conecta a ele por mTLS (#4). As lacunas da seção 2 são sugestões de campos novos, todas compatíveis
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
| **How much** | 5 perguntas, todas respondidas, e 6 sugestões, aceitas como prismarouting #533. Nenhuma exige `prisma.v2`. |

Legenda: **🔴 bloqueia** · **🟡 dá para contornar** · **🟢 sugestão**

---

## 1. Perguntas

Fontes: **guia** é o `docs/prisma-api.md`; **equipamento** é o Prisma de laboratório
`192.0.2.166`; **Prisma** são as respostas da sessão que mantém o Prisma Routing, conferidas
contra o código ou o equipamento e repassadas em 2026-10-01.

### ✅ 1.1 Gramática para editar uma interface — respondida
Dentro de `interface <nome>` valem `description <texto>`, `no description`, `mtu <n>`,
`shutdown`, `no shutdown` e **`ipv4 address <cidr>`** (e não `ip address`). Os blocos fecham com
`exit`. As formas com `no` foram confirmadas com `commit check` no equipamento, sem aplicar nada,
e produzem o diff esperado no `compare` (Prisma). O mock segue esse formato desde a issue #9, e o
mapeamento fica em `front/src/lib/vty.ts`.

### ✅ 1.2 Acesso ao equipamento — respondida
- **A API existe a partir da 0.148.4** e vem desligada; `api enabled yes` a liga. O guia dizia
  "0.149.0", o que vai ser corrigido na 0.148.5. A 0.148.3 publicada **não** tem `apiserver.py`
  (Prisma, confirmado inspecionando a imagem `prisma-mgmt:0.148.3`). No laboratório, a 0.148.4
  está com a API **habilitada** e os certificados em `/etc/prisma-routing/api/`.
- **Porta 50051** no endereço de gerência. Endpoint de teste: `https://192.0.2.166:50051`.
- **Só mTLS**: o servidor não sobe sem certificados e recusa cliente sem certificado (guia).
- **A conta é o CN do certificado do cliente**, e o papel vem do VTY. O certificado do prisma-web
  tem CN `prisma-web`, com papel de administrador (Prisma).
- **Nome do servidor no certificado: `prisma-api`**, e o IP também está no SAN (Prisma).
- A 0.148.4 lista no `ListInterfaces` as interfaces `tap*` internas do linux_cp; isso será
  corrigido na 0.148.5, e até lá o back as esconde (Prisma).

### ✅ 1.3 `Show` e comandos que demoram — respondida
Cada chamada roda no processo da conta, com **300 s** de limite no servidor. O corte de 30 s do
console é mais curto, e isso é aceitável. `monitor` é uma tela ao vivo que o VTY recusa sem
terminal: pelo `Show` ele não transmite. Contadores ao vivo vêm do `TelemetryService.Subscribe`.
(Prisma)

### ✅ 1.4 Candidatos abandonados — respondida
O servidor fecha um candidate **parado por 30 min** e o processo operacional de uma conta parado
por 5 min. A limpeza acontece na chamada seguinte à API, e não por relógio (Prisma). O prisma-web
fecha os seus depois de 1 h, mais do que os 30 min do servidor, e isso precisa de ajuste: depois
de 30 min parado, o candidate pode já não existir.

### ✅ 1.5 Uma conta para todos os usuários da web — respondida
Um certificado por usuário é o recomendado no futuro, para cada um aparecer com o próprio nome na
trilha do equipamento. Para começar, a conta `prisma-web` com `[prisma-web:<usuário>]` no
comentário do commit é aceitável. O `Confirm` vale para a conta inteira no equipamento (Prisma).

### Sugestões da seção 2
Foram aceitas pelo Prisma como a issue **#533 do prismarouting**, todas como adições compatíveis
com o `prisma.v1`. O `ListRoutes` vai precisar de paginação e filtro, porque uma tabela completa
tem cerca de 1 milhão de rotas.

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
