# newsletter-crawler

Crawler de newsletters em **Node.js puro** que descobre, extrai e arquiva artigos, usando um **LLM no OpenRouter (DeepSeek V4)** para *derivar seletores CSS reutilizáveis* — não para extrair página a página. O seletor é validado com Cheerio, **cacheado por template no SQLite**, e o LLM só é chamado de novo quando o cache falha (**self-healing**). Resultado: custo de LLM próximo de zero por artigo depois do primeiro acerto.

## Como funciona (visão geral)

```
seed (listing) ─► fetchSmart (got → Playwright se precisar de JS)
                     │
                     ├─ cache de seletor? ──sim──► aplica (Cheerio) ──► enfileira artigos
                     │
                     └─ não/quebrou ─► DeepSeek V4 Pro (reasoning xhigh) deriva seletor
                                        └─ valida (≥3 links) ─► salva no SQLite ─► usa p/ todas as páginas
                                        └─ falhou ─► fallback DeepSeek V4 Flash item-a-item

artigo ─► fetchSmart ─► Readability ──ok──► salva (SQLite)
                         └─ falhou ─► content selector (Pro, cacheado) ─► senão ─► Flash extrai
```

Tudo passa por uma **fila/frontier no SQLite** (`pending → in_progress → done/failed`), então o crawler é **resumível**: se cair, é só rodar de novo.

## Requisitos
- Node.js >= 22 (testado em Node 24)
- Uma chave do OpenRouter

## Instalação
```bash
npm install
npx playwright install chromium      # baixa o browser headless
cp .env.example .env                 # e preencha OPENROUTER_API_KEY
```

## Configuração
- **`.env`** — segredos e overrides (veja `.env.example`). Nunca é commitado.
- **`config/sources.json`** — as newsletters a raspar:
  ```json
  {
    "sources": [
      { "name": "The Batch — Research", "url": "https://www.deeplearning.ai/the-batch/tag/research" },
      { "name": "AI Weekly", "url": "https://aiweekly.co/issues", "type": "index", "maxIndexPages": 1 }
    ]
  }
  ```
  - `type` (default `listing`): em `listing` os links da página são artigos. Em **`index`** os links são **issues/edições** (roundups) — o crawler abre cada issue e, de dentro dela, abre os **links externos curados** (a notícia em si). Fluxo: `índice → issue (roundup) → artigo`.
  - `maxIndexPages`: quantas páginas do índice paginar (default 1 = só a 1ª).
  - Uma página apontada por um link que for, ela mesma, uma **coleção** de várias notícias (pouca prosa + muitos links externos) é **dividida em N** automaticamente (`MAX_CRAWL_DEPTH` limita a recursão).

## Menu guiado (TUI)
Ao chamar a ferramenta **sem argumentos num terminal interativo**, abre um **menu guiado** (Ink/React) com todas as ações (coletar, status, exportar, classificar, adicionar fonte, limpar). Ele monta os parâmetros por opções, **mostra o comando equivalente** (assim você aprende as flags) e exibe um **painel de progresso ao vivo** no crawl. **As flags continuam executando direto** — o menu é só um atalho.
```bash
npm start            # ou `node src/index.js` — abre o menu (em TTY)
npm run ui           # idem, explícito
CRAWLER_LANG=en npm run ui     # interface em inglês (default: português)
NO_COLOR=1 npm run ui          # sem cores
```
> Mudança: `node src/index.js` sem args agora abre o **menu** (TTY) ou imprime **ajuda** (não-TTY/`--no-input`), em vez de rodar o crawl. Use `npm run crawl` para coletar. Ctrl-C sai limpo (restaura o terminal; jobs `in_progress` são retomados no próximo run).

## Uso
```bash
npm run crawl                          # semeia do config e roda até esvaziar a fila (resumível)
npm run crawl -- --max-pages 2 --max-articles 5   # limita custo/tempo (ótimo p/ 1º teste)
npm run crawl -- --source "AI Weekly"  # semeia só essa fonte (nome exato; ou --only <substr>)
npm run crawl -- --source "AI Weekly" --since 2026-06-25   # piso de data (veja abaixo)
npm run status                         # contagens de sources/pages/articles/selectors/frontier
npm run add -- https://exemplo.com/arquivo --name "Minha" --type index --max-index-pages 1
npm run export -- --format md          # escreve data/export/<fonte>/*.md  (ou --format json)
npm run summarize                      # resumo + título em PT-BR p/ cada artigo (Flash; idempotente)
npm run search -- react server components --mode B   # busca por tags (5 Pro, rápido)
npm run search -- "local llm" --mode A --limit 20 --yes   # busca exaustiva (Flash, varre tudo)
npm run reset -- --yes                 # APAGA TODOS OS DADOS (slate limpo); respeita DB_PATH
npm test                               # node:test (datas, anti-bot, busca por tags, menu)
```

