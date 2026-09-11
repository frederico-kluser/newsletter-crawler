# Auditoria SA4 — Re-visita das listagens e parada de paginação numa re-run

**Alvo:** `/Volumes/Ext2TB/Projects/newsletter-crawler` (Node ESM, SQLite em `~/.newsletter-crawler/crawler.db`)
**Data:** análise somente-leitura (nenhuma escrita no banco; consultas `sqlite3 -readonly`; a run #2 estava **em andamento** durante a coleta e não foi tocada).
**Fontes primárias:** `src/commands.js`, `src/crawl.js`, `src/fetch.js`, `src/db.js`, `src/selectors.js`, `src/llm.js`, `src/util.js`, `src/config.js`, `src/restore.js`.
**Compromisso do relatório:** toda afirmação com `file:line`; números de run verificados no banco.

---

## 0. Resposta executiva (TL;DR)

1. **A listagem É re-fetchada a cada run** — por design: o seed re-enfileira o job `listing` de cada fonte (`commands.js:394-399` + `refreshListing` `db.js:658-661`). `--no-refresh` desliga **exatamente** esse flip: sem ele a listagem fica `done` e não é visitada (0 fetch). Não existe função `fetchListing`: a visita é `processListing` → `fetchSmart` com perfil `listing` (`crawl.js:195-197`), estático primeiro, Playwright só se o HTML cru estiver vazio (`fetch.js:588-598, 614-635`).
2. **Com `--since 2026-09-05` e TODOS os itens já conhecidos: 1 página por fonte** (a primeira), parada na **condição known-url** ("todos os N links já conhecidos", `crawl.js:387-389`), **zero LLM**. Com `--no-refresh`: **zero páginas**. Confirmado ao vivo na run #2: 8 fontes re-fetchadas 16:32:52→16:33:55, todas `pagination_depth 0`, nenhuma continuação de página; paginação stopped antes de chegar ao `added===0`.
3. **Seletores**: cache em tabela SQLite `selectors`, chave `template_sig` (`db.js:67-77`; `getCachedSelector`/`putSelector` `selectors.js:6-26`), gerada por `domainSig` (`util.js:83-97`). Com seletores salvos e validando, a descoberta (link/next/date) custa **0 chamadas LLM** (validação é só Cheerio — `crawl.js:202-209, 322-326`). A run #1 teve **315 contentSelector** porque o cache estava **VAZIO pós-restore** (o `restore` repõe articles/pages/frontier, **nunca** `selectors` — `restore.js:1030`), e o snapshot commitado não tinha `issue_url`, então a 1ª coleta re-curou ~745 issues e derivou seletor de conteúdo por host novo (1 por `host:article`). A tecla `d` da TUI re-detecta o **TIPO da fonte** (index|listing), não os seletores (`SourcesView.js:102-116`).
4. **Issue já baixada NÃO é re-fetchada nem re-renderizada na re-run.** A guarda vem de upstream da curadoria: o walk da listagem para por `isUrlKnown` (ramo `pages` `db.js:404`, ramo `frontier` `db.js:406`) e, mesmo se um link passar, `enqueue` é `INSERT OR IGNORE` (`db.js:626-629`) — a issue com job `done` nunca gera job `roundup` de novo, então `processRoundup` (que faz o fetch com render, `crawl.js:509`) nem roda. Sem fetch, sem Playwright, sem `curateRoundup` (a fase LLM mais cara). Evidência run #2: 497 issues `roundup done` e só 3 curadorias novas.
5. **Fetch de artigo:** `fetchSmart` perfil `article` (`crawl.js:657`) — **estático primeiro**; Playwright só em HTML vazio/JS-gated/PDF (`fetch.js:612-635`). Falha de fetch → retry dentro da run (até `MAX_RETRIES=3`, `config.js:315`, `commands.js:549-551`). **Na próxima run eles re-tentam se o item for `needs_enrich`** (comandos.js:404-406 + `requeueNeedsEnrichForSource` `db.js:686-691`) — e nesta máquina o teto `ENRICH_MAX_ATTEMPTS` está **desligado (0) por instrução do usuário** (AGENTS.md; `config.js:414`), então alvos mortos re-falham **em toda run** (rápido: DNS/breaker). Evidência: run #2 repetiu **exatamente 140 `fetch fail`** e 29→4 timeouts do mesmo conjunto de alvos mortos.

---

## 1. Fluxo de listagem: onde a re-visita acontece e o que `--no-refresh` muda

### 1.1 O seed re-enfileira a listagem de cada fonte

`solar no crawlRun` (`commands.js`), para cada fonte selecionada:

- `enqueue(s.url, 'listing', ...)` — `INSERT OR IGNORE` na `frontier` (`db.js:626-629`): se a linha do seed já existe (qualquer estado), é **no-op** e retorna `false`;
- se o seed **já existia** e `--no-refresh` não foi passado, `stmts.refreshListing` **flip done/failed → pending** (`commands.js:394-399`):
  - flag lida em `commands.js:368` (`const noRefresh = flags['no-refresh'] === true;`);
  - SQL em `db.js:658-661`: `UPDATE frontier SET state='pending', retries=0 WHERE url=? AND kind='listing' AND state IN ('done','failed')` — **só seeds `listing`**, `roundup`/`article` ficam.
- Documentação do flag em `index.js:63,67`.

O job `listing` pending é reivindicado por `claimNextCurate` (`db.js:646-650`) e processado por `processListing` (`crawl.js:119-271`).

### 1.2 O fetch em si

Não existe `fetchListing`. `processListing` chama `fetchSmart(url, { profile: 'listing', aggressive, sinceDate })` (`crawl.js:195-197`), que:

1. tenta **estático** (`got`) primeiro (`fetch.js:200`, `fetch.js:618-620`);
2. renderiza com Playwright só se o estático falhar, for `PDF` (`fetch.js:612, 627-630`) ou se `looksEmpty(html)` — **< 5 links OU < 500 chars de texto** (`fetch.js:588-598`, decisão em `631-635`);
3. o custo do browser é cacheado **por host e por processo** (`needsJs`, `fetch.js:601, 633`) — não persiste entre runs.

Para listagens há ainda o scroll inteligente (perfil `listing`, `fetch.js` `RENDER_PROFILES`/`scrollRoundDecision`) e os atalhos Substack (`crawl.js:135-158`) e The Rundown (`crawl.js:166-190`), que substituem HTML por API JSON — o therundown.ai não gera página em `pages` por isso.

### 1.3 O que `--no-refresh` muda exatamente

- **Desliga a re-visita**: o seed `listing` não é flipado → `claimNextCurate` não o encontra → **0 fetches de listagem**.
- **Não desliga** o resto do re-crawl: `bumpFailedEnrichAttempts` + `requeueNeedsEnrichForSource` rodam incondicionalmente no seed (`commands.js:404-406`) — itens só-blurb continuam sendo re-enfileirados. Seeds já `pending` (run morta) também rodam mesmo com a flag.
- Em `crawlArchive`, a parada known-url independe da flag.

---

## 2. Parada de paginação — TODAS as condições

### 2.1 `crawlArchive` (`crawl.js:297-452`) — por página, na ordem:

| Ordem | Condição | Onde | Efeito |
|---|---|---|---|
| 0 | Teto de páginas: `while (pageUrl && depth < maxPages)` | `crawl.js:308` | nunca entra em página além do teto; fontes `index` usam `Infinity` (limite só via `max_index_pages`/`--max-pages`, `crawl.js:125-131`) |
| 1 | **empty/repeat-hash**: `html == null` → fetch (`309-313`); `sha256(html)` já visto → "conteúdo repetido, parando" | `crawl.js:315-320` | break |
| 2 | **sem links**: `validateLinkSelector` falhou ou 0 URLs → "sem links" | `crawl.js:322-326` | break |
| 3 | **known-url ≥ 50% / 100% ('território conhecido')**: `stmts.isUrlKnown` por link; `knownCount === dated.length` → "todos os N links já conhecidos (articles/pages/frontier), parando"; `≥ 50%` loga "território conhecido" e segue | `crawl.js:383-393` | break no 100%; log no ≥50% |
| 4 | **below-floor**: item com `d < sinceDate` não enfileira (`below++`); `below > 0` → "--since: piso atingido" + `floorHit` | `crawl.js:398-403, 423-427` | break |
| 5 | **added === 0** (incremental): `0 links novos` → "chegamos ao território já conhecido" | `crawl.js:430-433` | break (rede de segurança — o 3 já antecipa) |
| 6 | **maxPages no fim**: `depth + 1 >= maxPages` → break **antes** de `findNextPage` (evita a chamada LLM do next) | `crawl.js:434` | break |
| 7 | **no-next / next == própria página**: `findNextPage` retornou null ou a mesma URL | `crawl.js:444-447` | break |
| 8 | **orçamento**: `BUDGET_EXCEEDED` no `findNextPage` → encerra o walk com log (o já enfileirado fica) | `crawl.js:438-443` | break |

`findNextPage` (`crawl.js:454-483`), em ordem, **sem LLM sempre que possível**: `sel.next_selector` cacheado (`456-459`) → `<a rel="next">` (`461-463`) → `?page=N+1` (`465-470`) → só então `deriveNextLink` Flash, cacheando o seletor (`472-481`).

### 2.2 Fallback item-a-item (sem seletor de link confiável) — `processListing` (`crawl.js:242-270`)

Posições cobertas na habilidade, com `file:line`:

- `extractLinksItemByItem` (Flash, 1 chamada por listagem) — `crawl.js:244` (definição `llm.js:389-404`);
- **known-url**: todos os links já conhecidos → "todos os N links já conhecidos, parando" — `crawl.js:253-256`; ≥50% loga "território conhecido" — `crawl.js:257-259`;
- **below-floor** por item: `d < sinceDate` → `continue` — `crawl.js:264`;
- sem condição `added===0` explícita: o "todos conhecidos" já cobre a re-run;
- sem findNextPage: o fallback processa **só a página 1** (não pagina).

### 2.3 Atalhos Substack/Rundown

`substackArchive`/`rundownArchive` recebem `sinceDate` e param o backfill sozinhos (`crawl.js:137, 168`); `below > 0` → `floorHit` (`crawl.js:152, 183`).

### 2.4 Resposta direta: quantas páginas com `--since 2026-09-05` e tudo conhecido?

**1 página por fonte** (a primeira — fetch obrigatório da re-visita), parada na condição **known-url 100%** ("todos os N links já conhecidos (articles/pages/frontier), parando", `crawl.js:387-389`), **sem nenhuma chamada LLM** quando o spec de data está cacheado. **Zero páginas** com `--no-refresh`.

Dois poréns de custo pequeno na 1ª run com `--since` sem spec de data cacheado:

- `deriveDateSelector` (Flash, 1 por fonte) roda **antes** do check known-url — `crawl.js:341-373` (condição `sinceDate && HAS_LLM && dated.length >= 3 && !dated.some(parseDate)` em `341`; o check de conhecidos só vem em `383`). Hoje a tabela `selectors` tem **0 linhas de date_selector** (verificado no banco), então a run #2... não precisou: os fallbacks genéricos (`time[datetime]`, `[class*="date"]`, regex estrita — `selectors.js:120-145`) dataram os itens e pularam a derivação (0 eventos `dateSelector` na run #2). Se algum template não casar nos fallbacks, são ~9 chamadas Flash numa run;
- **self-healing**: seletor de link cacheado que não valida no HTML atual (layout mudou) descarta e re-deriva (Flash, `crawl.js:202-209, 212-232`).

**Evidência real (run #2, em andamento durante a auditoria):** `crawl --since 2026-09-05 --budget 0.5`:

- 8 `archive ok` (8 primeiras páginas, uma por fonte HTML); `this-week-in-rust`, `superhuman`, os 6 Cooperpress com `fetched_at` 16:32:52–16:33:55 e `pagination_depth 0`;
- `pages` ficou em **33 linhas** (mesmas URLs, upsert em `crawl.js:406-412`) — nenhuma das 25 páginas antigas do superhuman (`?page=16..26`) foi revisitada;
- 0 chamadas `linkSelector`, `nextLink` e `dateSelector` (llm_usage da run #2).

---

## 3. Seletores: cache, chave, quando a IA roda e por que a run #1 teve 315 contentSelector

### 3.1 O cache

- Tabela `selectors` com `template_sig TEXT UNIQUE` (`db.js:67-77`); colunas `link_selector/link_attribute/content_selector/next_selector/date_selector/date_attribute/date_regex/model_used/confidence` (+`date_*` via `ensureColumn`, `db.js:217-219`).
- `getCachedSelector`/`putSelector` (`selectors.js:6-26`); `putSelector` faz upsert mergindo (não apaga colunas) — `db.js:605-623`.
- **Chave** = `domainSig(url, kind)` (`util.js:83-97`):
  - artigo: `<host>:article` — 1 template de conteúdo por host;
  - listagem: `<host>:listing:<template de path>` (2 primeiros segmentos; segmentos com dígito ou >24 chars viram `*`) — separa `/issues` de `/blog/archives` no mesmo host.
- Estado pós-run #1 (verificado): 27 linhas — 8 `link_selector` de listagem, 19 `content_selector` de artigo, 1 `next_selector` (`www.superhuman.ai:listing:/archive`), 0 `date_selector`.

### 3.2 Quando a derivação por IA roda (e o threshold de cache)

| Stage | Chama quando | Validação p/ cachear | Código |
|---|---|---|---|
| `linkSelector` | sem seletor cacheado **ou** cacheado que não valida no HTML atual (self-healing) | ≥ 3 links únicos | `crawl.js:202-232`; `selectors.js:166-174` |
| `contentSelector` | Readability rendeu < 400 chars **e** não há seletor de conteúdo cacheado | ≥ 400 chars | `crawl.js:717-752`; `selectors.js:189-192` |
| `dateSelector` | `--since` ativo, ≥ 3 itens na página e **nenhum** datado pelos fallbacks | ≥ max(3, 50%) dos itens datados | `crawl.js:341-373` |
| `nextLink` | sem `next_selector` cacheado, sem `rel=next`, sem `?page=N`, e maxPages permite | (qualquer seletor devolvido é cacheado) | `crawl.js:434-482`; `llm.js:353-369` |
| `linkExtract` (fallback item-a-item) | sem seletor de link cacheado/validado | — (não cacheia) | `crawl.js:242-244`; `llm.js:389-404` |

Todas via `callJSON` com modelo/effort por stage (`config/models.json`; default flash + `xhigh`; `config.js:493-513`; ex. `deriveContentSelector` `llm.js:323-340`).

### 3.3 Numa re-run com seletores já salvos, custa 0?

**Sim — para a descoberta (listing + paginação + data), custa 0 chamadas LLM**, porque:

- `processListing` valida o `link_selector` cacheado só com Cheerio (`crawl.js:202-209`, `selectors.js:166-174`);
- a paginação usa `sel.next_selector` cacheado (`crawl.js:456-459`) e o spec de data cacheado (`crawl.js:331-336`);
- o `contentSelector` de artigo só conta quando Readability falha E não há cache — e em território conhecido **não há jobs de artigo** (ver §4), então nem chega a avaliar.

**Evidência run #2:** as 8+1 sigs de listagem com `link_selector`/`next_selector` cacheado → 0 `linkSelector`; 0 `nextLink`; 0 `dateSelector`; só 9 `contentSelector` (hosts novos dos ~3 issues acima do piso). Total de LLM de descoberta ≈ 0.

### 3.4 Por que a run #1 teve 315 `contentSelector` (e 8 `linkSelector`)?

O estado pós-restore:

1. **O `restore` NÃO repõe a tabela `selectors`** — a lista de rotinas é `restoreSourceByName/restoreArticle/restoreTags/markUrlDone/restorePage` (`restore.js:1030`), nada de selectors. Cache **vazio** no boot da run #1.
2. **O snapshot commitado não tinha `issue_url`** (`restore.js:1176-1178`, comentário em `db.js:1354-1361` e `export-web.js:87`): `restorePage` não rendeu nenhuma linha de issue; das 747 issues conhecidas no acervo, **0 eram "conhecidas"** para o walk ⇒ a 1ª coleta **re-curou ~745 issues** (eventos run #1: `curate ok` 494, `item dup` 9.107, `item saved` 1.957).
3. Os itens novos das issues re-curadas viraram jobs de artigo `needs_enrich`; os alvos cujo Readability rendeu < 400 chars dispararam `deriveContentSelector` — **1 chamada por `host:article`** (a chave do cache, `util.js:85`) — 315 hosts distintos/derivações ≈ 315 chamadas (US$ 0,3254 de `contentSelector` na `llm_usage` da run #1 — bate com o ~US$ 0,33 do contexto). `linkSelector`: 8 (6 Cooperpress + this-week-in-rust + superhuman; o 9º sig atual nasceu de re-derivação pós-validação).
4. Hoje o cache está populado (27 linhas) — a partir daqui a descoberta é cheerio-only (run #2 provou).

### 3.5 A tecla `d` da TUI (Gerenciar fontes)

`SourcesView.js:102-116`: `d` chama `onRedetect` → re-detecção do **TIPO da fonte** (index|listing, via `detect-type.js`). **Não** mexe no cache de seletores (Enter alterna o tipo, `r` ×2 remove — `SourcesView.js:95-99, 118+`).

---

## 4. Issue já baixada (`pages` done/restored): re-fetchada na re-run? **NÃO**

### 4.1 A consulta de "issue já vista"

`stmts.isUrlKnown` (`db.js:401-410`) — o ramo `pages` é o 2º:

```sql
SELECT 1 FROM articles WHERE url = ?                       -- ramo 1
UNION ALL
SELECT 1 FROM pages WHERE url = ?                          -- ramo 2: listagem/issue visitada (status done|restored)
UNION ALL
SELECT 1 FROM frontier WHERE url = ? AND state IN ('done','failed','pending','in_progress')  -- ramo 3
UNION ALL
SELECT 1 FROM articles WHERE issue_url = ?                 -- ramo 4
LIMIT 1
```

Usada no walk da listagem, **antes de enfileirar**: `crawl.js:383-393` (crawlArchive) e `crawl.js:248-259` (fallback item-a-item).

### 4.2 O que acontece quando a issue é conhecida — o que economiza

Cadeia completa na re-run:

1. A listagem é re-fetchada (1 página, §2). O walk para pelo ramo 3 (frontier `done` — as 497 issues da run #1 estão `roundup done`) ou ramo 2/4;
2. **Mesmo que um link passe**, `enqueue` é `INSERT OR IGNORE` na `frontier` (`db.js:626-629`): URL com linha (qualquer estado) → no-op;
3. `claimNextCurate` só reivindica `kind != 'article'` **pending** (`db.js:646-650`) — job `done` de roundup **nunca** re-roda;
4. Logo `processRoundup` — que faz `fetchSmart(profile:'listing')` (fetch + possível render, `crawl.js:509`) e a curadoria `curateRoundup` (a fase LLM mais cara da run, `crawl.js:529-554`) — **não roda** para issues conhecidas.

Economia por issue conhecida: 1 fetch (+1 render se JS-gated) + extração/parse + toda a curadoria por seção (Flash paralelo) + enfileiramento dos itens. Evidência run #2: 3 `curate ok` (issues novas acima de `--since` 2026-09-05), 497 issues `roundup done` intocadas; `fetch ok` 73 = 8 listagens + ~65 alvos novos.

### 4.3 Onde `pages` ganha linhas (status)

- Crawl: **só páginas de listagem** via `upsertPage` com `status 'done'` (`crawl.js:406-412`; `db.js:352-358`) — issues **não** viram linha em `pages` no caminho do crawl;
- Restore: issues/listagens via `restorePage` → `insertPageIfMissing` com `status 'restored'` (`db.js:968-973, 1350-1377`) — **apenas se o snapshot carregar `issue_url`** (`restore.js:1174-1178`);
- Ambos os status contam no ramo 2 (`db.js:404`); o `ON CONFLICT(url) DO UPDATE` do upsertPage não troca o `id`, por isso a contagem fica estável em re-runs (33 confirmado).

Estado atual do banco: 33 linhas em `pages`, todas `done`, todas de listagem (ex.: `postgresweekly.com/issues`, `www.superhuman.ai/archive?page=16..26`).

### 4.4 Limitação conhecida (documentada no código)

`articles.json` commitado hoje não tem `issue_url` ⇒ pós-restore o guard reconhecia **0 de 747 URLs de issue** e a 1ª coleta re-curou ~745 issues por IA — mitigação: `--since <recente>` nessa primeira coleta; o buraco fecha sozinho a cada crawl+deploy (`db.js:1354-1361`, `restore.js:1176-1178`, `AGENTS.md`). Isso explica o porte da run #1 (2.418 `fetch ok`, 494 curadorias) — **não** é comportamento de re-run normal.

---

## 5. Fetch de artigos: estático vs Playwright, retries e re-tentativa entre runs

### 5.1 O fetch é estático por padrão

`processArticle` → `fetchSmart(url, { profile: 'article', ... })` (`crawl.js:657`). No `fetchSmart` (`fetch.js:603-636`):

- **estático (`got`) primeiro** — `fetch.js:200, 618-620`;
- Playwright **só** se: estático falhou (`621-624`), `isPdfUrl`/content-type PDF (`612, 627-630`), ou `looksEmpty` (< 5 links OU < 500 chars; `588-598`, `631-635`), ou `needsJs[host]` do processo (`601, 614-616`);
- perfil `article` = deadline 30s, 8 rodadas de scroll, sem load-more (`config.js:485-487`).

Custo por artigo novo: 1 GET estático (barato); o browser é a exceção para hosts JS-gated — e a decisão é **re-feita a cada run** (o `needsJs` não persiste), mas `fetchStatic` tenta primeiro e o Playwright só entra quando o HTML cru é mesmo vazio.

### 5.2 Falha de fetch dentro da run

`processArticle` loga `fetch/fail` e **re-lança** (`crawl.js:658-663`). No dispatch (`commands.js:497-555`):

- não é timeout nem orçamento → `bumpRetry` até `MAX_RETRIES=3` (`commands.js:549-551`; `config.js:315`), depois `finish('failed')`;
- `claimNextArticle` ordena `retries ASC` (`db.js:640-644`) — o job falho só volta **depois** dos frescos (sem hot-loop num host quebrado);
- timeout do relógio de trabalho (`JOB_TIMEOUT_MS`=90s de fetch/render/parse; `config.js:397`, `deadline.js`): item `needs_enrich` → frontier **`done` + `needs_enrich=1`** ("enriquece depois", `commands.js:533-539`); avulso → mesmo caminho de retry/fail (`541-542`).

### 5.3 Re-tentativa na próxima run — sim, para itens só-blurb (e SEM teto nesta máquina)

No seed de cada run (`commands.js:400-410`):

- `requeueNeedsEnrichForSource(src.id, cap)` re-ativa **todo** job `article` `done|failed` cuja ficha tem `needs_enrich=1` e `enrich_attempts < cap` → `pending, retries=0` (`db.js:686-691`) — inclui os estourados por deadline na run anterior;
- `bumpFailedEnrichAttempts` conta a rodada falhada (`db.js:680-685`), e o teto por alvo `ENRICH_MAX_ATTEMPTS` (default 3, `config.js:414`) aposenta domínio morto com o blurb (fail-open);
- **NESTA MÁQUINA o teto está DESLIGADO por instrução do usuário** (`ENRICH_MAX_ATTEMPTS=0` em NC_HOME/.env — não li o arquivo, regra de segurança; fato documentado em `AGENTS.md` e confirmado pelo comportamento): com 0, o `bump` é pulado (`commands.js:404`) e o cap vira `Number.MAX_SAFE_INTEGER` (`commands.js:405`) ⇒ **alvos mortos re-falham em TODA run** (rápido: DNS/breaker), itens nunca são aposentados;
- avulso `failed` (não-curated) **não** é re-enfileirado: nenhum mecanismo reflip `failed` de artigo, e `isUrlKnown` conta `failed` como conhecido (nunca volta pela listagem).

**Evidência run #1 vs #2:** os mesmos **140 `fetch fail`** e 4–29 `job timeout` — a run #2 re-tentou exatamente os alvos mortos de `needs_enrich` da run #1. O custo da re-tentativa é só fetch/CPU (DNS/breaker rápido); **nenhum LLM** é gasto por alvo morto (a chamada LLM só viria se o fetch tivesse sucesso e o corpo falhasse na extração).

---

## 6. O que uma re-run barata (tudo conhecido + `--since`) custa, por fonte

| Etapa | Custo | Condição de zero |
|---|---|---|
| Fetch da listagem (página 1) | 1 GET estático (rede) | `--no-refresh` → 0 |
| Walk de paginação | 0 páginas além da 1 | known-url 100% (`crawl.js:387-389`) |
| `linkSelector`/`linkExtract`/`nextLink` | 0 | cache validado (Cheerio) |
| `dateSelector` | 0 (ou ~1 Flash por fonte na 1ª run sem spec, se os fallbacks genéricos falharem) | fallbacks `selectors.js:120-145` ou spec cacheado |
| Re-curadoria de issues conhecidas | 0 | frontier `roundup done` (`db.js:646-650`) |
| Re-fetch de issues conhecidas | 0 | `enqueue` no-op (`db.js:626-629`) |
| Artigos conhecidos | 0 (nem job existe) | frontier `done` |
| Itens `needs_enrich` de alvos mortos | 1 fetch falho rápido cada (sem LLM) | único custo recorrente por design (teto desligado nesta máquina) |

Custos da run #2 (parcial, em andamento): 8 fetches de listagem, 3 curadorias, 48 enriches, 64 summarizes/63 verifies/571 classify (streaming pós-save é o grosso do LLM), 140 fetch-fail de alvos mortos, `contentSelector` 9.

---

## 7. Notas de método

- Nenhuma escrita no banco; consultas `sqlite3 -readonly ~/.newsletter-crawler/crawler.db`.
- A run #2 (`crawl --since 2026-09-05 --budget 0.5`) estava **rodando** durante a auditoria — os números dela são parciais e foram usados apenas como evidência de comportamento de re-visita/parada.
- Habilidades carregadas: `fetching-and-extracting` e `persisting-and-orchestrating`.