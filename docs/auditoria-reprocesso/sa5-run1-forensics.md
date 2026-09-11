# SA-5 — Forense da run #1 (2026-09-10) e linha de base da run de validação

**Modo:** somente leitura (`sqlite3 -readonly ~/.newsletter-crawler/crawler.db`); nenhum write, nenhum comando do crawler.
**Banco:** `~/.newsletter-crawler/crawler.db` (WAL). **Snapshot de pendências:** `2026-09-11 17:03:30Z` (14:03 -03).
**Atenção:** a run #2 (crawl, `--since 2026-09-05`, budget US$ 0,50, iniciada `2026-09-11 16:32:40Z`) **estava em execução durante toda a coleta** e está consumindo pendências ao vivo — todos os números "hoje" são do snapshot acima e já mudaram (ver §7).

Contexto: 15.502 artigos restaurados do git (sem `run_id`; `extracted_at` 2026-09-10 18:03:07–18:03:17, bootstrap automático) → run #1 (`crawl --since 2026-01-01`, 18:09:32–22:42:43Z) adicionou 1.969 artigos com `run_id=1` (custo US$ 13,67). Hoje a run #2 rodou por cima.

---

## 1. Custo por stage da run #1

```sql
SELECT stage, count(*) AS chamadas, printf('%.4f', sum(cost_usd)) AS custo_total_usd,
       printf('%.5f', avg(cost_usd)) AS custo_medio_por_chamada
FROM llm_usage WHERE run_id=1 GROUP BY stage ORDER BY custo_total_usd DESC;
```

| stage | chamadas | custo_total_usd | custo_medio/chamada | % do custo |
|---|---|---|---|---|
| curate | 3.609 | 6,5331 | 0,00181 | 47,8% |
| classify | 13.879 | 3,1229 | 0,00023 | 22,8% |
| articleClean | 1.642 | 2,5519 | 0,00155 | 18,7% |
| verifyRecord | 1.578 | 0,5574 | 0,00035 | 4,1% |
| summarize | 1.578 | 0,4125 | 0,00026 | 3,0% |
| contentSelector | 315 | 0,3254 | 0,00103 | 2,4% |
| articleExtract | 431 | 0,1371 | 0,00032 | 1,0% |
| linkSelector | 8 | 0,0312 | 0,00390 | 0,2% |
| nextLink | 1 | 0,0003 | 0,00029 | ~0% |
| **Total** | **23.041** | **13,6719** | | 100% |

Totais: `SELECT printf('%.4f', sum(cost_usd)), count(*) FROM llm_usage WHERE run_id=1` → **13,6719 / 23.041**. Confere com o custo reportado da run (~US$ 13,67).

---

## 2. Colisão de conteúdo

### 2a. content_hash — run #1 vs restaurados

```sql
SELECT count(*) AS run1_com_hash_tambem_restaurado
FROM articles a1
WHERE a1.run_id=1 AND a1.content_hash IS NOT NULL
  AND EXISTS (SELECT 1 FROM articles a2 WHERE a2.run_id IS NULL AND a2.content_hash=a1.content_hash);
```

**0 (zero).** `SELECT ... count(*) ... content_hash IS NULL` → run1: 0 NULLs, restaurados: 0 NULLs (todos com hash). **Não houve reprocessamento de CONTEÚDO** — nenhum conteúdo da run #1 repetiu conteúdo já restaurado (o índice `UNIQUE content_hash` + o cheque `dup-hash` pré-enrich funcionaram; o mesmo conteúdo reaparecendo hoje vira `kept-blurb` `dup-content`, ver §3).

### 2b. Título igual (case-insensitive) × fonte diferente — amostra de 10

```sql
SELECT a1.id AS run1_id, s1.name AS fonte_run1, a1.title, s2.name AS fonte_restaurada, a2.id AS rest_id
FROM articles a1
JOIN sources s1 ON s1.id=a1.source_id
JOIN articles a2 ON lower(trim(a2.title))=lower(trim(a1.title))
JOIN sources s2 ON s2.id=a2.source_id
WHERE a1.run_id=1 AND a2.run_id IS NULL AND s1.id<>s2.id
ORDER BY a1.id LIMIT 10;
```

