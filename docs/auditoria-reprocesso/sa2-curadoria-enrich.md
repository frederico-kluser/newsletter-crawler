# Auditoria SA2 — Re-curadoria e re-enriquecimento em re-run (vazamentos de gasto IA)

**Escopo:** somente leitura. Nenhuma escrita no banco; nenhum crawl/finish/search executado.
**Base consultada (read-only):** `~/.newsletter-crawler/crawler.db` — run 1 `crawl --since 2026-01-01` (done, 10/set) e run 2 `crawl --since 2026-09-05 --budget 0.5` (running, 11/set).
**Referências:** `file:line` do repo.

---

## Resumo executivo (medido no banco real)

| Métrica run 1 (494 issues) | Valor |
|---|---|
| Chamadas LLM totais / custo | 23.041 / US$ 13,67 |
| `curate` (curadoria) | 3.609 chamadas / US$ 6,53 (47,8% do gasto) |
| `classify` (9 facetas × artigo) | 13.879 chamadas / US$ 3,12 |
| `articleClean` | 1.642 / US$ 2,55 |
| `verifyRecord` | 1.578 / US$ 0,56 |
| `summarize` | 1.578 / US$ 0,41 |
| `contentSelector` / `articleExtract` | 315 / US$ 0,33 e 431 / US$ 0,14 |
| Curate por issue | média **6,21 seções**, **7,31 chamadas**, **US$ 0,0132** (avg 2.167 prompt + 6.216 completion tokens — effort `high` conta como output) |
| Issues com **0 itens novos** (tudo `dup`) | **176 de 494 (36%)** — curadoria paga por inteiro, zero conteúdo novo |
| `item dup` | 9.107 (de ~11.064 itens emitidos → só 1.957 salvos) |
| `enrich kept-blurb` | 353 (173 thin-content, 88 error-page, 79 dup-content, 10 blocked-page, 4 json-page, 3 pdf-target) |
| `fetch fail` | 140 eventos, **38 alvos distintos** |
| `job timeout` | 29 |

Run 2 (re-run, mesma base): **3 issues novas curadas** (21 chamadas / US$ 0,034), **os MESMOS 38 alvos mortos re-falharam** (140 fetch fail idênticos), 42 itens `needs_enrich=1` pendentes.

---

## 1. Evento `curate coverage` e re-curadoria de issues já curadas

### O que é `curate coverage`
É o **trace do passe de cobertura (recall)** de UMA issue recém-curada — não um "skip". Depois do 1º passe por seções, o código calcula a diferença determinística (links externos do HTML bruto − itens emitidos) e, dentro do teto `coverageLeftoverCeiling` (`src/curate.js:26-38, 256`), dispara **1 chamada extra** `curateLeftoverLinks` (`src/curate.js:262-264`; `src/llm.js:568-602`) com o HTML podado inteiro da página; o `logEvent({stage:'curate', status:'coverage'})` roda **incondicionalmente** após esse bloco (`src/curate.js:291-302`), registrando `bodyLinks/leftovers/recovered/filtered/secondary`. Por isso `curate ok` 494 e `curate coverage` 494 são **a mesma coisa**: uma por issue curada (confirmado no banco: 494+494, sem nenhum outro status).

### A decisão de "issue já coberta" **não existe** no caminho do roundup
Não há guard pré-curadoria por issue: `processRoundup` → `curateRoundup` roda a IA incondicionalmente ao reivindicar o job (`src/crawl.js:500-562`, `src/curate.js:193-381`), e o caminho **não consulta `pages`** — documentado no próprio código (`src/db.js:1354-1356`): *"a curadoria é decidida pelo job de roundup em crawl.js/curate.js, que não consulta pages"*. Selectors também não participam. O único filtro antes do custo é o **enfileiramento** de novos jobs roundup, via `isUrlKnown` (4 ramos, `src/db.js:401-410`):
1. `articles.url` (artigo já capturado);
2. `pages.url` (listagem/issue já visitada);
3. `frontier` em `done|failed|pending|in_progress` (job já conhecido — **os roundups processados nascem aqui e é o ramo que "protege" na prática**);
4. `articles.issue_url` (URL de issue já curada, escrita por `insertArticle` na curadoria, `src/curate.js:338`).

