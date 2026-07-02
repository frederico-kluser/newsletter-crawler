# newsletter-crawler

> Crawler de newsletters em **Node.js puro** (ESM, Node ≥ 22, **sem build**) que descobre, extrai, classifica, resume em PT-BR e **busca** artigos — com **menu guiado no terminal** (Ink/React) e as flags diretas.

> Histórico de versões em [CHANGELOG.md](CHANGELOG.md) — atual: **v1.2.0**.

Usa um **LLM no OpenRouter (DeepSeek V4)** para *derivar seletores CSS reutilizáveis* — não para extrair página a página. O seletor é validado com Cheerio, **cacheado por template no SQLite** e só re-derivado quando o cache falha (**self-healing**) — então o custo de LLM da **descoberta/extração** fica próximo de zero por artigo depois do primeiro acerto. Classificação de tags e resumos PT-BR são passes **opcionais** por artigo (rodam automáticos pós-crawl e podem ser desligados).

## Recursos
- **Crawl multinível** `índice → issue (roundup) → artigo`: abre cada edição e segue os links externos curados; uma página que é uma coleção de notícias é **dividida em N** automaticamente.
- **Resumível e educado:** fila/frontier no SQLite (`pending → in_progress → done/failed`), `robots.txt` + Crawl-delay, jitter e circuit breaker por host; rejeita interstitials anti-bot (Cloudflare).
- **Dedup garantido:** o mesmo link nunca é cadastrado 2× (URL canônica pós-redirect + `content_hash` UNIQUE).
- **Parada por data** (`--since`): coleta do mais novo ao mais antigo e para no piso (issue e artigo).
- **Re-crawl incremental + delta:** rodar de novo re-visita as fontes e traz **só o que é novo** (para na 1ª página conhecida; nunca re-baixa o que já tem; `--no-refresh` desliga a re-visita). `export`/`busca` mostram só o novo da **última execução** por padrão (`--all` = acervo todo).
- **Modo agressivo (`--aggressive`):** opt-in que ignora `robots.txt` e finge um navegador real (UA + headers/client-hints) para passar por 403/anti-bot — sem salvar páginas de desafio. Use só onde você tem direito de arquivar.
- **Tags multi-faceta** contra um vocabulário controlado (9 facetas, ~800 tags) e **resumos + títulos em PT-BR**.
- **Busca na base** em 2 modos: exaustivo (Flash, avalia todo artigo) ou por tags (Pro), devolvendo **Notícias** e **Ferramentas**.
- **Menu guiado (TUI)** bilíngue PT/EN que monta os parâmetros, mostra o comando equivalente e exibe progresso ao vivo — sem substituir as flags.

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

## Instalação global (`ncrawl`)
Para chamar o crawler **de qualquer diretório** como um comando único:
```bash
npm run link          # install + playwright + `npm link` + status (setup completo)
ncrawl key set <sua-chave-openrouter>   # valida na OpenRouter e salva em ~/.newsletter-crawler/.env
ncrawl status         # já funciona de qualquer pasta
ncrawl                # sem args, em TTY: abre o menu guiado
npm run unlink        # remove o link global quando quiser
```
- O comando é **`ncrawl`** (e o alias longo `newsletter-crawler`). Não é `nc` de propósito: `nc` já é o **netcat** no sistema — usar esse nome o sombrearia.
- **`NC_HOME` (default `~/.newsletter-crawler/`)** é o lugar **previsível** onde ficam os **dados do usuário**: o banco SQLite (`crawler.db`), o `.env` (segredos), o `sources.json` (fontes que você adiciona) e os `export/`. Assim o binário linkado não depende de onde o repo está. Mude com `NC_HOME=/outro/caminho ncrawl ...`.
- **Chave OpenRouter pelo CLI:** `ncrawl key set <chave>` faz um *probe* (`GET /api/v1/key`) e **só grava se a chave for válida**; `ncrawl key test` valida a chave atual. A chave em `NC_HOME/.env` tem **precedência** sobre o `.env` do repo.
- O `sources.json` do usuário é **semeado** uma vez a partir do default versionado do repo (`config/sources.json`) — suas fontes de fábrica não se perdem. Dados já coletados em `./data/` **não** são migrados; se quiser reaproveitá-los, copie `data/crawler.db` para `~/.newsletter-crawler/crawler.db`.

