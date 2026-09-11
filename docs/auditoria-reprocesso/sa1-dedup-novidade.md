# Auditoria SA1 — Dedup & "novidade": como o crawler decide NOVO vs JÁ CONHECIDO

**Alvo:** `/Volumes/Ext2TB/Projects/newsletter-crawler` (Node ESM, SQLite em `~/.newsletter-crawler/crawler.db`)
**Data:** análise somente-leitura (nenhuma escrita no banco, nenhum crawl/finish/search executado).
**Fontes primárias:** `src/db.js`, `src/crawl.js`, `src/curate.js`, `src/commands.js`, `src/util.js`, `src/verify.js`.
**Compromisso do relatório:** toda afirmação com `file:line`.

---

## 0. Resposta executiva (TL;DR)

1. A decisão "novo vs conhecido" acontece em **camadas**, todas com custo crescente: (a) `isUrlKnown` na paginação/seed (determinístico, zero LLM), (b) `enqueue` com `INSERT OR IGNORE` na `frontier` (URL única), (c) `insertArticle` com `INSERT OR IGNORE` em `articles` (URL única + `content_hash` único), (d) gates de coluna (`needs_enrich`, `verify_status`, `summary_pt`, `classifications`) que só deixam rodar LLM em linha com valor NULL.
2. **Um artigo 100% salvo (`needs_enrich=0`) que re-aparece custa ZERO LLM**: `processArticle` devolve imediatamente em `src/crawl.js:644-647` — nem fetch, nem parse, nem clean, nem verify/classify/summarize (esses são NULL-only). A única exceção é o item **só-blurb** (`needs_enrich=1`), re-enfileirado por design (enrich-later) — e a **re-curadoria da issue** quando o job roundup é recriado (frontier limpa / lacuna pós-restore).
3. **Re-run com `--since` numa data já coberta** re-faz: fetch das listagens (rede) + walk de paginação até o stop determinístico. LLM só entra se (i) houver item `needs_enrich=1`, (ii) a issue for re-curada (job roundup recriado), (iii) a listagem não tiver seletor cacheado (derivação Pro + extração Flash da página inteira antes do check de conhecidos), ou (iv) derivação de date-selector / next-page.

---

## 1. Caminho item-level de dedup: onde o link vira "novo" ou "dup/skipped"

### 1.1 `isUrlKnown` — o gate determinístico (zero LLM)

Definido em `src/db.js:401-410`, com comentário de semântica em `src/db.js:384-400`:

```sql
isUrlKnown: db.prepare(`
  SELECT 1 FROM articles WHERE url = ?          -- ramo 1: artigo já salvo
  UNION ALL
  SELECT 1 FROM pages WHERE url = ?             -- ramo 2: listagem/issue já visitada
  UNION ALL
  SELECT 1 FROM frontier WHERE url = ? AND state IN ('done','failed','pending','in_progress')  -- ramo 3
  UNION ALL
  SELECT 1 FROM articles WHERE issue_url = ?    -- ramo 4: URL é issue de itens já salvos
  LIMIT 1
`),
```

- Os **4 ramos** são exatamente os pedidos: `articles.url` (`db.js:402`), `pages.url` (`db.js:404`), `frontier` em `done|failed|pending|in_progress` (`db.js:406`) e `articles.issue_url` (`db.js:408`).
- Por que `pending/in_progress/failed` contam e não só `done`: comentário em `db.js:387-398` — "JÁ CONHEÇO esta URL, não preciso descobri-la de novo na listagem"; `failed` foi abandonado de propósito e `pending/in_progress` já estão na fila desta run. Como `enqueue` é `INSERT OR IGNORE` (`db.js:626-629`), pular o enfileiramento nunca perde nada.
- **Ramo 4 é o fio da navalha do restore**: só rende se o snapshot exportado carrega `issue_url` (o código exporta — `src/export-web.js:87` — mas o `articles.json` commitado hoje veio do exportador antigo, 0/13.758 com `issue_url`; medido em restauração real: guard reconheceu 100% das 15.502 URLs de artigo e 0 de 747 de issue ⇒ a 1ª coleta pós-restore re-cura ~745 issues; mitigação = `--since` recente). Comentários em `src/db.js:1110-1126`.