Usado para parar a paginação em `crawlArchive` (`src/crawl.js:383-393`) e no fallback item-a-item (`src/crawl.js:248-256`).

### Por que a 1ª coleta pós-restore re-cura ~745 issues
Cadeia completa após `ncrawl restore` do snapshot commitado (exportador antigo, sem `issue_url`):
- `restoreArticle` grava `issue_url = row.issue_url ?? null` (`src/db.js:1211`), `content_source='restore'`, `needs_enrich=0` (`src/db.js:1214-1216`) — com o snapshot antigo, `issue_url` fica **NULL nas 15.502 linhas** (medido: 15.502 NULL).
- `restorePage` só alimenta `pages` **quando o snapshot carrega `issue_url`** (`src/restore.js:1174-1178`, chamando `src/db.js:1367-1377`); sem o campo, **0 páginas de issue** (medido: `pages` tem só as 33 listagens `done` criadas pelo crawl).
- `markUrlDone` cria frontier `done` só para as URLs de **artigo** (`src/restore.js:1171`; `src/db.js:958-967`); **nenhuma linha roundup**.
- Resultado: para uma URL de issue, os 4 ramos do `isUrlKnown` falham (ramo 3 não tem linha, ramo 4 não tem `issue_url`) → `knownCount=0` → a paginação **não para** → enfileira o arquivo inteiro de issues ≥ `--since` → cada job roundup vira curadoria IA completa. Efeito medido na época, documentado em `src/db.js:1123-1130`: *"pós-restore o isUrlKnown reconhece 100% das 15.502 URLs de ARTIGO e 0 de 747 URLs de ISSUE — a 1ª coleta re-percorre e re-cura por IA ~745 issues"* (nesta máquina, com `--since 2026-01-01`, foram 497 jobs roundup / 494 curados).

### Re-run com a MESMA data já coberta: a issue é re-curada de novo? **NÃO** (medido)
Na run 2 (re-run em cima da base pós-run-1): 8 eventos `archive ok` (~4.176 links vistos), com `novos` = 0/0/1/0/0/1/0/1 → só **3 issues genuinamente novas** foram enfileiradas e curadas (ex.: `react.statuscode.com/issues/490`); as 494 já curadas **não** foram re-curadas. O que impede:
1. **Ramo 3 do `isUrlKnown`**: os jobs roundup processados ficam `done` na frontier — medido: **497 linhas roundup `done`** — e a paginação para na 1ª página toda-conhecida (`src/crawl.js:387-390`).
2. **Ramo 4**: itens curados carregam `issue_url` (`src/curate.js:338`) → mesmo com frontier limpa, 322 issues (com ≥1 item salvo) seguem protegidas.
3. **Piso `--since`**: links abaixo da data param a paginação (`src/crawl.js:423-427`) e `processRoundup` descarta a issue antes da curadoria quando ela tem data (`src/crawl.js:519-524`).
4. **Dedup pós-LLM**: `INSERT OR IGNORE` por URL UNIQUE (`src/curate.js:329`, `src/db.js:361-367` com `url TEXT UNIQUE` em `src/db.js:59`).

**Caveats (o buraco reabre):**
- **176 das 494 issues curadas salvaram ZERO itens** (tudo `dup` por URL já restaurada) → não deixam nenhuma linha `articles.issue_url` (medido: só 322 issue_url distintos em `articles`). A proteção delas é **apenas** a linha frontier `done`. Se a frontier for limpa (purge/reset/restore de snapshot sem `issue_url`), essas ~176 issues voltam a ser "novas" e são re-curadas por IA.
- O snapshot **commitado hoje ainda não tem `issue_url`** (`src/db.js:1119-1130`): um novo `restore` a partir do git atual repete o buraco até o próximo `export/deploy` gravar o campo.
- **O custo é pago ANTES do dedup**: mesmo uma issue que só produz dups gasta as ~7 chamadas de curadoria (mais na seção 2).