## Configuração
- **`.env`** — segredos e overrides (veja `.env.example`). Nunca é commitado. No uso global, prefira `ncrawl key set <chave>` (grava em `~/.newsletter-crawler/.env`).
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
Ao chamar a ferramenta **sem argumentos num terminal interativo**, abre um **menu guiado** (Ink/React) com todas as ações (coletar, **buscar**, status, exportar, classificar, **resumir**, adicionar fonte, limpar). Ele monta os parâmetros por opções, **mostra o comando equivalente** (assim você aprende as flags) e exibe um **painel de progresso ao vivo** no crawl/busca. **As flags continuam executando direto** — o menu é só um atalho.
```bash
npm start            # ou `node src/index.js` — abre o menu (em TTY)
npm run ui           # idem, explícito
CRAWLER_LANG=en npm run ui     # interface em inglês (default: português)
NO_COLOR=1 npm run ui          # sem cores
```
> Mudança: `node src/index.js` sem args agora abre o **menu** (TTY) ou imprime **ajuda** (não-TTY/`--no-input`), em vez de rodar o crawl. Use `npm run crawl` para coletar. Ctrl-C sai limpo (restaura o terminal; jobs `in_progress` são retomados no próximo run).

**Adicionar newsletter pela interface:** menu → **Adicionar fonte** → assistente (URL → nome → tipo `listing`/`index` → maxIndexPages). A fonte é **persistida em `config/sources.json`** (upsert por URL) — fica permanente, passa a aparecer no seletor da tela **Coletar** e é re-semeada a cada crawl. Equivale a `npm run add -- <url> --name "..." --type index --max-index-pages 1`.

## Uso
```bash
npm run crawl                          # semeia do config e roda até esvaziar a fila (resumível)
npm run crawl -- --max-pages 2 --max-articles 5   # limita custo/tempo (ótimo p/ 1º teste)
npm run crawl -- --source "AI Weekly"  # semeia só essa fonte (nome exato; ou --only <substr>)
npm run crawl -- --source "AI Weekly" --since 2026-06-25   # piso de data (veja abaixo)
npm run crawl -- --aggressive          # ignora robots.txt + UA de navegador real (403/anti-bot)
npm run crawl -- --no-refresh          # não re-visita as listagens; só drena a fila pendente
npm run status                         # contagens de sources/pages/articles/selectors/frontier
npm run add -- https://exemplo.com/arquivo --name "Minha" --type index --max-index-pages 1
npm run export -- --format md          # data/export/<fonte>/*.md — só a última run (--all = tudo; ou --format json)
npm run summarize                      # resumo + título em PT-BR p/ cada artigo (Flash; idempotente)
npm run search -- react server components --mode B   # por tags (5 Pro); só a última run (--all = acervo)
npm run search -- "local llm" --mode A --limit 20 --yes --all   # exaustiva no acervo todo (Flash)
npm run key -- set <chave>             # valida a chave OpenRouter e salva em ~/.newsletter-crawler/.env (ou: ncrawl key set)
npm run reset -- --yes                 # APAGA TODOS OS DADOS (slate limpo); respeita DB_PATH
npm test                               # node:test (datas, anti-bot, busca por tags, menu)
```

### Resumos PT-BR e busca na base
- **Resumos:** `summarize` gera `title_pt` + `summary_pt` (resumo legível em **português do Brasil**) por artigo. O `content` original é mantido (busca/tags usam ele). Roda **automático pós-crawl** (desligue com `SUMMARIZE_AFTER_CRAWL=false` ou `--no-summarize`).
- **Busca — Modo A (exaustivo):** `--mode A` faz **1 chamada Flash por artigo** (concorrência 50), julgando `direto`/`parecido`; rankeia direto>parecido. Guard de custo: acima de `SEARCH_MODE_A_CONFIRM` (~200) artigos exige `--yes`. O prompt de relevância foi **calibrado por avaliação** (`eval/`, rubrica + few-shot): F1 macro no Flash 0.73 → **0.85**, cortando falsos positivos.
- **Busca — Modo B (por tags):** `--mode B` faz **5 chamadas Pro** (1 por faceta de retrieval) → une as tags → traz artigos cujas tags cruzam. Rápido; **exige classificação feita**.
- Toda busca devolve dois grupos: **Notícias** e **Ferramentas** (artigo que é *sobre* uma ferramenta vai p/ Ferramentas). Disponível também no menu (`npm run ui` → Buscar).

