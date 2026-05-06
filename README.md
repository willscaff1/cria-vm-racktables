# VM RackTables Provisioner

Sistema web para provisionar maquinas virtuais no vCenter e registrar automaticamente os dados no RackTables.

O projeto foi criado como MVP operacional para o fluxo:

1. selecionar vCenter;
2. carregar inventario de cluster, host, datastore, rede e templates;
3. preencher dados da VM;
4. selecionar SID/IP livres no RackTables;
5. criar a VM no vCenter;
6. atualizar o objeto VM no RackTables;
7. alocar o IP na aba de IP do objeto;
8. registrar o resultado em historico local.

## Linguagem e stack

- Backend: Node.js puro, usando modulos nativos.
- Frontend: HTML, CSS e JavaScript puro.
- Persistencia local: arquivos JSON em `data/`.
- Integracao vCenter: REST API e SOAP.
- Integracao RackTables: requisicoes HTTP para telas/op handlers do RackTables.
- Dependencias externas: nenhuma.

Requisito:

```powershell
node --version
```

Use Node.js 20 ou superior.

## Estrutura

```text
.
|-- package.json
|-- README.md
|-- public/
|   |-- index.html
|   |-- app.js
|   `-- styles.css
|-- src/
|   `-- server.js
`-- data/
    |-- README.md
    |-- racktables.example.json
    |-- vcenters.example.json
    `-- jobs.example.json
```

Arquivos reais de runtime como `data/racktables.json`, `data/vcenters.json`, `data/jobs.json`, logs e payloads de teste ficam ignorados pelo Git porque podem conter credenciais, IPs internos e historico operacional.

## Como rodar

```powershell
npm start
```

URL padrao:

```text
http://localhost:3000
```

Health check:

```text
GET /api/health
```

Resposta:

```json
{
  "ok": true,
  "vcenterWriteEnabled": false
}
```

## Variaveis de ambiente

```powershell
$env:PORT="3000"
$env:RACKTABLES_URL="http://racktables.local"
$env:RACKTABLES_USERNAME="usuario"
$env:RACKTABLES_PASSWORD="senha"
```

Por seguranca, a escrita real no vCenter fica bloqueada por padrao. Para permitir criacao real de VM:

```powershell
$env:ENABLE_VCENTER_WRITE="true"
npm start
```

Sem essa variavel, o sistema aceita a solicitacao, mas bloqueia a etapa de criacao real no vCenter.

## Fluxo da tela

### Criar VM

Tela principal para criar a VM.

Campos principais:

- vCenter de destino.
- Modo de criacao:
  - a partir de template;
  - VM zerada com ISO.
- Template ou caminho ISO.
- Cluster, host, datastore e rede.
- Nome/label da VM.
- CPU, memoria e discos.
- SID/Common Name do RackTables.
- Rede IPv4 do RackTables.
- Asset Tag/IP.
- FQDN.
- Solicitante.
- Equipe responsavel.
- Orgao.
- Situacao.
- Tags.

### vCenters

Permite:

- cadastrar vCenter;
- testar conexao;
- resolver DNS;
- validar endpoint de sessao;
- remover cadastro local.

### Solicitacoes

Mostra historico local dos jobs:

- data;
- VM;
- status;
- erro;
- detalhes do vCenter;
- detalhes do RackTables;
- botao de retry quando a tentativa falha.

## Fluxo tecnico do backend

Arquivo principal:

```text
src/server.js
```

### Inicializacao

Ao iniciar, o servidor:

1. cria a pasta `data/` se nao existir;
2. garante arquivos JSON basicos;
3. sobe HTTP server em `PORT` ou `3000`;
4. serve arquivos estaticos de `public/`;
5. atende rotas `/api/*`.

### Rotas principais

```text
GET  /api/health
GET  /api/vcenters
POST /api/vcenters/test
POST /api/vcenters
POST /api/vcenters/:id/test
GET  /api/vcenters/:id/inventory
GET  /api/racktables/config
POST /api/racktables/config/test
POST /api/racktables/config
GET  /api/racktables/options
GET  /api/racktables/free-sids
GET  /api/racktables/networks
GET  /api/racktables/free-ips
GET  /api/jobs
POST /api/provision/preflight
POST /api/provision
```