**Uso na paginação (`crawlArchive`, fontes index/listing)** — `src/crawl.js:297-452`:

| Passo | Linha | O que faz |
|---|---|---|
| Fetch da página (html) | `crawl.js:308-313` | rede; sem LLM |
| Parada por conteúdo repetido (hash) | `crawl.js:315-320` | `sha256(html)` repetido ⇒ break |
| Valida seletor de links | `crawl.js:322-326` | sem links ⇒ break |
| Pareamento link→data (spec cacheado) | `crawl.js:331-336` | só com `--since` |
| **Derivação de date-selector (LLM Flash)** | `crawl.js:341-373` | SÓ se `--since` ativo, ≥3 links e NENHUM datado nos fallbacks |
| **Stop determinístico `isUrlKnown`** | `crawl.js:383-393` | se `knownCount === dated.length` ⇒ **break antes de enfileirar** (linha 387-390); `≥50%` ⇒ log "território conhecido" (391-393) |
| Loop de enfileiramento | `crawl.js:397-405` | `d < sinceDate` ⇒ `below++` e `continue` (400-403); senão `enqueue(...)` (404) |
| `upsertPage` (marca a página como visitada) | `crawl.js:406-412` | `pages.url` UNIQUE — alimenta ramo 2 do `isUrlKnown` |
| Paradas de segurança | `crawl.js:423-433` | `below>0` ⇒ piso atingido (423-427); `added===0` ⇒ incremental (430-433) |
| Próxima página | `crawl.js:435-451` | `findNextPage`: cache → `rel=next` → `?page=N` → **LLM Flash** (`crawl.js:472-481`) |

**Uso no fallback item-a-item (sem seletor cacheado)** — `src/crawl.js:242-267`:
1. `extractLinksItemByItem` (**LLM Flash**, `crawl.js:244`) roda ANTES do check — custo LLM por página mesmo se tudo já for conhecido;
2. mescla colheita do scroll (`mergeScrollHarvest`, `crawl.js:245`, 279-294);
3. **mesmo stop determinístico**: `knownCount === links.length` ⇒ "todos os links já conhecidos, parando" (`crawl.js:248-256`); `≥50%` ⇒ log (`257-259`);
4. piso por data (`263-264`) e enqueue (`265`).

**Uso no seed da run (listagem)**: `enqueue(s.url,'listing',…)` (`commands.js:394`) + `refreshListing` re-ativa só seeds `listing` done/failed (`commands.js:396-398`; `db.js:658-661`).

**Uso na curadoria (issues index)** — o fluxo principal é outro (ver §1.2): `curateRoundup` NÃO consulta `isUrlKnown` por item; a dedup é feita pelo `INSERT OR IGNORE` de `insertArticle` + `enqueue`.

### 1.2 Cura da issue (fonte `index`): `item saved` / `item dup` / `item skipped`

Fluxo: `processRoundup` (`crawl.js:500-575`) → `curateRoundup` (`curate.js:193-381`). A issue vira markdown → `splitIntoSections` (1 agente Flash por seção, `curate.js:56-138`) → `consolidateItems` (`curate.js:145-186`) → **transação única** de cadastro+enfileiramento (`curate.js:324-368`).

**Filtro determinístico na consolidação (é daqui que nasce `item skipped`)** — `curate.js:145-186`:

