# Plano — Resumos PT-BR + Busca na base (2 modos) sobre o sistema de tags existente

## Avaliação do que já existe (pedido: "avalie se criamos o sistema de tags")
- ✅ **O sistema de tags está COMPLETO e em uso.** 9 facetas, 1 agente LLM por faceta, fan-out com gates (`CLASSIFY_CONCURRENCY`/`ARTICLE_CONCURRENCY`), fail-open, persistência transacional em `article_tags` (normalizado: article_id, facet, tag, rank) + `classifications` + `classification_uncovered`. Roda **automático pós-crawl** (`CLASSIFY_AFTER_CRAWL`), 9 chamadas Pro xhigh/artigo. Arquivos: `src/classify.js`, `src/taxonomy.js`, `src/db.js`.
- ✅ **`config/taxonomy.json` BATE 100% com a taxonomia gigante que você passou:** 8 domínios (ai-general, reactjs, nodejs, frontend, backend, python, llm-models, local-llm), as 9 facetas, `limits`, `mandatory` (domain/content-type/topic-technology), `aliases` (59 entradas), `version: 2026-06`. → **"se já for o caso, ignore" = já é o caso. NÃO recrio taxonomia.**
- ❌ **Lacuna 1:** não há resumo/PT-BR — o conteúdo é guardado cru, em inglês.
- ❌ **Lacuna 2:** não há **retrieval por tag** — `article_tags` é só escrita; falta `SELECT ... WHERE tag IN (...)`.

Esta tarefa preenche as duas lacunas e adiciona a busca.

## Decisões (acordadas)
- **PT-BR:** guardar o **original** (`articles.content`, p/ busca/tags) **+** versão PT-BR p/ ler → colunas novas **`title_pt`** + **`summary_pt`** (resumo legível em PT-BR, não tradução literal palavra-a-palavra; é um knob se quiser tradução completa depois).
- **"Ferramenta"** = artigo que **é sobre** uma ferramenta (pacote/lib/framework e o que faz) → vai no bucket **Ferramentas**; o resto, **Notícias**. Toda busca devolve os dois buckets.
- **Modo B** = **5 chamadas Pro**, 1 por faceta de retrieval (`domain`, `topic-technology`, `framework-library-tool`, `concept-theme`, `trending-emerging`) → une as tags → traz artigos cujas `article_tags` cruzam, rankeado por nº de tags casadas. (Exige classificação feita.)
- **Modo A** = **DeepSeek V4 Flash, esforço ALTO, concorrência 50**, varre TODAS as notícias; cada uma julga `relation: direct|similar|none` + `kind: news|tool`; mantém direct/similar, rankeia direct>similar. (Caro/exaustivo; guard de custo abaixo.)

## Implementação (arquivos × mudanças)

### Stages e config
- **`src/config.js`**: adicionar a `STAGE_KEYS` → `summarize`, `searchRelevance`, `searchTags` (resolvem sozinhos via `stageModel`). Consts: `SUMMARIZE_CONCURRENCY=6`, `SUMMARIZE_AFTER_CRAWL` (default on), `SUMMARIZE_MAX_CHARS=12000`, `SEARCH_FLASH_CONCURRENCY=50`, `SEARCH_MAX_CHARS=8000`, `SEARCH_MODE_A_CONFIRM=200` (limiar do guard).
- **`config/models.json`**: `summarize` e `searchRelevance` → `deepseek/deepseek-v4-flash`+`high`; `searchTags` → `deepseek/deepseek-v4-pro`+`xhigh`. (Nunca `max` — guard já existe em `resolveStage`/`callJSON`.)

### Dados — `src/db.js`
- `ensureColumn('articles','title_pt','title_pt TEXT')` + `ensureColumn('articles','summary_pt','summary_pt TEXT')` (nullable; `content` segue original).
- `stmts` novos: `setSummary` (UPDATE), `listArticlesNeedingSummary` (`summary_pt IS NULL`), `listArticlesForResummarize`, `countSummaries`, `listAllArticlesForSearch` (Modo A), **`articlesByTags`** (Modo B) usando `json_each(@tags)` (better-sqlite3 traz JSON1): `... WHERE at.tag IN (SELECT value FROM json_each(@tags)) GROUP BY a.id ORDER BY COUNT(DISTINCT at.tag) DESC LIMIT @limit`. Reusa `getTagsForArticle` p/ bucketing.