---

## 2. Curadoria por seção — chamadas e custo por issue

- `splitIntoSections` (`src/curate.js:105-138`): fatia o markdown por seção (News/Tools/Releases/IN BRIEF…), 1 agente por seção **em paralelo** (`src/curate.js:204-214`), com `sectionHint` por seção (`src/llm.js:513-523`). Máximo de 12 seções (`MAX_SECTIONS`, `src/curate.js:112`); seção maior que `CURATE_CHUNK_CHARS` (24.000, `src/config.js:353`) é sub-chunkada (`src/curate.js:129`). Sem seções detectáveis (< 2), cai para chunk por tamanho (`src/curate.js:122-124`).
- **Chamadas por issue**: N seções (média real **6,21**) + até 1 passe de cobertura (`src/curate.js:256-289`) + retries do `callJSON` (até `retries+1` = 3 tentativas no mesmo modelo; escalada p/ Pro é no-op pois Pro também é Flash — `src/llm.js:204-268`, `src/config.js:122-125`). Medido: **7,31 chamadas/issue** (3.609 ÷ 494).
- **Custo por chamada** (real, llm_usage run 1): **US$ 0,00181** média — 2.167 prompt + **6.216 completion** tokens (reasoning `high` é cobrado como output; preços Flash $0,14/M input, $0,28/M output, $0,0028/M cache-hit, `src/config.js:177-181`). **US$ 0,0132/issue**.
- **Roda ANTES do filtro de itens novos? SIM — totalmente.** A sequência é: seções em paralelo (`src/curate.js:204-214`) → cobertura (`src/curate.js:256-289`) → consolidação → **só então** o loop de INSERT com dedup (`src/curate.js:324-368`). **Issue nova com TODOS os itens já conhecidos gasta as mesmas ~7 chamadas (~US$ 0,013) e termina com 0 `saved`** — foi exatamente o caso de 176/494 issues da run 1 (todo `dup`). Não existe filtro por URL/item antes do LLM; o único guard "barato" é a página sem corpo curável (md < 200 chars ⇒ `null` ⇒ fluxo antigo, `src/curate.js:200`).
- Piso `--since` por issue: aplicado em `processRoundup` **antes** da curadoria quando a issue tem data (`src/crawl.js:517-524`), mas o piso interno da curadoria (`src/curate.js:312-315`) roda **depois** das chamadas — issue sem data na listagem paga a curadoria e só então é descartada.

---

## 3. Enrich / re-enfileiramento — com `ENRICH_MAX_ATTEMPTS=0`

### O teto está DESLIGADO de propósito (instrução do usuário, `ENRICH_MAX_ATTEMPTS=0` persistido em NC_HOME/.env)
No seed de cada fonte, no início de todo crawl (`src/commands.js:400-410`):
- `if (ENRICH_MAX_ATTEMPTS > 0) stmts.bumpFailedEnrichAttempts.run(src.id)` (`src/commands.js:404`) — **com cap=0 o bump NUNCA roda** → `enrich_attempts` fica congelado em 0 (medido: 42 itens `needs_enrich=1`, todos `enrich_attempts=0`).
- `requeueNeedsEnrichForSource.run(src.id, cap>0 ? cap : Number.MAX_SAFE_INTEGER)` (`src/commands.js:405`) — **com cap=0 o requeue é ILIMITADO**: todo `needs_enrich=1` com job `done|failed` volta a `pending` em toda run, sem nunca aposentar (`src/db.js:686-691`; `bump` em `src/db.js:680-685`; `countAtCap` em `src/db.js:694-699`).
- O **timeout de job** (relógio de trabalho `JOB_TIMEOUT_MS`=90s, `src/config.js:397`; `JOB_HARD_TIMEOUT_MS`=10×, `src/config.js:400-401`) mantém frontier `done` + `needs_enrich=1` (`src/commands.js:525-539`) → re-enfileirado no próximo crawl pela linha acima. Roundup/listing são isentos do corte (`src/commands.js:491-492, 507`).