| Motivo | Linha | Condição |
|---|---|---|
| URL inválida / não-http(s) | `curate.js:155-158` | `!abs \|\| !/^https?:/i.test(abs)` ⇒ `skipped.invalid` |
| Link interno do agregador | `curate.js:159-162` | `hostOf(abs) === host` ⇒ `skipped.internal` |
| **Sponsor** (regex + rótulo LLM) | `curate.js:19, 165` | `SPONSOR_RE = /\bsponsor(?:ed\|ship)?\b\|\bpatrocin\|\bpublieditorial\b/i` força `kind='sponsor'` |
| **Job/vaga** | `curate.js:20, 166` | `JOB_RE = /\bclassifieds?\b\|\bhiring\b\|\bvaga(s)?\b\|\bjob board\b/i` em `it.section` ⇒ `kind='job'` |
| Kind fora de `SAVED_KINDS` | `curate.js:21, 167-170` | `SAVED_KINDS = {news, tool, release}` ⇒ `skipped[kind]` |
| Dedup por URL canônica intra-chunk | `curate.js:171-182` | `Map(seen)` por URL |

**Emissão dos eventos** — `curate.js:324-371`:

| Evento | Linha | Significado |
|---|---|---|
| `item saved` | `curate.js:348-352` | `insertArticle.run(...).changes > 0` — item novo (ou com conteúdo novo) gravado: `content = título — blurb`, `needs_enrich=1`, `content_source='aggregator'`, `cleaned=0` |
| `item dup` | `curate.js:353-355` | `changes === 0` — o `INSERT OR IGNORE` engoliu (URL já existe **ou** `content_hash` colide). Contador `dup++`; **se o registro antigo ainda `needs_enrich=1` e abaixo do teto, `requeueUrl` re-ativa o job** (`curate.js:356-363`); senão `continue` (nem re-enfileira) |
| `item skipped` | `curate.js:369-371` | **agregado por motivo** (`{kind:count}`) — sponsor/job/other/internal/invalid — emitido UMA vez por issue, do mapa `skipped` de `consolidateItems` (`curate.js:148`) |
| `curate ok` (resumo) | `curate.js:373-378` | totais `saved/dup/enqueued/byKind/skipped/recovered/sections` |

O `enqueue` do enriquecimento roda para os dois casos (salvo E dup-com-requeue) em `curate.js:365` — `INSERT OR IGNORE` na frontier, então duplicata de fila é no-op.

**Piso de data da ISSUE** (não vira evento `skipped`, vira skip do roundup): `curate.js:310-315` (`below-since`) e backstop em `processRoundup` `crawl.js:513-524` com `roundupIssueDate` (`crawl.js:493-498`, data do par da listagem `frontier.discovered_date` é autoritativa).

### 1.3 Artigo avulso / enriquecimento: motivos de `skip` (eventos `stage:'article', status:'skip'`)

`processArticle` (`crawl.js:630-965`) emite:

| Motivo | Linha | Condição |
|---|---|---|
| **(url já existe, completo) — retorno silencioso** | `crawl.js:644-647` | `pre && !enriching` ⇒ log "artigo já existe (url canônica) ignorado", `return` **sem evento** |
| `robots` | `crawl.js:649-652` | robots.txt nega (modo educado) |
| `pdf-target` | `crawl.js:667-671` | alvo PDF/binário (`isPdfUrl`/`isDownloadError`) — avulso: skip; curado: `kept-blurb pdf-target` (`668`) |
| `dup-url` | `crawl.js:679-684` | **pós-redirect**: `canonicalUrl = normalizeUrl(finalUrl)` já em `articles` ⇒ skip ANTES de extrair (comentário 677-678) |
| `error-page` | `crawl.js:773-777` | `isErrorPage` (404/500/etc., `crawl.js:617-628`) |
| `no-content` | `crawl.js:780-785` | `< 50 chars` extraídos |
| `blocked-page` | `crawl.js:789-794` | interstitial anti-bot (`isBlockedPage`) |
| `json-page` | `crawl.js:799-804` | corpo é JSON puro (`looksLikeJson`) |
| `below-since` (cedo) | `crawl.js:809-818` | data própria do AVULSO < piso (item curado é imune: âncora é a issue — comentário 806-808) |
| `below-since` (pós-hoc) | `crawl.js:897-906` | data só resolvida após clean — rede do Achado 2 |
| `dup-hash` | `crawl.js:908-915` | `sha256(content)` já existe em outro artigo ⇒ skip (ver §2) |
| `split` (evento, não skip) | `crawl.js:700-715` | página de artigo é coleção de links ⇒ divide e enfileira filhos |