| run1_id | fonte_run1 | title | fonte_restaurada | rest_id |
|---|---|---|---|---|
| 15624 | JavaScript Weekly | Wordgard: A New Rich Text Editor Library from ProseMirror's Creator | Frontend Focus | 8036 |
| 15629 | JavaScript Weekly | Blocking Install Scripts is Not a Silver Bullet | Node Weekly | 177 |
| 15631 | JavaScript Weekly | Benchmarking 5 WebSocket Servers for Node.js | Node Weekly | 14300 |
| 15651 | JavaScript Weekly | Vercel vs Netlify vs Cloudflare: Serverless Cold Starts Compared | Node Weekly | 7300 |
| 15970 | React Status | Geist Pixel | JavaScript Weekly / Node Weekly | 341 / 7703 / 14312 |
| 16640 | This Week in Rust | A Gopher Meets a Crab | Golang Weekly | 1989 |
| 16951 | Frontend Focus | Cropper.js 2.2 | JavaScript Weekly | 13734 |
| 17006 | Frontend Focus | Measuring SVG Rendering Time with Node.js | Node Weekly | 14896 |

Total de run-1 com título duplicado em restaurado (qualquer fonte):

```sql
SELECT count(DISTINCT a1.id) FROM articles a1
WHERE a1.run_id=1 AND EXISTS (SELECT 1 FROM articles a2
  WHERE a2.run_id IS NULL AND lower(trim(a2.title))=lower(trim(a1.title)));
```

→ **272 artigos da run #1 têm o mesmo título de um artigo restaurado** — em geral o MESMO lançamento coberto por newsletters diferentes (conteúdo legítimo, hashes distintos). É "colisão de título", não reprocessamento de conteúdo.

---

## 3. Eventos da run #1 por stage/status × llm_usage

```sql
SELECT stage, status, count(*) AS n FROM events WHERE run_id=1 GROUP BY stage, status ORDER BY stage, status;
```

| stage | status | n | stage | status | n |
|---|---|---|---|---|---|
| archive | ok | 33 | fetch | fail | 140 |
| clean | fail | 1 | fetch | ok | 2.418 (494 = páginas de issue, 1.924 = alvos de artigo) |
| clean | ok | 1.471 | item | dup | 9.107 |
| clean | reject | 154 | item | saved | 1.957 |
| curate | coverage | 494 | item | skipped | 1.251 |
| curate | ok | 494 | job | timeout | 29 |
| enrich | kept-blurb | 353 | save | ok | 12 |
| enrich | ok | 1.537 | verify | junk/suspect/ok | 125 / 852 / 595 |

Total de eventos: 21.023. Nenhum evento `stage='article'` na run #1 (tudo veio de issues curadas; avulsos só os 12 `save ok`).

### 3a. articleClean: 1.642 chamadas vs 1.471 ok + 154 reject + 1 fail = 1.626 → **16 a mais**

```sql
SELECT stage, count(*) FROM llm_usage WHERE run_id=1 AND stage='articleClean';
SELECT stage, status, count(*) FROM events WHERE run_id=1 AND stage='clean' GROUP BY status;
```

O evento `clean` é gravado logo após cada chamada bem-sucedida (`crawl.js:833/838/842`); os caminhos que NÃO gravam evento são o rethrow por abort (job/timeout/`AbortSignal`) e `BUDGET_EXCEEDED` (`crawl.js:848`). As 16 = chamadas de limpeza que não completaram o ciclo de evento (abort/erro no meio, provavelmente associadas aos 29 `job timeout`/fim de run). **~1% do volume — ruído, não reprocessamento significativo.** Os 29 timeouts têm `detail.phases` só fetch/parse (ex.: `{"phases":{"fetch":155,"parse":47},"expired":true,"abortReason":"hard-cap"}`) — o relógio estourou em fetch/render, não na fase LLM.

### 3b. articleExtract: 431 vs enrich ok 1.537 — por que a diferença?

`articleExtract` é o **fallback LLM** (extração direta por IA) — só é chamado quando o Readability falha (`textContent < 400 chars`) e não há `contentSelector` válido (`crawl.js:724-769`). Decomposição real por método (eventos):

```sql
SELECT json_extract(detail,'$.method') AS method, count(*) AS n
FROM events WHERE run_id=1 AND stage='enrich' AND status='ok' GROUP BY method;
```

