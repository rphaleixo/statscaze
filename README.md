# Statscaze — Cazé TV, Mapeador de Vídeos

Coleta dados de vídeos do canal da Cazé TV pela API do YouTube (título,
duração, views, comentários, chat) e mostra dashboards de performance.
Roda inteiramente na Cloudflare: **Worker** (backend em JavaScript) +
**D1** (banco de dados SQL) + página web servida pelo próprio Worker.

> A pasta `python-legacy/` guarda a versão original em Python/Streamlit,
> mantida só como referência — não é o que roda em produção.

## O que mudou em relação à versão Python

- **Streamlit → página web estática** (`public/`) servida pelo Worker.
- **SQLite local → Cloudflare D1** (mesmo formato de tabela).
- **Transcrição:** só o método via legendas públicas do YouTube (equivalente
  ao método "rápido" do script original). O fallback com `yt-dlp` não existe
  aqui — não roda dentro de um Worker. Vídeos sem legenda pública não são
  transcritos.
- **Coleta automática:** um gatilho (cron) roda todo dia e busca os vídeos
  publicados nos últimos 2 dias, sem precisar abrir a página.
- **Elenco:** cada vídeo tem colunas dedicadas de competição/programa,
  narrador e até 5 comentaristas (em vez de uma lista livre de "elenco").
  Isso alimenta o dashboard de performance por membro (sozinho ou em
  combinação) e por competição/programa, na aba "Dashboards". Essas
  informações podem ser preenchidas na tabela da aba "Enriquecimento" ou
  importadas de uma vez via CSV (colunas: `video_id`, `competicao`,
  `narrador`, `comentarista_1` a `comentarista_5`).

## Passo a passo para colocar no ar

### 1. Criar conta e instalar as ferramentas

Você precisa de uma conta gratuita na Cloudflare (cloudflare.com) e do Node.js
instalado no seu computador.

```bash
npm install
```

### 2. Fazer login na Cloudflare

```bash
npx wrangler login
```

Isso abre o navegador para você autorizar o acesso.

### 3. Criar o banco de dados (D1)

```bash
npx wrangler d1 create statscaze
```

Esse comando imprime um `database_id`. Copie esse valor e cole no arquivo
`wrangler.toml`, na linha:

```toml
database_id = "COLOQUE_AQUI_O_ID_DO_BANCO"
```

Depois, crie as tabelas no banco:

```bash
npm run db:migrate:remote
```

### 4. Configurar a chave da API do YouTube

Pegue uma chave em https://console.cloud.google.com/apis/credentials
(com a "YouTube Data API v3" ativada) e configure como segredo do Worker
(não fica no código, não vai para o GitHub):

```bash
npx wrangler secret put YOUTUBE_API_KEY
```

Cole a chave quando pedir.

Se o canal não for a Cazé TV, ajuste `CHANNEL_HANDLE` em `wrangler.toml`
(usado só pela coleta automática diária; na página você pode digitar
qualquer handle).

### 5. Testar localmente (opcional)

```bash
npm run dev
```

Abre em `http://localhost:8787`.

### 6. Publicar na Cloudflare

```bash
npm run deploy
```

Ao final, o comando mostra a URL pública (algo como
`https://statscaze.SEU-USUARIO.workers.dev`).

## Publicar automaticamente a cada push (GitHub Actions)

Já existe um workflow em `.github/workflows/deploy.yml` que publica sozinho
sempre que houver um push na branch `main`. Para ativar, configure dois
segredos no repositório do GitHub (Settings → Secrets and variables →
Actions):

- `CLOUDFLARE_API_TOKEN` — crie em
  https://dash.cloudflare.com/profile/api-tokens (use o template "Edit
  Cloudflare Workers").
- `CLOUDFLARE_ACCOUNT_ID` — aparece na barra lateral direita do painel da
  Cloudflare.

Sem esses dois segredos configurados, o deploy automático falha (mas isso
não afeta o código em si — dá para publicar manualmente com `npm run
deploy` a qualquer momento).

## Limites a saber

- A API do YouTube tem cota diária gratuita. Mapear períodos muito longos de
  uma vez pode esgotá-la — se acontecer, espere o dia seguinte (a cota
  reseta à meia-noite no horário do Pacífico).
- A contagem de mensagens do chat só funciona **durante** uma live — depois
  que ela termina, o YouTube não permite mais recuperar o replay do chat
  pela API.
- Cloudflare tem um limite de "subrequisições" por chamada ao Worker. Por
  isso o mapeamento e a transcrição são feitos em lotes pequenos (a página
  cuida disso automaticamente, mostrando o progresso).

## Estrutura do projeto

```
src/worker.js       → rotas da API e a coleta automática (cron)
src/youtube.js       → chamadas à API do YouTube
src/transcript.js     → extração de transcrição via legendas públicas
src/db.js            → leitura/escrita no banco D1
migrations/          → schema do banco
public/               → página (HTML/CSS/JS) servida pelo Worker
python-legacy/         → versão original em Python/Streamlit (referência)
```