**Keep-blurb (item curado que não rendeu corpo)** — `keepAggregatorVersion` (`crawl.js:607-613`) → `finishEnrich` (`needs_enrich=0`, `db.js:422`) + evento `enrich kept-blurb {reason}`: `robots` (650), `pdf-target` (668), `error-page` (774), `thin-content` (781), `blocked-page` (790), `json-page` (800), `dup-content` (911).

### 1.4 Onde o dump de eventos é lido

`ncrawl inspect` agrupa `events` por stage/status (`commands.js:1462`, `db.js:706-711`) — os eventos `item dup`/`item skipped` são **telemetria diagnóstica** (buffer transacional, flush em lote — `src/events.js`), não controlam fluxo.

---

## 2. Unique constraints e o `INSERT OR IGNORE`

### 2.1 Schema

| Constraint | Linha |
|---|---|
| `articles.url TEXT UNIQUE` (coluna) | `db.js:59` |
| `CREATE UNIQUE INDEX idx_articles_hash ON articles(content_hash)` | `db.js:91` (+ migração p/ UNIQUE em DBs antigos: `db.js:221-233`) |
| `pages.url TEXT UNIQUE` | `db.js:49` |
| `frontier.url TEXT UNIQUE` | `db.js:81` |
| `sources.base_url TEXT UNIQUE` | `db.js:40` |

### 2.2 `insertArticle` — `INSERT OR IGNORE` (`db.js:361-367`)

```js
insertArticle: db.prepare(
  `INSERT OR IGNORE INTO articles
     (source_id, url, title, content, content_hash, ...)
   VALUES (...)`)
```

- **Item cuja URL já existe** (curadoria): `changes === 0`, contado como `item dup` (`curate.js:353-355`). **Ignorado sem custo** — não re-salva, não re-limpa, não re-classifica. Se o registro antigo estava `needs_enrich=1` e abaixo do teto, o job de enriquecimento é re-ativado (`curate.js:356-363`) — custo LLM intencional "enrich later".
- **URL nova mas `content_hash` colidindo com artigo existente**:
  - **Curadoria**: o `OR IGNORE` engole a violação do índice de hash também ⇒ vira `item dup`; como `getArticleFullByUrl.get(it.url)` é `NULL` (URL é nova), o else em `curate.js:358-363` faz `continue` — **o item é descartado sem re-enfileirar** (não salvo, sem job, sem LLM extra). Caso raro (conteúdo `título — blurb` byte-a-byte igual entre duas URLs).
  - **Avulso (`processArticle`)**: o dup-hash é detectado **antes** do insert — `dupHash && (!enriching || dupHash.id !== enriching.id)` ⇒ skip `dup-hash` (`crawl.js:908-915`); `enriching` com hash do **próprio** registro (`dupHash.id === enriching.id`) segue para `enrichArticle` (update, `crawl.js:917-941`); `enriching` com hash de **outro** registro ⇒ `kept-blurb dup-content` (`crawl.js:911`) — mantém o blurb, `needs_enrich=0`, nunca re-salva o corpo.
  - **Restore**: `restoreArticle` também é `INSERT OR IGNORE` e devolve `reason:'hash'` quando o id devolvido é de outra URL com conteúdo idêntico (`db.js:1175-1224`, comentário `restore.js:1159`).
- O INSERT do avulso (`crawl.js:943-958`) não checa `changes` — mas os gates pré-insert (`crawl.js:644-647` e `680-684` para URL, `908-915` para hash) tornam a colisão impossível no fluxo single-process síncrono; o `OR IGNORE` é a rede final.