### Vocabulário (reuso) — `src/taxonomy.js` (puro)
- `RETRIEVAL_FACETS` (as 5) + `TOOL_CONTENT_TYPES` (`tool-release`,`tooling`,`library-release`,`product-launch`).
- `buildFacetQueryPrompt(facet, query)` — irmão de `buildFacetPrompt`, mapeia **consulta**→tags DAQUELA faceta, restrito a `facet.vocab` + aliases, schema `{tags:[]}`.
- `isToolByTags(tagRows)` — true se há tag `framework-library-tool` OU content-type em `TOOL_CONTENT_TYPES`.
- Tags derivadas passam pelo **`validateFacetTags` existente** (vocab Set + alias + dedup + cap) — mesma garantia da classificação.

### LLM — `src/llm.js` (3 funções, padrão `callJSON`+zod, fail-open)
- `summarizeArticle({title,content})` → `{title_pt, summary_pt}` (Flash high; system "editor técnico brasileiro").
- `judgeRelevance({query,title,content})` → `{relation,kind}` — schema sem enum; zod `.transform` clampa p/ `{direct,similar,none}`/`{news,tool}` (erro → `none`).
- `mapQueryToFacetTags({system,user})` → `{tags:[]}` (Pro; prompt vem do `buildFacetQueryPrompt`).

### Módulos novos
- **`src/summarize.js`** — `summarizePending({limit,force})`, espelha `classify.js` mas 1 chamada/artigo, 1 gate (`SUMMARIZE_CONCURRENCY`), idempotente (NULL-only), retomável; persiste via `setSummary`.
- **`src/search.js`** — `runSearch(query,{mode,limit,yes})` → `{query,mode,scanned,total,relevant,buckets:{noticias,ferramentas}}`. Mode A: `pLimit(SEARCH_FLASH_CONCURRENCY)` sobre `listAllArticlesForSearch`, fail-open, rankeia direct>similar, bucketiza por `kind`. Mode B: guarda se `countClassifications===0`; roda as 5 facetas (`mapQueryToFacetTags`+`validateFacetTags`), une, `articlesByTags`, bucketiza por `isToolByTags`. Global `_progress={scanned,total,relevant}` + `getSearchProgress()` p/ o painel ao vivo. Cada item: `{id,url,title,title_pt,summary_pt,snippet,relation,score}` (`snippet`=200 chars de `content` como fallback).

### Comandos — `src/commands.js` + `src/index.js` + `package.json`
- `getStatus()`: somar `summaries`/`pendingSummary`.
- `cmdSummarize(flags)` (espelha `cmdClassify`); **hook pós-crawl** `SUMMARIZE_AFTER_CRAWL` (simétrico ao classify; `--no-summarize` pula).
- `cmdSearch(rest,flags)`: query = `rest.join(' ')` (multiword sem aspas); `--mode A|B`, `--limit`, `--yes`. **Guard de custo Modo A:** se `min(artigos,limit) > SEARCH_MODE_A_CONFIRM` e sem `--yes` → recusa com a contagem (sugere `--yes`/`--limit`/`--mode B`). **Retorna o objeto de resultados** (a UI captura).
- `cmdExport`: dobrar `title_pt`/`summary_pt` no markdown (JSON já pega via `SELECT *`).
- `index.js`: dispatch `summarize`/`search` (cada um `db.close()`), help atualizado. `package.json`: scripts `summarize`/`search`.