### Resumos PT-BR e busca na base
- **Resumos:** `summarize` gera `title_pt` + `summary_pt` (resumo legível em **português do Brasil**) por artigo. O `content` original é mantido (busca/tags usam ele). Roda **automático pós-crawl** (desligue com `SUMMARIZE_AFTER_CRAWL=false` ou `--no-summarize`).
- **Busca — Modo A (exaustivo):** `--mode A` faz **1 chamada Flash por artigo** (concorrência 50), julgando `direto`/`parecido`; rankeia direto>parecido. Guard de custo: acima de `SEARCH_MODE_A_CONFIRM` (~200) artigos exige `--yes`.
- **Busca — Modo B (por tags):** `--mode B` faz **5 chamadas Pro** (1 por faceta de retrieval) → une as tags → traz artigos cujas tags cruzam. Rápido; **exige classificação feita**.
- Toda busca devolve dois grupos: **Notícias** e **Ferramentas** (artigo que é *sobre* uma ferramenta vai p/ Ferramentas). Disponível também no menu (`npm run ui` → Buscar).

### Seleção de fonte e parada por data
- **`--source "<nome|url>"`** semeia só uma fonte (nome exato ou URL); **`--only <substr>`** casa por substring.
- **`--since <YYYY-MM-DD|ISO>`** é um **piso**: coleta do mais novo para o mais antigo e **para** ao passar da data. Aplica-se à data da **issue** (para a paginação do índice ao cruzar o piso) **e** à data de cada **artigo** (descarta os mais antigos; artigo sem data conhecida é mantido, pois sua issue já está no intervalo). Com `--since`, o índice pode paginar além de `maxIndexPages`, até `SINCE_MAX_INDEX_PAGES` (teto de segurança). Não é persistido — repita a flag ao retomar.
- **Dedup garantido:** o mesmo link nunca é cadastrado 2× — identidade pela **URL canônica pós-redirect** (`UNIQUE(url)`) + **`content_hash`** (índice UNIQUE). Links de paginação (instáveis) não servem de identidade; a checagem é pela notícia/conteúdo.

## Modelos (OpenRouter / DeepSeek V4)
- **Pro** `deepseek/deepseek-v4-pro` com `reasoning.effort: "xhigh"` — deriva/repara seletores (1 chamada amortizada por template). Use `"xhigh"`, **nunca** `"max"`.
- **Flash** `deepseek/deepseek-v4-flash` com `reasoning.effort: "high"` — fallback item-a-item, próxima página, extração de artigo.
- Saídas estruturadas via `response_format: json_schema` (strict) + validação `zod`.

## Estrutura
```
src/config.js     env + sources + constantes
src/util.js       normalizeUrl, sha256, jitter, slugify, log
src/db.js         better-sqlite3: schema (WAL) + prepared statements
src/fetch.js      fetchStatic/fetchRendered/fetchSmart + robots + circuit breaker
src/clean.js      pruneForLLM (HtmlRAG) + Readability + turndown
src/llm.js        OpenRouter: deriveLinkSelector/Content/Next + extractLinks/Article
src/selectors.js  cache get/put + validação Cheerio (self-healing)
src/substack.js   atalho opcional via API JSON do Substack
src/crawl.js      frontier + processJob + crawlArchive + paginação
src/classify.js   classificação multi-faceta de tags (vocabulário controlado)
src/taxonomy.js   vocabulário/facetas + prompts (classificação e busca por tags)
src/summarize.js  resumo + título PT-BR por artigo (Flash)
src/search.js     busca na base: modo A (Flash, varre tudo) + modo B (Pro, por tags)
src/commands.js   implementação dos comandos (compartilhada CLI + UI) + getStatus
src/index.js      CLI (parseFlags + dispatch) + gate do menu guiado
src/ui/           menu Ink/React (htm, sem build): App, screens, RunView (painel ao vivo), i18n
```

## Notas
- **Cortesia/legal:** respeita `robots.txt` e Crawl-delay (desative com `CRAWLER_RESPECT_ROBOTS=false` só para conteúdo que você tem direito de arquivar), usa UA identificável, delay com jitter e circuit breaker por host. Raspe apenas conteúdo público.
- **Sem `axios`** (incidente de supply-chain de 31/03/2026); usamos `got`. As versões são fixadas no `package-lock.json`.
- **Custo:** `xhigh` é cobrado como tokens de saída — por isso o Pro só deriva seletor (uma vez por template) e o DOM é podado antes de ir ao LLM.