### 2.3 `enqueue` — `INSERT OR IGNORE` na frontier (`db.js:626-629`, wrapper `crawl.js:35-49`)

- URL já com linha na frontier (qualquer estado) ⇒ no-op (`changes === 0` → `enqueue()` retorna `false`, `crawl.js:48`).
- Wrapper ainda normaliza a URL (`crawl.js:36`) e rejeita URLs corrompidas com `%20` antes de `param=` (`crawl.js:42-45`).
- Consequência de design (comentário `db.js:389-398`): frontier limpa transforma todo link em "novo" **na fila**, mas o `isUrlKnown` (ramos 1/2/4, que não dependem da frontier) impede a re-coleta e a re-curadoria no nível de listagem — salvo a lacuna do ramo 4 pós-restore (§1.1).

---

## 3. Gates anti-reprocessamento de artigo JÁ SALVO — custo LLM de um item repetido

### 3.1 O gate principal: `processArticle` devolve antes de qualquer trabalho

`src/crawl.js:641-647`:

```js
const jobNorm = normalizeUrl(url) || url;
const pre = stmts.getArticleFullByUrl.get(jobNorm);
const enriching = pre && pre.needs_enrich ? pre : null;
if (pre && !enriching) {
  log(`artigo já existe (url canônica) ignorado: ${url}`);
  return;
}
```

- `pre` existe ⇒ URL JÁ está em `articles`; `enriching` é não-nulo **só** se `needs_enrich=1` (só-blurb).
- **`needs_enrich=0` (conteúdo completo) ⇒ `return` imediato**: sem `fetchSmart`, sem parse, sem README do body — **zero LLM**. O wrapper do dispatch marca o job `done` (`commands.js:510`).
- **`needs_enrich=1` (só-blurb) ⇒ segue o caminho de ENRIQUECIMENTO**: fetch → parse → clean IA (`crawl.js:824-855`) → `enrichArticle` (`crawl.js:917-941`). Este é o único caso em que LLM roda para uma linha que JÁ EXISTE em `articles` — e é por design (o blurb do agregador é provisório até o corpo do alvo chegar).
- Gate pós-redirect redundante: `crawl.js:679-684` (`dup-url`).

### 3.2 Gates de coluna (verify/summarize/classify são NULL-only)

| Gate | Statement | Linha |
|---|---|---|
| Verify (streaming) | `a.verify_status == null` | `commands.js:459` |
| Summarize (streaming) | `a.summary_pt == null` | `commands.js:469` |
| Classify (streaming) | `!stmts.getClassification.get(a.id)` | `commands.js:479` |
| Verify sweep pós-crawl | `verifyPending({})` → `listArticlesToVerify` = `WHERE verify_status IS NULL` | `commands.js:641`; `db.js:427-430`; `verify.js:77-87` |
| Summarize sweep | `listArticlesNeedingSummary` = `WHERE summary_pt IS NULL` | `commands.js:647`; `db.js:451-453` |
| Classify sweep | `LEFT JOIN classifications ... IS NULL` | `commands.js:644`; skill `persisting-and-orchestrating` |
| `finish` sem `--force` | só pendentes (mesmos statements) | `commands.js:1271-1278` |
| `finish --force` | re-roda o acervo INTEIRO — **destrutivo**: exige `--yes` + backup | `commands.js:1239-1268` (`--force` re-seleciona com `listArticlesForReverify`, `db.js:431-433`) |

O streaming pós-save só dispara para a URL que ACABOU de ser salva/enriquecida (`commands.js:511`: `if (res?.verifyUrl) streamPostSave(...)`).

### 3.3 Resposta direta à pergunta 3

> Uma issue re-listada traz um link cujo URL JÁ está em `articles` — quanto de LLM roda para ele?

