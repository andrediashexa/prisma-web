# prisma-web × Prisma: o que falta do lado do Prisma

**TL;DR:** lista do que o prisma-web precisa saber ou receber do Prisma para usar o contrato
`prisma.v1` por inteiro. Dois itens bloqueiam o uso com um equipamento real: a gramática de edição
de interface (1.1) e o acesso ao equipamento (1.2). Os demais são lacunas contornadas hoje e
sugestões de campos novos, todas compatíveis com a v1.

As palavras-chave MUST, SHOULD e MAY seguem a [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| 5W2H | |
|---|---|
| **What** | Perguntas abertas e lacunas do proto vistas pelo cliente web. |
| **Why** | A integração foi feita contra o proto e um mock. O que o mock supõe precisa ser confirmado pelo Prisma. |
| **Who** | Quem mantém o servidor de gerenciamento do Prisma. |
| **Where** | `back/proto/prisma/v1/prisma.proto` (cópia) e o servidor gRPC do Prisma. |
| **When** | Antes de cadastrar o primeiro equipamento real. |
| **How** | Responder a seção 1. Os campos da seção 2 entram como adições no `prisma.v1`. |
| **How much** | 5 perguntas e 6 sugestões. Nenhuma exige `prisma.v2`. |

Legenda: **🔴 bloqueia** · **🟡 dá para contornar** · **🟢 sugestão**

---

## 1. Perguntas

### 🔴 1.1 Gramática para editar uma interface
A tela de Interfaces gera linhas de VTY para descrição, MTU e ligar/desligar. Hoje o prisma-web
**supõe** o seguinte — confirme ou corrija:

| Ação | `path` | `lines` |
|---|---|---|
| Descrição | `["interface <nome>"]` | `description <texto>` · `no description` |
| MTU | `["interface <nome>"]` | `mtu <n>` |
| Desligar / ligar | `["interface <nome>"]` | `shutdown` · `no shutdown` |

O mapeamento fica num arquivo só (`front/src/lib/vty.ts`); corrigir lá ajusta a tela inteira.
O editor de configuração livre não depende disso — ele manda as linhas que o usuário digitar.

### 🔴 1.2 Acesso ao equipamento
- Endereço e porta do servidor gRPC (o prisma-web aceita IPv4 e IPv6).
- Sem certificado por enquanto: o servidor aceita **gRPC sem TLS** (h2c)? Se exigir mTLS mesmo
  em laboratório, me avise que eu adianto essa parte.
- Qual conta/papel as chamadas usam quando não há certificado?

### 🟡 1.3 `Show` e comandos que demoram
`ping` e `traceroute` passam pelo `Show`. Quanto tempo o Prisma segura a chamada? O prisma-web
usa **30 s** de timeout no console. Comandos com saída contínua (`ping` sem `count`) ficariam presos.

### 🟡 1.4 Candidatos abandonados
Se o prisma-web cair com um candidato aberto, o Prisma o descarta sozinho? Depois de quanto tempo?
O prisma-web fecha os seus ao terminar, mas não tem como garantir isso numa queda.

### 🟡 1.5 Uma conta para todos os usuários da web
Como a identidade é a conta do certificado (ou a conta padrão, sem certificado), todos os
usuários do prisma-web aparecem como **a mesma conta** no Prisma. Para a trilha do equipamento
continuar útil, o prisma-web prefixa o comentário de todo commit com o usuário:
`[prisma-web:joao] <comentário>`. Funciona para vocês?

Consequência: `Confirm` não leva `candidate_id` e vale para a conta. Com uma conta só, um usuário
da web confirmaria o `commit confirmed` de outro. O prisma-web mostra quem fez o commit pendente
e só deixa confirmar quem fez (ou um admin), mas a trava é só do lado da web.

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