| método do enrich ok | n |
|---|---|
| readability (sem LLM) | 1.355 |
| llm (articleExtract) | 149 |
| content-selector | 33 |
| **total enrich ok** | **1.537** |

Então: **1.355 dos 1.537 enriches usaram Readability gratuito; 149 usaram o fallback LLM; 33 usaram seletor derivado** (`contentSelector` 315 chamadas = derivação por domínio, cacheada). As **431 chamadas de articleExtract = 149 (enrich ok) + ~282 tentativas em alvos que não renderam** — os 353 `kept-blurb` por motivo:

```sql
SELECT json_extract(detail,'$.reason') AS reason, count(*) AS n
FROM events WHERE run_id=1 AND stage='enrich' AND status='kept-blurb' GROUP BY reason ORDER BY n DESC;
```

thin-content 171 · error-page 88 · dup-content 77 · blocked-page 10 · json-page 4 · pdf-target 3 (= 353 ✓). Os `dup-content` (77) e `error-page` (88) e `thin-content` (171) passaram pela extração (Readability ou fallback LLM) antes de serem descartados; os 3 `pdf-target` nem extraíram. Logo: **a "diferença" articleExtract × enrich é arquitetura (fallback só), não trabalho repetido.**

### 3c. Onde está o trabalho REPETIDO de verdade (eventos)