| Estado da linha em `articles` | LLM item-level |
|---|---|
| `needs_enrich=0` (conteúdo completo, mesmo `cleaned=0` ou `verify_status` NULL) | **ZERO** — `return` em `crawl.js:644-647`; se o job nem existe (frontier done), nem é reivindicado (`enqueue` no-op `db.js:626-629`); verify/classify/summarize NULL-only (`§3.2`). A linha nem é re-salva nem re-limpa nem re-verificada. |
| `needs_enrich=1` (só-blurb) | LLM **sim** (clean Flash) — caminho de enrich: fetch + parse + `cleanArticleContent` (`crawl.js:824-855`) + `enrichArticle` (`917-941`). Redes de segurança: teto `enrich_attempts` (nesta máquina, DESLIGADO — ver §4) e keeps-blurb fail-open. |
| URL **não** está em articles (só na frontier done) | ZERO para o item — `isUrlKnown` ramo 3 para a paginação; se mesmo assim um job for criado (frontier limpa), `processArticle` nem chega a ser LLM: o conteúdo nem existe... na verdade o job avulso roda o fluxo normal (fetch+LLM) **se a pipeline o reenfileirar** — mas o `isUrlKnown` da listagem impede o reenfileiramento (`crawl.js:383-393`), exceto se a URL veio do split de artigo-roundup (`crawl.js:700-715`, raro). |

**Custos LLM que PODEM rodar numa re-run mesmo com tudo salvo (escopos de página, não de item):**
1. **Re-curadoria da issue** (a mais cara): só se o job `roundup` for recriado — frontier limpa ou restore sem `issue_url` no snapshot (ramo 4 mudo, `db.js:1110-1126`; AGENTS.md "Limitação conhecida"). Aí a issue inteira é re-lida por Flash por seção (`curate.js`), mas cada item já salvo vira `item dup` com ZERO LLM item-level.
2. **Listagem sem seletor cacheado**: `deriveLinkSelector` (Pro xhigh, `crawl.js:212-232`) e `extractLinksItemByItem` (Flash, `crawl.js:244`) rodam por página ANTES do stop conhecidos (`crawl.js:251-256`).
3. **Derivação de date-selector** (`crawl.js:341-373`) e **next-page via LLM** (`crawl.js:472-481`) — sob `--since` / sem spec cacheado.
4. **`finish --force` / `reclean` / `reextract`** — comandos destrutivos explícitos, fora do crawl normal.

---

## 4. `resetInProgress`, `requeueNeedsEnrichForSource`, `bumpFailedEnrichAttempts`

**Chamadas no início da run** — `src/commands.js:319-411`:

| Passo | Linha | Statement (`src/db.js`) | Efeito |
|---|---|---|---|
| Reset de órfãos | `commands.js:325-326` | `resetInProgress` (`db.js:655`): `UPDATE frontier SET state='pending' WHERE state='in_progress'` | Job travado de processo morto/run anterior volta à fila; log do nº ressuscitado |
| Seed da listagem | `commands.js:392-399` | `enqueue` + `refreshListing` (`db.js:658-661`) | `enqueue` no-op se a linha existe; `refreshListing` re-ativa só seeds `kind='listing'` `done\|failed` → `pending` com `retries=0` (re-visita a listagem a cada run; roundup/article NÃO são re-ativados aqui) |
| Bump de tentativas | `commands.js:404` | `bumpFailedEnrichAttempts` (`db.js:680-685`): `enrich_attempts+1` onde `needs_enrich=1 AND source_id=? AND url IN (frontier done\|failed)` | **Só roda se `ENRICH_MAX_ATTEMPTS>0`.** Conta a rodada FALHADA do run anterior: `needs_enrich=1` + job TERMINADO é, por construção, falha de enrich (deadline corta com frontier `done`; sucesso/keeps zeram `needs_enrich` via `enrichArticle`/`finishEnrich`). Sem o bump, o teto nunca chegava e domínio morto re-falhava para sempre |
| Re-enfileiramento dos só-blurb | `commands.js:405-406` | `requeueNeedsEnrichForSource` (`db.js:686-691`): `frontier SET state='pending', retries=0 WHERE kind='article' AND state IN ('done','failed') AND url IN (SELECT url FROM articles WHERE needs_enrich=1 AND source_id=? AND enrich_attempts < ?)` | Re-ativa jobs de enriquecimento pendentes (deadline do run anterior) com teto por alvo |
| Reporte do teto | `commands.js:407-410` | `countEnrichAtCapForSource` (`db.js:694-699`) | Log de quantos ficaram no teto (mantidos com blurb, fail-open) |