### UI — `src/ui/`
- `i18n.js`: chaves PT/EN (menuSearch/menuSummarize, searchQuery/Mode/ModeA/ModeB, searchEmptyQuery, searchNoClass, searchCostWarn`{n}`, searchScanning`{n}{total}{m}`, summarize*, results*). O resumo PT-BR é conteúdo, nunca passa por `t()`.
- `screens.js`: itens no `Menu`; `SummarizeConfig` (clone do `ClassifyConfig`); `SearchConfig` (wizard: query obrigatória → mode A/B; em B avisa se `classified===0`; em A passo de confirmação com `searchCostWarn` → `flags.yes`). Reusa `Field`/`Review`/`yesNo`/`buildCommandPreview`.
- **`ResultsView.js` (NOVO)**: componente rolável que usa **só `useInput`** do ink (respeita "um input por vez"): 2 seções (Notícias/Ferramentas) com `title_pt||title`, `summary_pt||snippet` (dim, truncado), url, badge relation/score; `↑/↓` rola, `b` volta, `q` sai; vazio → `resultsNone`.
- `App.js`: THUNKS `summarize`/`search` (search retorna resultados); estado `runResult`; `RunView` ganha prop `onResults` → App guarda e vai p/ `screen='results'` (`ResultsView`). Fluxo: `menu → search → run → results → menu/quit`.
- `RunView.js`: capturar o valor resolvido — se `spec.sub==='search'` chama `onResults(value)` (em vez do Select voltar/sair); contador ao vivo via `getSearchProgress()` (`searchScanning`); importa de `commands.js`.

## Edge cases (principais)
Query vazia (recusa CLI + bloqueio no wizard) · sem artigos (buckets vazios → `resultsNone`) · **Modo B sem classificação** (avisa + oferece Modo A) · **custo Modo A** (guard `SEARCH_MODE_A_CONFIRM`+`--yes`/`--limit`) · backfill idempotente (`summary_pt IS NULL`; `--force`) · `title_pt`/`summary_pt` nullable (fallback `||`) · união de tags vazia (sem SQL, buckets vazios) · bilíngue (chrome via `t()`, resumo sempre PT-BR) · guard `max→xhigh` · paridade CLI/UI (mesmo `cmdSearch`; `buildCommandPreview` mostra o comando) · fail-open a 50× (1 artigo ruim → `none`, segue).

## Verificação
1. `npm run status` (boota módulos novos + `stmts` incl. `json_each`; sem throw). `npm test` verde (migrações aditivas; `getStatus` superset).
2. Testes puros novos: `test/taxonomy.search.test.js` (`buildFacetQueryPrompt` inclui vocab+`CONSULTA:`; `isToolByTags`; `validateFacetTags` corta fora-de-vocab); estender `test/ui.menu.test.js` (labels `Buscar`/`Resumir`).
3. `npm run summarize -- --limit 2` → 2 `summary_pt` preenchidos; re-run resume 0. `npm run export -- --format json` mostra `title_pt`/`summary_pt`.
4. `npm run search -- "react server components" --mode B` → buckets das tags (5 Pro + 1 SQL; loga tags por faceta); com 0 classificações, mostra o guard.
5. `npm run search -- "local llm quantization" --mode A --limit 10 --yes` → varre 10, streama `busca A: N/10 · M relevantes`, buckets rankeados; sem `--yes`/`--limit` acima do limiar → recusa.
6. `npm run ui` → menu com **Buscar**/**Resumir (PT-BR)**; Buscar → query+modo A → confirma → painel ao vivo → `ResultsView` rolável.

## Arquivos críticos
NOVOS: `src/summarize.js`, `src/search.js`, `src/ui/ResultsView.js`, `test/taxonomy.search.test.js`. EDIT: `src/llm.js`, `src/db.js`, `src/taxonomy.js`, `src/config.js`, `config/models.json`, `src/commands.js`, `src/index.js`, `package.json`, `src/ui/{App,screens,RunView,i18n}.js`.

## Execução (pós-aprovação)
Protocolo project-router: cria `TASK_PLAN.md`, implementa na branch atual `feat/multilevel-crawl-aiweekly`, roda as verificações (status/test/summarize/search bounded), evolui as skills (nova `classifying-and-searching` ou estende `extending-the-crawler` + `building-the-ink-tui`) e commita. Remove `TASK_PLAN.md`. Sem novas dependências (usa openai/zod/p-limit/ink já presentes).

## Pontos em aberto (decisão sua)
- **Resumo vs tradução completa:** `summary_pt` será um **resumo legível em PT-BR** (1–3 parágrafos), não tradução literal do texto inteiro. Se quiser o artigo TODO traduzido, troco para tradução completa (mais caro).
- **Auto pós-crawl:** resumos passam a ser gerados automaticamente após o crawl (como a classificação), desligável via `SUMMARIZE_AFTER_CRAWL=false`/`--no-summarize`.
- **Guard de custo do Modo A:** acima de ~200 artigos exige `--yes` (evita varredura cara acidental).