### O que re-roda em TODA run futura com cap=0 (respondendo à pergunta 3)
| Caso | Re-roda toda run? | Evidência |
|---|---|---|
| **Fetch falha** (DNS/NXDOMAIN/breaker/timeout HTTP — `src/crawl.js:658-663` lança, `needs_enrich` fica 1; job: `bumpRetry` até `MAX_RETRIES`=3, `src/commands.js:549-551`, `src/config.js:315`, depois `failed`) | **SIM, para sempre** | Medido: os **MESMOS 38 alvos** falharam na run 1 e na run 2 (140 eventos `fetch fail` cada, interseção 38/38) |
| **Deadline 90s** | **SIM** — `done` + `needs_enrich=1` (`src/commands.js:533-539`) | 29 (run 1) / 4 (run 2) `job timeout` |
| **PDF/binário** (`.pdf` ou content-type pdf — `isPdfUrl` `src/fetch.js:188-194`, `isDownloadError` `src/fetch.js:195`, atalho `src/fetch.js:610-612, 627-630`) | **NÃO** — `keepAggregatorVersion` → `finishEnrich` (`needs_enrich=0`) (`src/crawl.js:606-613, 668`) | 3 kept-blurb `pdf-target` |
| **Bloqueado/anti-bot** (`isBlockedPage`, `src/parse-core.js:209-229`; `src/crawl.js:789-794`) | **NÃO** — mesmo rail | 10 kept-blurb `blocked-page` |
| **Raso / página de erro / JSON** (`src/crawl.js:773-804`) | **NÃO** — mesmo rail | 173 thin + 88 error + 4 json |
| **dup-content** (hash) | **NÃO** após o 1º tentativa — `keepAggregatorVersion` (`src/crawl.js:908-915`) | 79 kept-blurb `dup-content` |

Ou seja: **o loop infinito de re-tentativa só atinge (a) falhas de fetch e (b) timeouts** — mas com cap=0 eles NUNCA aposentam. O custo LLM de uma tentativa que falha cedo é **~zero** (DNS/breaker barram antes de HTML: `fetchSmart` checa o breaker `src/fetch.js:608`, PDF atalho `src/fetch.js:610-612`; a falha nem chega às fases LLM). O custo real aparece quando:
- o alvo morre na fase cara → ex.: timeout de 90s queimando render do Playwright (sem LLM, mas segurando lane/ram), ou
- **o alvo volta a responder** → aí corre o pipeline completo por tentativa: `fetch/render/parse` + (se necessário) `contentSelector` (derivação 1×por domínio, US$ 0,00103) + `articleExtract` (fallback, US$ 0,00032) + `articleClean` (US$ 0,00155) → save → streaming `verify` (US$ 0,00035) + `summarize` (US$ 0,00026) + `classify` **9 facetas** (9×US$ 0,000225 = US$ 0,00203; 1 chamada por faceta, `src/classify.js:68-70`, entrada cortada em `CLASSIFY_MAX_CHARS`=2000, `src/config.js:591`). **Total ≈ US$ 0,0042–0,0055 por re-enriquecimento efetivado** (médias reais run 1; preços `src/config.js:177-181`).
- Estado atual: **42 itens `needs_enrich=1` aguardando** — a próxima run re-tenta todos (fetch barato; se algum voltar, ~US$ 0,0042 cada).

### Nota de custo duplicado dentro de UMA tentativa
O check de `dup-content` por hash roda **depois** do `articleClean` (`src/crawl.js:823-855` → check em `908-915`): 79 dups pagaram limpeza IA (~US$ 0,00155 cada ≈ US$ 0,12) antes de serem reconhecidos como duplicados (o dedup por hash poderia rodar antes do clean). Item avulso idem (`src/crawl.js:910-914`).

---

## 4. `kept-blurb` — re-enfileira para sempre? **NÃO**