**Por que re-enfileira**: "Enriquecer depois" — um item cadastrado na curadoria só com o blurb (`needs_enrich=1`, `content_source='aggregator'`) é um registro VÁLIDO; o corpo do alvo é um upgrade (data/contexto melhor p/ search). Re-ativar no início do crawl é o que torna o deadline "enrich na próxima run" real (comentários `db.js:662-679`).

**NESTA MÁQUINA**: `ENRICH_MAX_ATTEMPTS=0` persistido em `NC_HOME/.env` (ver AGENTS.md — instrução explícita do usuário "em falha ela volta a ser processada"): o bump fica **desligado** (`commands.js:404`) e o cap vira `Number.MAX_SAFE_INTEGER` (`commands.js:405`) ⇒ **todo** item só-blurb é re-enfileirado em toda run, alvos mortos re-falham sempre (rápido: DNS/breaker), itens nunca são aposentados — comportamento intencional nesta máquina, mas com custo LLM recorrente por item `needs_enrich=1` (ver §3.3).

---

## 5. `normalizeUrl` / canonicalização

**Definição:** `src/util.js:8-26` (biblioteca `normalize-url`):

```js
export function normalizeUrl(u, base) {
  if (!u) return null;
  try {
    const abs = base ? new URL(u, base).href : new URL(u).href;
    return normalizeUrlLib(abs, {
      stripWWW: false,                              // NÃO remove www (comentário 14-16)
      stripHash: true,                              // remove fragmento #...
      removeQueryParameters: [/^utm_/i, 'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      sortQueryParameters: true,
      removeTrailingSlash: true,
    });
  } catch { return null; }
}
```

| Aspecto | Comportamento | Linha |
|---|---|---|
| Absolutização vs. base (links relativos) | `new URL(u, base)` | `util.js:12` |
| `www.` | **preservado** — decisão deliberada: `www.host` e `host` podem ser servidores DIFERENTES; vários Substack de domínio próprio (ex.: `www.deeplearningweekly.com`) não têm DNS no ápice; colapsar geraria URL morta | `util.js:14-17` |
| Fragmento (`#...`) | **removido** | `util.js:18` |
| Query params de tracking | **removidos**: `utm_*` (regex), `ref`, `fbclid`, `gclid`, `mc_cid`, `mc_eid` | `util.js:19` |
| Ordem dos query params | **ordenada** (A/B e B/A colapsam) | `util.js:20` |
| Trailing slash | **removida** | `util.js:21` |
| URL inválida | `null` (nunca lança) — os chamadores tratam | `util.js:23-25` |

**Onde a canonicalização é aplicada na dedup:** todo link vira `normalizeUrl` antes de qualquer comparação/enfileiramento — `crawl.js:36` (enqueue), `crawl.js:66` (externalLinks), `crawl.js:250, 281, 285` (fallback/scroll), `crawl.js:641` e `679` (identidade do job e pós-redirect), `curate.js:154, 231, 245` (consolidação/cobertura), `selectors.js:34, 159`, `config.js:715-739` (fontes), restore (`db.js:1184, 1343, 1368`). A URL gravada em `articles.url`/`pages.url`/`frontier.url` é sempre a canônica — é isso que faz o ramo 1 do `isUrlKnown` casar mesmo quando a listagem traz a URL com `?utm_source=...` diferente.

---

## 6. Tabela-resumo dos eventos de dedup