## Fluxo de provisionamento

### 1. Preflight

Antes de criar VM, o sistema valida:

- payload obrigatorio;
- vCenter cadastrado;
- sessao vCenter;
- nome de VM ainda livre;
- template encontrado;
- host conectado e ligado;
- datastore com espaco;
- asset tag/IP sem duplicidade no RackTables.

Se o IP ja existir como asset tag em outro objeto RackTables, o sistema bloqueia antes de criar a VM.

### 2. Criacao no vCenter

Com `ENABLE_VCENTER_WRITE=true`, o sistema cria a VM.

#### Template de inventario

Usa SOAP porque o vCenter testado expunha templates de inventario melhor pelo SOAP do que por REST.

Etapas:

1. `CloneVM_Task`
2. `ReconfigVM_Task`
3. `PowerOnVM_Task`

Durante a reconfiguracao, ajusta:

- CPU;
- memoria;
- rede;
- discos.

#### Template de Content Library

Usa endpoint REST:

```text
/api/vcenter/vm-template/library-items/:id?action=deploy
```

#### VM zerada com ISO

Usa REST para criar uma VM vazia. A montagem real da ISO ainda precisa ser evoluida.

### 3. Registro no RackTables

Depois que o vCenter cria a VM:

1. localiza ou cria o objeto VM no RackTables;
2. atualiza:
   - Common Name;
   - Visible label;
   - Asset tag, usando o mesmo IP da VM;
   - comentario;
   - equipe responsavel;
   - FQDN;
   - orgao;
   - S.O.;
   - situacao;
   - solicitante;
3. salva tags;
4. aloca o IP no objeto como `eth0`;
5. grava resultado no job.

O backend detecta erros de pagina do RackTables como `Database error`, `Invalid request`, `Permission denied` e `Access denied`. Se um erro aparecer, o job nao deve ser marcado como concluido.

## Arquivos locais

Arquivos reais criados em runtime:

```text
data/racktables.json
data/vcenters.json
data/jobs.json
data/server.out.log
data/server.err.log
```

Esses arquivos nao devem ir para o GitHub.

Exemplos versionados ficam em:

```text
data/*.example.json
```

## Seguranca

Pontos importantes antes de producao:

- trocar armazenamento de senha em JSON por variaveis de ambiente, secret manager ou cofre;
- adicionar autenticacao na interface web;
- auditar permissoes do usuario de vCenter;
- auditar permissoes do usuario RackTables;
- registrar logs estruturados por job;
- separar ambiente de teste/producao;
- manter `ENABLE_VCENTER_WRITE` desabilitado por padrao.

## Observacoes de operacao

- O sistema filtra IP livre por RackTables e por ping offline.
- O asset tag do RackTables deve ser o mesmo IP escolhido para a VM.
- Se o IP ja existir como asset tag em outro objeto, o preflight bloqueia a criacao.
- A lista de IPs livres remove IPs que ja aparecem como asset tag em objetos VM.
- O historico de jobs fica local, em `data/jobs.json`.

## Comandos uteis

Validar sintaxe:

```powershell
node --check src/server.js
node --check public/app.js
```

Rodar protegido:

```powershell
npm start
```

Rodar com escrita real no vCenter:

```powershell
$env:ENABLE_VCENTER_WRITE="true"
npm start
```

## Status atual

Implementado:

- cadastro/teste de vCenter;
- cadastro/teste de RackTables;
- leitura de inventario vCenter;
- leitura de templates de inventario via SOAP;
- leitura de dropdowns do RackTables;
- busca de SIDs livres;
- busca de redes IPv4;
- busca de IPs livres/offline;
- filtro de IP que ja existe como asset tag;
- preflight de vCenter e RackTables;
- clone de template de inventario;
- reconfiguracao de CPU, memoria, rede e discos;
- power-on da VM;
- atualizacao de objeto RackTables;
- alocacao de IP no RackTables;
- historico local de jobs.

Pendente/evolucao:

- montagem real de ISO no modo VM zerada;
- autenticacao na interface;
- criptografia/segredo para credenciais;
- logs estruturados;
- monitoramento nativo de hosts durante Clone/Reconfig/PowerOn;
- testes automatizados.