O rail `keepAggregatorVersion` (`src/crawl.js:606-613`) executa `stmts.finishEnrich` → **`needs_enrich=0`** (`src/db.js:422`) → o registro sai do filtro do `requeueNeedsEnrichForSource` (`WHERE needs_enrich = 1`, `src/db.js:689`) e do `bumpFailedEnrichAttempts` (`WHERE needs_enrich = 1`, `src/db.js:682`). A ficha **permanece** com o blurb do agregador (`content = título + blurb`, gravado na curadoria `src/curate.js:328`) — fail-open por design: a informação do agregador não se perde. Gatilhos: robots `src/crawl.js:650`, pdf `668`, error-page `774`, thin `781`, blocked `790`, json `800`, dup-content `911`. Medido na run 1: 353 kept-blurb; **nenhum deles re-enfileirou** (run 2: só 4 novos kept-blurb para itens novos).

**Exceção que re-enfileira:** o timeout de job (`src/commands.js:533-539`) — por decisão, mantém `needs_enrich=1` ("enriquece depois"), então um alvo que SEMPRE estoura os 90s re-enfileira em toda run (com cap=0, para sempre; com cap=3, aposenta após 3 rodadas via bump/requeue).

---

## 5. Cadastro na curadoria (`register-at-curation`) — re-INSERT e re-enrich?

`applyItems` (transação única, `src/curate.js:324-368`): cada item vira `INSERT OR IGNORE` imediato com `content = título — blurb`, `issue_url = URL da issue`, `content_source='aggregator'`, `needs_enrich=1`, `published_at = data da issue` (`src/curate.js:328-344`; statement `src/db.js:361-367`).

- **UNIQUE url salva contra re-INSERT**: `url TEXT UNIQUE` (`src/db.js:59`) + `INSERT OR IGNORE` → `res.changes === 0` ⇒ `dup++` (`src/curate.js:353-355`). Issue já curada (mesma issue_url) **não re-insere** itens; os 9.107 `item dup` da run 1 comprovam.
- **Re-enriquecimento** só no caso específico: item **antigo** (URL conhecida) ainda `needs_enrich=1` e abaixo do teto → `requeueUrl` (`src/curate.js:356-363`, `src/db.js:663-666`) → o job de enrich re-roda **na mesma run**. Item já enriquecido (`needs_enrich=0`) → `continue` sem requeue (`src/curate.js:361-362`). Com cap=0 a condição `ENRICH_MAX_ATTEMPTS <= 0` é sempre verdadeira (`src/curate.js:359`) → todo dup ainda-só-blurb é re-enfileirado.
- **Mas o custo de curadoria já foi pago antes do INSERT** (seção 2): a re-curadoria de uma issue custa ~US$ 0,0132 em LLM, mesmo que 100% dos itens sejam `dup`.
- Contraste com o fluxo avulso (sem curadoria): lá o dedup por URL acontece **antes** da extração/LLM (`src/crawl.js:644-647, 680-684`) — o item avulso duplicado não gasta nada.

---

## 6. Blocked / anti-bot — o que acontece com a página de desafio

- Detecção: `isBlockedPage` casa padrões de interstitial (Cloudflare "Just a moment", captcha, "checking your browser"…) no título + início do corpo (`src/parse-core.js:209-229`).
- **Item curado**: a página de desafio é **descartada como conteúdo** — `keepAggregatorVersion('blocked-page')` mantém só o blurb e **não re-tenta** (`needs_enrich=0`) (`src/crawl.js:789-794`).
- **Item avulso**: skip registrado e frontier `done` (`src/crawl.js:791-793`) — **não salva, não re-tenta**.
- Rede de segurança na verificação: `isBlockedPage` barato re-marca como `junk` qualquer desafio que por acaso tenha sido salvo (`src/verify.js:47-49`).
- Modo agressivo (default) "não salva página de desafio" (AGENTS.md) — consistente com o acima.

---

## Ranking dos vazamentos de gasto IA em re-run (maior → menor)