1. **`item dup` 9.107** — a curadoria de cada issue re-extrai por IA TODOS os itens (incluindo os já conhecidos) e só depois deduplica no INSERT (`curate.js:353`). Cada um dos 494 issues re-curou ~18 itens já existentes (do acervo restaurado/da própria run). **O custo está nas 3.609 chamadas de curate (§6): ~9.107 dos itens curados eram dups com o acervo.**
2. **`item skipped` 1.251** — filtros determinísticos (sponsors/jobs/secundários); sem LLM.
3. **`fetch fail` 140 + `job timeout` 29** — alvos que não renderam; deixam `needs_enrich=1` e são **re-enfileirados na próxima run** (e foram: a run #2 já re-fetcheou 28 URLs da run #1 hoje — eventos run2 `fetch ok` × run1 = 28, `enrich ok` = 25, `kept-blurb` = 2).
4. **`kept-blurb` 353** — 77 `dup-content` = alvo cujo corpo era byte-a-byte igual a um artigo já salvo (**conteúdo custou clean + fetch + extract e foi descartado**); os demais são alvos mortos/rasos (fail-open correto).
5. **verify sobre restaurados: 28** (ver §5) — reprocessamento real do acervo restaurado.

---

## 4. Classify: 13.879 chamadas — e a hipótese "1.969 × 7" NÃO confere

A contagem real de facetas é **9 por artigo** (2 core no modelo base Pro/high: `domain`, `topic-technology`; 7 em Flash/medium — `taxonomy.js getFacets()` + `config/models.json` `classify:<faceta>`). 1.969 × 9 = 17.721 ≠ 13.879. A decomposição correta:

```sql
SELECT count(*) FROM llm_usage WHERE run_id=1 AND stage='classify';                -- 13.879
SELECT count(*) FROM classifications c JOIN articles a ON a.id=c.article_id
  WHERE a.run_id=1;                                                                -- 1.561 (hoje; 25 feitas HOJE pela run #2)
SELECT count(*) FROM classifications c JOIN articles a ON a.id=c.article_id
  WHERE a.run_id=1 AND c.classified_at >= '2026-09-11';                            -- 25 (reprocessamento de hoje)
```

- Run #1 classificou **1.536 artigos** (1.561 − 25 de hoje) × 9 facetas = **13.824**; sobram **55 chamadas extras (~0,4% = retries de parse/escalação)** → 13.879. **433 artigos da run #1 ficaram sem classificação no fim da run** (1.969 − 1.536); 408 continuam pendentes hoje, 25 já consumidos pela run #2.
- **Nenhum artigo restaurado foi classificado na run #1**:
  ```sql
  SELECT count(*) FROM classifications c JOIN articles a ON a.id=c.article_id
  WHERE a.run_id IS NULL AND c.model_used != 'restore';      -- → 0
  ```
  Os 15.252 restaurados com classificação vieram do git (`model_used='restore'`); 250 restaurados seguem sem classificação e o sweep (NULL-only, `listArticlesNeedingClassification`) os teria pego — **não pegou porque a run terminou no meio do sweep** (ver §5).
- Contagem por artigo e facetas completas (lógica real: `classifications` 1 linha/artigo; facetas em `article_tags`):

```sql
SELECT c.status, count(*) FROM classifications c JOIN articles a ON a.id=c.article_id
  WHERE a.run_id=1 GROUP BY c.status;
SELECT CASE WHEN f.nfacetas=9 THEN '9=todas' ELSE printf('%d', f.nfacetas) END AS facetas, count(*)
FROM (SELECT article_id, count(DISTINCT facet) nfacetas FROM article_tags GROUP BY article_id) f
JOIN articles a ON a.id=f.article_id WHERE a.run_id=1 GROUP BY f.nfacetas;
```

| status `classifications` (run 1) | artigos | facetas com tag (run 1) | artigos |
|---|---|---|---|
| done | 1.280 | 9 (todas) | 11 |
| partial | 281 | 8 | 91 |
| | | 7 | 228 |
| **total classificados** | **1.561** | 6 | 614 |
| | | 5 | 398 |
| | | ≤4 | 219 |

`done` = 9 facetas responderam (sem falha de rede e sem obrigatória vazia); `partial` = alguma faceta falhou ou obrigatória veio vazia. **Só 11 artigos têm tag nas 9 facetas** — facetas de vocabulário esparso (ex.: `trending-emerging`, `difficulty`) naturalmente vêm vazias. Zero artigos classificados sem nenhuma tag (todos têm ≥1).

---

## 5. Verify/summarize: 1.578 ≈ 1.572 + 6 — e os 28 verify em restaurados

```sql
SELECT stage, count(*) FROM llm_usage WHERE run_id=1 AND stage IN ('verifyRecord','summarize');  -- 1.578 / 1.578
SELECT stage, status, count(*) FROM events WHERE run_id=1 AND stage='verify' GROUP BY status;     -- 595/852/125 = 1.572
```

- **1.578 chamadas de verifyRecord → 1.572 eventos de verify** (595 ok + 852 suspect + 125 junk). **+6 = chamadas que falharam/saltaram sem gravar evento** (verifyPending faz catch e só loga no sucesso; `verify.js:107-113`) — o veredito não foi persistido e a ficha voltou à fila NULL (reprocessamento trivial, ~0,4%).
- **28 eventos de verify da run #1 caíram em artigos RESTAURADOS** (⊂ 231 restaurados com `verify_status` NULL):
  ```sql
  SELECT e.status, count(*) FROM events e JOIN articles a ON a.url=e.url
  WHERE e.run_id=1 AND e.stage='verify' AND a.run_id IS NULL GROUP BY e.status;   -- junk 1 · ok 16 · suspect 11
  ```
  Timestamps: 2 às 21:38:05 e 26 às **22:42:43 — o segundo exato de `runs.finished_at`**: o sweep final de verify (NULL-only, SEM filtro de run — `listArticlesToVerify`) estava no meio quando a run terminou; o último flush gravou 26 vereditos em restaurados e parou. **Reprocessamento real e comprovado: 28 fichas restauradas re-verificadas (custo ~28 × US$ 0,00035 ≈ US$ 0,01) + 203 restaurados ficaram para depois.**
- **Summarize não grava evento por artigo** (sem `logEvent` em `summarize.js`) → não dá para trace por URL. Evidência indireta: restaurados sem summary permaneceram **229 inalterados** entre 13:40 e o snapshot (14:03) e 0 classificações em restaurados → o sweep de summarize/classify da run #1 **não consumiu restaurados** (só o verify alcançou 28 antes do corte). Resumos da run #1: 1.578 chamadas → ~1.537 persistidos na run #1 (1.564 hoje − ~27 feitos hoje pela run #2), ~41 chamadas perdidas por falha (sem persistir; NULL permanece e a ficha é re-selecionada).
- Estado das colunas (snapshot 17:03:30Z): run1 → `verify_status` NULL 400 (582 ok / 861 suspect / 126 junk); `summary_pt` NULL 405 (1.564 ok). 1.544 eventos verify em artigos da run #1 + 25 vereditos aplicados HOJE pela run #2 (eventos run2 verify × run1: 3 ok + 20 suspect + 2 junk) = 1.569 ✓ — a conta fecha.

**Veredito do §5: a diferença +6 é ruído (falhas sem evento); o achado real é o verify do sweep varrendo o acervo restaurado (28 na run #1; 153 já hoje na run #2, ver §7).**

---

## 6. issue_url

```sql
SELECT 'run1 com issue_url', count(*) FROM articles WHERE run_id=1 AND issue_url IS NOT NULL;   -- 1.969
SELECT 'restaurados com issue_url', count(*) FROM articles WHERE run_id IS NULL AND issue_url IS NOT NULL;  -- 0
```

**Todos os 1.969 artigos da run #1 têm `issue_url`** (1.957 curados + 12 `save ok` herdaram `discovered_from`); **0 dos 15.502 restaurados têm** (artefato do exportador antigo — limitação conhecida). Distribuição por fonte:

```sql
SELECT s.name AS fonte, count(DISTINCT a.issue_url) AS issues_unicas, count(*) AS artigos
FROM articles a JOIN sources s ON s.id=a.source_id
WHERE a.run_id=1 AND a.issue_url IS NOT NULL GROUP BY s.name ORDER BY issues_unicas DESC;
```

| fonte | issues únicas | artigos |
|---|---|---|
| Superhuman | 174 | 661 |
| This Week in Rust | 31 | 853 |
| Frontend Focus | 32 | 124 |
| Golang Weekly | 22 | 71 |
| React Status | 17 | 43 |
| JavaScript Weekly | 15 | 76 |
| Postgres Weekly | 14 | 64 |
| Node Weekly | 13 | 65 |
| The Rundown | 1 | 12 |
| **total** | **319 issues distintas** | **1.969 artigos** (6,2 artigos/issue) |

Curadoria × chamadas: **494 issues curadas** (`curate ok`) → 3.609 chamadas de curate = 7,31 chamadas/issue. Decomposição:

```sql
SELECT SUM(json_extract(detail,'$.sections')) FROM events WHERE run_id=1 AND stage='curate' AND status='ok';  -- 3.068 seções
SELECT count(*) FROM events WHERE run_id=1 AND stage='curate' AND status='coverage'
  AND json_array_length(json_extract(detail,'$.leftovers'))>0;                                               -- 494 coberturas com LLM
```

- 3.068 (agentes de seção, 6,2 seções/issue em média) + 494 (passe de cobertura, 1/issue) + 47 (partes extra de issues longas) = **3.609** ✓.
- Das 494 issues, **176 renderam zero itens novos** (`saved=0` — só dups/skips) → 318 curadas com ≥1 item novo (≈ 11,3 chamadas de curate por issue que salvou algo). **O peso morto: 176 issues inteiramente re-cururadas por IA sem salvar nada + 9.107 itens dup dentro das 494.**

---

## 7. Pendências hoje + custo estimado de `finish`

Snapshot consistente (transação de leitura única) em `2026-09-11 17:03:30Z`:

```sql
BEGIN;
SELECT CASE WHEN a.run_id=1 THEN 'run1' WHEN a.run_id IS NULL THEN 'restaurados' ELSE 'run2' END AS grupo,
       count(*) AS total,
       sum(CASE WHEN a.verify_status IS NULL THEN 1 ELSE 0 END) AS verify_pendente,
       sum(CASE WHEN a.summary_pt IS NULL THEN 1 ELSE 0 END) AS summary_pendente,
       sum(CASE WHEN c.article_id IS NULL THEN 1 ELSE 0 END) AS sem_classificacao,
       sum(CASE WHEN a.needs_enrich=1 THEN 1 ELSE 0 END) AS needs_enrich
FROM articles a LEFT JOIN classifications c ON c.article_id=a.id
GROUP BY grupo ORDER BY grupo;
COMMIT;
```

| grupo | total | verify NULL | summary NULL | sem classificação | needs_enrich=1 |
|---|---|---|---|---|---|
| restaurados | 15.502 | **50** | **229** | **250** | 0 |
| run1 | 1.969 | **400** | **405** | **408** | **40** |
| run2 | 44 | 3 | 3 | 3 | 0 |
| **total** | **17.515** | **453** | **637** | **661** | **40** |

> **As colunas NULL já estão sendo consumidas pela run #2 AO VIVO** (sweeps NULL-only sem filtro de run): entre 13:40 e o snapshot, os restaurados passaram de 203 → 50 verify NULL (153 verificados: eventos run2 × restaurados = 81 ok + 68 suspect + 4 junk, dos quais ~137 por heurísticas grátis — `isBlockedPage`/`startsWithNavMenu` — e ~16 por LLM; 66 chamadas verifyRecord na run #2 até o momento) e a run #2 re-fetcheou 28 URLs da run #1 (25 re-enriquecidas). **A linha de base REAL para a run de validação é: a run #2 já está reprocessando as pendências da run #1 e dos restaurados neste exato momento.**

Os 40 `needs_enrich=1` (run #1) **não entram no `finish`** (finish = verify+classify+summarize; enrich é do crawl) — são alvos re-enfileirados (fetch+clean+extract no próximo crawl, custo variável ~US$ 0,002–0,004/alvo + clean).

### Custo estimado do `finish` hoje

`avgUsageByStage` do banco (`db.js:853` — AVG real sobre `cost_usd>0`, global) + médias só da run #1:

```sql
SELECT stage, printf('%.5f', avg(cost_usd)) AS avg, count(*) FROM llm_usage WHERE stage=? AND cost_usd>0;
-- global:  verifyRecord 0,00034 (n=1792) · summarize 0,00026 (n=1645) · classify 0,00023 (n=14469)
-- run #1:  verifyRecord 0,00035 (n=1573) · summarize 0,00026 (n=1577) · classify 0,00023 (n=13875)
```

| sweep | pendentes | chamadas | custo estimado |
|---|---|---|---|
| verify | 453 artigos × 1 | 453 (parte sai grátis por heurística) | ~US$ 0,15 |
| summarize | 637 artigos × 1 | 637 | ~US$ 0,17 |
| classify | 661 artigos × 9 facetas | 5.949 (+~0,4% retries) | ~US$ 1,37 |
| **total finish** | | **~7.039 chamadas** | **≈ US$ 1,69** |

Cálculo: 453×0,00034 + 637×0,00026 + 5.949×0,00023 = 0,154 + 0,166 + 1,368 = **US$ 1,69** (ou US$ 1,70 com as médias da run #1: 453×0,00035 + 637×0,00026 + 5.949×0,00023). Caveats: (a) a run #2 consome essas pendências agora — o custo real do finish será menor; (b) classificar é o único item relevante (81% do custo estimado); (c) o finish NÃO cobre os 40 `needs_enrich` (ficam para crawl) nem o `reclean` dos ~922 suspect (run1 861 + restaurados 4.596 — passe Pro, outro comando).

---

## Conclusões (prova de reprocessamento na run #1)

1. **Conteúdo: NENHUM** — 0 colisões de `content_hash` (§2a). 272 títulos repetidos são cross-newsletter legítimo.
2. **Curadoria: o maior reprocessamento** — 494 issues re-curadas por IA (3.609 chamadas, US$ 6,53 = 47,8% da run) para 9.107 itens `dup` + 176 issues sem item novo; ~95% dos itens vistos já existiam.
3. **Verify final varreu o acervo restaurado** — 28 fichas restauradas re-verificadas (eventos às 22:42:43 = flush do fim da run); o sweep estava incompleto quando a run terminou: 433 sem classificação, ~432 sem summary, ~425 sem verify no fim (agora 408/405/400).
4. **Fallbacks e falhas** — 140 fetch fail + 29 timeout + 77 dup-content reenfileiram/descartam trabalho; 16 articleClean e 6 verifyRecord sem evento (ruído ~0,4–1%).
5. **Run #2 (hoje) já reprocessa as pendências** — 153 restaurados re-verificados (137 grátis), 25 vereditos/25 classificações/27 resumos em artigos da run #1, 28 re-enriches — a linha de base da validação.
6. **`finish` hoje: ~7.039 chamadas ≈ US$ 1,69** (verify US$ 0,15 + summarize US$ 0,17 + classify US$ 1,37), sujeito a redução pelas pendências já consumidas pela run #2.