### Seleção de fonte e parada por data
- **`--source "<nome|url>"`** semeia só uma fonte (nome exato ou URL); **`--only <substr>`** casa por substring.
- **`--since <YYYY-MM-DD|ISO>`** é um **piso**: coleta do mais novo para o mais antigo e **para** ao passar da data. Aplica-se à data da **issue** (para a paginação do índice ao cruzar o piso) **e** à data de cada **artigo** (descarta os mais antigos; artigo sem data conhecida é mantido, pois sua issue já está no intervalo). Com `--since`, o índice pode paginar além de `maxIndexPages`, até `SINCE_MAX_INDEX_PAGES` (teto de segurança). Não é persistido — repita a flag ao retomar.
- **Re-crawl incremental (padrão):** cada execução re-visita as listagens e enfileira **só URLs novas**; a paginação para na **1ª página sem itens novos** (arquivo é do mais novo p/ o mais antigo). `--no-refresh` desliga a re-visita (só drena a fila pendente). Cada crawl abre uma **execução (run)** com marca d'água (`runs` + `articles.run_id`) — `export` e `search` mostram por padrão **só o novo dessa última run** (`--all` = acervo inteiro).
- **Dedup garantido:** o mesmo link nunca é cadastrado 2× — identidade pela **URL canônica pós-redirect** (`UNIQUE(url)`) + **`content_hash`** (índice UNIQUE). Links de paginação (instáveis) não servem de identidade; a checagem é pela notícia/conteúdo.

## Modelos (OpenRouter / DeepSeek V4)
- **Pro** `deepseek/deepseek-v4-pro` com `reasoning.effort: "xhigh"` — deriva/repara seletores (1 chamada amortizada por template). Use `"xhigh"`, **nunca** `"max"`.
- **Flash** `deepseek/deepseek-v4-flash` com `reasoning.effort: "high"` — fallback item-a-item, próxima página, extração de artigo, resumo PT-BR, busca modo A.
- Saídas estruturadas via `response_format: json_schema` (strict) + validação `zod`.
- **JSON inválido é retomável:** o Flash às vezes trunca a resposta; `callJSON` re-amostra **2× no Flash** e, se ainda falhar, faz **uma última tentativa no Pro** (mais confiável no JSON). O `maxRetries` do SDK cobre 429/5xx à parte.

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
src/keys.js       chave OpenRouter: probe (GET /api/v1/key) + upsert idempotente em NC_HOME/.env
src/commands.js   implementação dos comandos (compartilhada CLI + UI) + getStatus
src/index.js      CLI (parseFlags + dispatch) + gate do menu guiado
src/ui/           menu Ink/React (htm, sem build): App, screens, RunView (painel ao vivo), i18n
eval/             harness de avaliação do prompt de busca (golden set, variantes, Flash vs Pro) → REPORT.md
```

## Notas
- **Cortesia/legal:** respeita `robots.txt` e Crawl-delay (desative com `CRAWLER_RESPECT_ROBOTS=false`, ou por execução com `--aggressive` — que também usa UA de navegador real —, só para conteúdo que você tem direito de arquivar), usa UA identificável, delay com jitter e circuit breaker por host. Raspe apenas conteúdo público.
- **Sem `axios`** (incidente de supply-chain de 31/03/2026); usamos `got`. As versões são fixadas no `package-lock.json`.
- **Custo:** `xhigh` é cobrado como tokens de saída — por isso o Pro só deriva seletor (uma vez por template) e o DOM é podado antes de ir ao LLM.