1. **Re-curadoria por re-coleta pós-restore com snapshot sem `issue_url`** — ~745 issues × ~US$ 0,0132 ≈ **US$ 9,85** na 1ª rodada (medido na 1ª: 494 issues → US$ 6,53, dos quais ~US$ 2,32 em 176 issues que salvaram 0 itens). Fecha sozinho após crawl+deploy que gravem `issue_url` (ramo 4 do `isUrlKnown`, `src/curate.js:338`), mas **reabre** se a frontier for limpa ou um restore antigo rodar de novo (`src/db.js:1119-1130, 1354-1361`). Mitigação operacional: sempre `--since` recuado à última data coberta na 1ª coleta pós-restore.
2. **Re-enfileiramento perpétuo de alvos mortos com `ENRICH_MAX_ATTEMPTS=0`** — 38 alvos (medidos) + 42 pendentes re-tentam fetch em **toda** run; LLM ~zero enquanto o domínio não responde, mas **~US$ 0,0042–0,0055/alvo** no dia em que o alvo volta (pipeline clean+verify+summarize+classify). Evidência: `src/commands.js:404-405` (bump pulado + requeue ilimitado), `src/db.js:680-691`; re-falha idêntica medida run1=run2 (38/38).
3. **Curadoria sem filtro pré-LLM de itens já conhecidos** — issue nova (ou re-descoberta) com todos os itens existentes gasta ~7 chamadas (~US$ 0,013) e salva 0 (176/494 na run 1, ~US$ 2,32). Estrutural: todo o LLM roda antes do `INSERT OR IGNORE` (`src/curate.js:204-289` → `324-368`).
4. **Re-verificação/re-classificação/re-resumo de conteúdo já processado** — **não vaza**: todos os sweeps são NULL-only/delta (verify `src/db.js:427-430`, summarize `src/db.js:451-453`, classify `src/db.js:821-828`) e o restore marca classificação com `status='restored'` para o acervo restaurado não ser re-classificado (15k × 9 facetas ≈ US$ 34 evitados; `src/restore.js:1035-1038`, `src/db.js:1299-1315`). Streaming pós-save idem (`src/commands.js:455-489`).
5. **Pequeno**: `dup-content` paga `articleClean` antes do check de hash (~US$ 0,12 na run 1; `src/crawl.js:823-855` vs `908-915`) e `dateSelector`/`linkSelector` são derivadas por IA a cada template novo/`--since` sem spec (`src/crawl.js:341-373`, 1× por template).

---

## Anexo — evidências medidas (consultas read-only, 11/set)

- `llm_usage run 1`: 23.041 chamadas, US$ 13,6719 (curate 3.609/$6,5331; classify 13.879/$3,1229; articleClean 1.642/$2,5519; verifyRecord 1.578/$0,5574; summarize 1.578/$0,4125; contentSelector 315/$0,3254; articleExtract 431/$0,1371; linkSelector 8/$0,0312; nextLink 1/$0,0003).
- `events run 1`: curate ok 494 / coverage 494; item saved 1.957 / dup 9.107 / skipped 1.251; enrich ok 1.537 / kept-blurb 353; job timeout 29; fetch fail 140 (38 URLs); archive ok 33; fetch ok 2.418.
- `events run 2`: curate ok/coverage 3; item saved 42 / dup 11; enrich ok 48 / kept-blurb 4; fetch fail 140 (**38 URLs, interseção 38/38 com run 1**); job timeout 4; archive ok 8.
- `articles`: content_source restore 15.502 (issue_url NULL todas) / aggregator 399 + target 1.614 (run 1) / aggregator 4 + target 40 (run 2); needs_enrich=1 em 42 (enrich_attempts=0); verify NULL 607; summary_pt NULL 638; classifications 16.853; issue_url distintos 322.
- `frontier`: article done 17.500 / failed 34 / in_progress 2; roundup done 497; listing done 9. `pages`: 33 `done` (só listagens).
- Seções por issue (run 1): média 6,21 (distribuição 1–13; 83 issues com 1 seção → chunk fallback).