| Evento (`stage`/`status`) | Linha de emissão | Significado operacional |
|---|---|---|
| `item`/`saved` | `curate.js:350` | Item curado novo gravado (blurb, `needs_enrich=1`) |
| `item`/`dup` | `curate.js:355` | `insertArticle` OR IGNORE engoliu (URL ou hash repetidos); requeue só se `needs_enrich=1` c/ tentativa |
| `item`/`skipped` | `curate.js:370` | Agregado por motivo: sponsor/job/kind-inválido/interno/URL-inválida (`curate.js:148-170`) |
| `article`/`skip {reason}` | `crawl.js:651, 670, 682, 776, 783, 792, 802, 815, 903, 913` | robots, pdf-target, dup-url, error-page, no-content, blocked-page, json-page, below-since (×2), dup-hash |
| `enrich`/`kept-blurb {reason}` | `crawl.js:610` (+ chamadas 650, 668, 774, 781, 790, 800, 911) | Item curado mantém blurb: `finishEnrich` (`needs_enrich=0`) |
| `archive`/`ok` | `crawl.js:417-421` | Página do arquivo: `{links, novos, abaixoDoPiso}` |
| `roundup`/`skip` | `crawl.js:505, 522, 567`; `curate.js:313` | robots, below-since (issue), no-links |
| `curate`/`coverage` / `ok` | `curate.js:293-302, 378` | Funil do passe de cobertura / resumo da issue |

---

## 7. Conclusão (resposta às 5 perguntas)

1. **Caminho de dedup**: link → `normalizeUrl` → `isUrlKnown` (4 ramos; `db.js:401-410`) na paginação/fallback (`crawl.js:383-393`, `248-256`) → `enqueue` OR IGNORE (`db.js:626-629`) → curadoria grava via `insertArticle` OR IGNORE (`curate.js:329-344`) → `processArticle` gate `needs_enrich` (`crawl.js:641-647`). `item dup` = insert rejeitado (`curate.js:353-355`); `item skipped` = agregado por motivo da consolidação (`curate.js:369-371`; motivos: sponsor/job regex `curate.js:19-20`, kind fora de SAVED_KINDS `curate.js:21`, interno/inválida `curate.js:155-162`; piso de data vira skip de issue/artigo, não `item skipped`).
2. **UNIQUEs**: `articles.url` (`db.js:59`) + índice UNIQUE `content_hash` (`db.js:91`) + `frontier.url`/`pages.url` (`db.js:81, 49`). OR IGNORE engole ambos: URL repetida = ignorado sem custo; URL nova com hash colidindo = descartado sem re-salvar/limpar/classificar (curadoria: `curate.js:358-363`; avulso: `crawl.js:908-915`).
3. **Sim, há gates**: `needs_enrich=0` ⇒ `return` zero-LLM (`crawl.js:644-647`); verify/summarize/classify NULL-only (`commands.js:459, 469, 479`; `db.js:427-430, 451-453`). **Custo LLM de item já salvo e completo = ZERO**, salvo se `needs_enrich=1` (enrich por design) ou se a issue inteira for re-curada (fronteira perdida/lacuna de `issue_url`).
4. **Seed da run**: `resetInProgress` ressuscita `in_progress` órfãos (`commands.js:325`, `db.js:655`); `bumpFailedEnrichAttempts` conta rodada falhada (`commands.js:404`, `db.js:680-685`); `requeueNeedsEnrichForSource` re-ativa só-blurbs com teto por alvo (`commands.js:405`, `db.js:686-691`). Nesta máquina o teto está desligado (`ENRICH_MAX_ATTEMPTS=0`) por decisão do usuário.
5. **`normalizeUrl`** em `util.js:8-26`: remove fragmento, utm_*/ref/fbclid/gclid/mc_cid/mc_eid, ordena query, remove trailing slash; **preserva `www.`**; absoluta contra base; `null` se inválida. É a chave de tudo: a URL gravada no banco é sempre a canônica.