# SA3 — Sweeps pós-save (verify/classify/summarize): delta-only de verdade?

**Agente:** análise de código + SQL READ-ONLY (nada foi escrito no banco; `sqlite3 -readonly`).
**Banco:** `~/.newsletter-crawler/crawler.db`. **Data da medição:** 2026-09-11.
**Atenção:** havia um **run #2 de crawl EM ANDAMENTO** (`runs.id=2`, `status='running'`,
`{"since":"2026-09-05","budget":"0.5"}`) durante toda a coleta — o total de artigos cresceu
17.473 → 17.515 entre as medições. Os números de `content_source='restore'`, porém, ficaram
**idênticos em todas as medições** (203/229/250) — os restaurados não são tocados pelo run #2.

---

## Veredito curto

**Sim: verify, classify e summarize são delta-only de verdade.** As três varreduras re-selecionam
exclusivamente por **coluna NULL / linha ausente** (nunca por data, nunca por `content_source`,
nunca "tudo de novo"), e o streaming pós-save só roda para a ficha **recém-salva/enriquecida** da
run atual. Os 15.502 restaurados **não** são re-processados: o restore carrega `verify_status`,
`title_pt`/`summary_pt` e tags do snapshot, e `restoreTags(..., {markClassified:true})` grava a
linha em `classifications` (status `'restored'`) — a seleção por `LEFT JOIN ... IS NULL` não os
pega. O único jeito de re-processar o acervo INTEIRO é `finish --force` (opt-in explícito:
exige `--yes` + backup). Hoje existem ~670 artigos pendentes reais (dos quais ~400 são itens
kept-blurb da run #1 que **nunca passaram pelo streaming** — não é violação de delta).

---

## Q1 — Seleção de pendentes (o que cada sweep re-seleciona)

| Sweep | Stmt (src/db.js) | Predicado | Comentário |
|---|---|---|---|
| verify | `listArticlesToVerify` (db.js:427-430) | `WHERE verify_status IS NULL ORDER BY id LIMIT ?` | Nenhum filtro de data/fonte/run |
| verify (force) | `listArticlesForReverify` (db.js:431-433) | `SELECT ... FROM articles ORDER BY id LIMIT ?` | **SEM WHERE** — acervo inteiro |
| summarize | `listArticlesNeedingSummary` (db.js:451-453) | `WHERE summary_pt IS NULL ORDER BY id LIMIT ?` | `title_pt` é gravado junto (`setSummary`) |
| summarize (force) | `listArticlesForResummarize` (db.js:454-456) | `SELECT ... FROM articles ORDER BY id LIMIT ?` | **SEM WHERE** |
| classify | `listArticlesNeedingClassification` (db.js:821-828) | `LEFT JOIN classifications c ... WHERE c.article_id IS NULL` | Seleciona por **linha ausente** na tabela de classificação, não por coluna |
| classify (force) | `listArticlesForReclassify` (db.js:829-831) | `SELECT id, url, title, content FROM articles ORDER BY id LIMIT ?` | **SEM WHERE** |

- **Sim, as queries re-selecionam por coluna NULL / linha ausente** — e **não filtram por
  `content_source`**: um artigo restaurado com `verify_status IS NULL` (ou sem linha em
  `classifications`) **é** elegível e **seria** re-processado. A proteção dos restaurados vem do
  restore (Q5), não da query.
- **Força:** `verifyPending({force})` (verify.js:79-81), `classifyPending({force})`
  (classify.js:181-183), `summarizePending({force})` (summarize.js:29-31) alternam para os stmts
  SEM WHERE (`listArticlesForReverify`/`ForReclassify`/`ForResummarize`) — que pegam **tudo**,
  inclusive os já processados.
- **Pontos de chamada dos sweeps:**
  - Pós-crawl: `crawlRun` em `src/commands.js:639-648` — `verifyPending({})`,
    `classifyPending({})`, `summarizePending({})` (todos **sem force**), em paralelo, na lane
    llm-only; gate: `VERIFY_AFTER_CRAWL`/`CLASSIFY_AFTER_CRAWL`/`SUMMARIZE_AFTER_CRAWL`
    (config.js:360, 593, 600; default ON) `&& HAS_LLM && flags['no-verify'|'no-classify'|'no-summarize'] !== true && !shouldStop()`.
  - `finish`: `cmdFinish` em `src/commands.js:1271-1279` (mesmos 3 sweeps, `force` do flag,
    perfil llm-only).
  - `reextract` também chama `stmts.listArticlesForReverify` (reextract.js:286) — mas é outro
    comando (re-extração do corpo), não um sweep do pipeline.

## Q2 — Medição real no banco (read-only)

### Pendentes por passe, hoje (snapshot consistente, single transaction — 2026-09-11)

| Métrica | Total | restore | target | aggregator |
|---|---|---|---|---|
| artigos no total | **17.515** | 15.502 | 1.6xx* | ~4xx* |
| `verify_status IS NULL` | **609** | **203** | 10–19* | 396–409* |
| `summary_pt IS NULL` | **640** | **229** | 10–17* | 400–413* |
| sem linha em `classifications` | **667** | **250** | 13–27* | 400–413* |
| sem linha em `article_tags` | = idem | = idem | = idem | = idem |
| **união (≥1 passe pendente)** | **670** | **251** | 15–19* | **400** |

\* faixa porque o run #2 (em andamento) insere/salva/processa artigos novos durante a medição.
Os números de **restore são fixos** (203/229/250) — o crawl não os toca.

### Se `finish`/sweep rodasse agora (sem `--force`)

- verify re-processaria **~609** artigos (1 chamada Flash/heurística cada),
- summarize **~640** (1 chamada cada),
- classify **~667** (≈9 facetas × 667 ≈ **6.000 chamadas** de classify),
- total de artigos distintos na fila IA: **~670 de 17.515 (3,8%)** — não os 17,5 mil.

### Por que existem esses pendentes (decomposição)

1. **~400 kept-blurb (aggregator)** — itens curados cujo alvo não rendeu corpo:
   `keepAggregatorVersion` (crawl.js:607-613) **não devolve `verifyUrl`**, então eles **nunca
   passam pelo streaming** pós-save. Evidências da run #1 (2026-09-10, `args={"since":"2026-01-01"}`,
   sem `--no-*`, sem budget): `llm_usage` tem verifyRecord 1.578 / summarize 1.578 /
   classify 13.879 (≈1.542 artigos × 9) — exatamente só os ~1.572-1.578 artigos com corpo
   (target). **O sweep pós-crawl do fim da run #1 não completou**: há apenas **4** eventos
   `verify` em URLs aggregator (run_id=1) e a última chamada LLM da run tem o mesmo timestamp do
   `finished_at` (22:42:43) — indício de sweep iniciado e interrompido junto do encerramento da
   run. Esses ~400 itens ficaram pendentes desde então (o run #2, se terminar normalmente, os
   varre no fim).
2. **251 restaurados** — só o que o snapshot não carregava: 203 sem `verify_status` no JSON
   commitado, 229 sem `summary_pt`/`title_pt`, 250 sem tags nenhuma (ver Q5). 1,6% do acervo
   restaurado; não é re-processamento do todo.
3. **~15-19 target** — sobras de enriquecimento/streaming do run #1 e dos 30-50 artigos novos do
   run #2 ainda em voo.

### Run #1 × run #2 (contexto confirmado)

```
runs: id=1 crawl 2026-09-10 18:09 → 22:42  new_count=1969  args={"since":"2026-01-01"}  done
      id=2 crawl 2026-09-11 16:32 → (running)            args={"since":"2026-09-05","budget":"0.5"}
articles.run_id: 1 → 1.974 (1.574 target + 400 aggregator, aprox.); 2 → ~40 (crescendo);
                 NULL → 15.502 (restore — o snapshot NÃO exporta run_id, ver Q6)
llm_usage run 1: classify 13.879 / curate 3.609 / articleClean 1.642 / verifyRecord 1.578 /
                 summarize 1.578 / articleExtract 431 — confirma o enunciado.
classifications.status: restore → 'restored' 15.252; target → done 1.302 + partial 283;
                        aggregator → nenhuma linha (0).
```

## Q3 — Streaming pós-save (`streamPostSave`)

Onde e quando roda (src/commands.js):
- **Definição**: commands.js:455-489. Guarda por etapa: `VERIFY_STREAMING && a.verify_status == null`
  (459), `SUMMARIZE_STREAMING && a.summary_pt == null` (469), `CLASSIFY_STREAMING &&
  !stmts.getClassification.get(a.id)` (479) — só processa o que ainda está pendente, e em
  paralelo na lane llm (`streaming` set, fora da capacity).
- **Único ponto de chamada**: commands.js:511 — `if (res?.verifyUrl) streamPostSave(res.verifyUrl)`,
  dentro do dispatch de um job, **apenas quando `processJob` devolve `verifyUrl`**:
  - `processArticle` devolve `{verifyUrl}` **só** no enriquecimento com sucesso (crawl.js:940) e
    no **save novo** (crawl.js:964). (Fontes index: o item curado salvo com blurb também chega
    aqui via enriquecimento; a curadoria em si não emite verifyUrl.)
  - **Dup NÃO passa pelo streaming**: artigo já existente por URL sai cedo em crawl.js:644-647;
  dup por URL canônica pós-redirect em crawl.js:680-684; dup por `content_hash` em crawl.js:909-915
  — todos `return` sem `verifyUrl`. E `keepAggregatorVersion` (crawl.js:607-613) também não
  devolve `verifyUrl` (é por isso que kept-blurb fica fora do streaming).
  - Mesmo se disparado sobre ficha antiga, os guards de pendência (459/469/479) impedem trabalho
    repetido.

**Conclusão Q3: o streaming roda só para a ficha recém-salva/enriquecida da run atual; um artigo
já salvo que re-aparece (dup) não é re-streamado.**

## Q4 — Sweeps de rede de segurança

- `verifyPending` (verify.js:77-124) — `listArticlesToVerify`: `verify_status IS NULL`. Só NULL.
- `classifyPending` (classify.js:179-241) — `listArticlesNeedingClassification`: sem linha em
  `classifications`. Só ausência.
- `summarizePending` (summarize.js:27-69) — `listArticlesNeedingSummary`: `summary_pt IS NULL`.
  Só NULL.
- Chamados em: pós-crawl (commands.js:640-648) e `finish` (commands.js:1271-1279).
- **Nenhum sweep varre tudo sem `force`.** `force` = `finish --force` (ou chamadas diretas com
  `force:true`) → stmts SEM WHERE (re-selecionam o acervo inteiro, com ou sem dados), e no
  caminho do classify **apaga as tags existentes** (`deleteTagsForArticle`, db.js:804) antes de
  regravar.
- `recleanSuspects` (verify.js:132-188) seleciona só `verify_status='suspect'` (db.js:435-438) —
  subconjunto, não varredura total.
- Nenhum sweep filtra por data (diferente do crawl): a elegibilidade é integralmente
  NULL/ausência.

## Q5 — Restore: os restaurados nascem "pendentes"?

`restoreArticle` (src/db.js:1183-1225) — INSERT OR IGNORE:
- Carrega do snapshot **quando presente**: `title_pt`, `summary_pt` (1204-1205), `verify_status`,
  `verify_notes` (1217-1218), `kind`, `issue_url`, `section`, `blurb`, `run_id`;
- **NULL quando ausente** (fallback explícito `?? null`);
- fixo: `content_source='restore'`, `cleaned=1`, `needs_enrich=0` (1214-1216).

`restoreFromGit` (src/restore.js:1048+) repassa `rec.title_pt/summary_pt/verify_status/verify_notes`
(1142-1143, 1153-1154). `restoreTags` (db.js:1280-1320+):
- insere `article_tags` (aditivo, INSERT OR IGNORE);
- **`markClassified: true` é o default** (restore.js:1057) e grava linha em `classifications`
  com `status='restored'`, `model_used='restore'` (db.js:1299-1314) — **só quando o registro tem
  tags** (`hasTags(rec.tags)`, restore.js:1163): artigo sem tag nenhuma no snapshot nunca foi
  classificado, então NÃO ganha a linha (senão ficaria fora do sweep para sempre).

**Conclusão Q5:** restaurados **não** nascem pendentes quando o snapshot tem o campo; nascem
pendentes **só no que o snapshot não carrega** — medido: 203 sem verify, 229 sem resumo,
250 sem classificação (1,3–1,6% dos 15.502). Os 15.252 com tags têm linha `classifications`
(status `'restored'`) e **não** são re-selecionados por `listArticlesNeedingClassification`.
`run_id` dos restaurados = NULL (o export não o grava; db.js:586-594).

## Q6 — Escopo de busca + `finish --force`

- `maxArticleRunId = SELECT MAX(run_id) FROM articles` (db.js:779) — **âncora correta**:
  search/verify/web-search abrem runs sem setar `articles.run_id` (comentário db.js:777-779).
- `getSearchScope` (commands.js:272-280): `latest = maxArticleRunId`; `all = flags.all || latest == null`;
  `{all, runId, count(countArticlesByRun)}`. `cmdSearch` repassa `all/runId` ao motor
  (commands.js:1491, 1502-1506).
- **Run com 0 artigos novos não mexe no escopo**: `MAX(articles.run_id)` permanece o da última
  run que trouxe artigos; a busca "última run" **re-varre o MESMO conjunto** de antes (mesma
  contagem, mesmo guard de custo). Não zera, não cresce — é estável por construção. (Hoje
  `maxArticleRunId = 2`, do run #2 em andamento; se ele terminar com 0 artigos, a âncora
  continua 2, e o run #1… na verdade o run #1 tem artigos run_id=1 — a âncora nunca "anda para
  trás".) Com banco vazio (`MAX` = NULL) → `all=true`, varre o acervo.
- Restaurados têm `run_id=NULL` → ficam **fora** do escopo "última run" (só entram com `--all`).
- **`finish --force` é opt-in, confirmado**: exige `--yes` + backup antes
  (`backupBeforeDestructive('finish-force')`, commands.js:1246-1268), com aviso de que
  re-processa o acervo INTEIRO e **apaga** tags/resumos/vereditos já gravados; sem `--force` o
  finish só completa pendentes (commands.js:1239-1255). Nada no crawl chama `force` (pós-crawl
  usa sempre `{}`).

---

## Conclusão

| Pergunta | Resposta |
|---|---|
| Sweeps são delta-only? | **Sim** — NULL/ausência apenas (Q1), incluindo finish sem `--force` |
| Algum sweep varre tudo? | **Só com `force`** (`finish --force --yes`, com backup) — nenhum caminho automático |
| Stream pós-save re-processa dup? | **Não** — só save/enrich da run atual (Q3) |
| Restaurados re-processados? | **Não em massa** — 203/229/250 (de 15.502) só porque o snapshot não tinha o campo/tags (Q5) |
| Se finish rodasse agora? | verify ~609 · summarize ~640 · classify ~667 (≈6.000 chamadas) · união **~670** de 17.515 |
| Busca pós-run-vazia? | Mesmo escopo de antes (âncora `MAX(articles.run_id)`) — re-varre o mesmo delta (Q6) |

**Caveats honestos:** (1) os ~400 kept-blurb da run #1 ficaram pendentes porque o sweep do fim da
run #1 não completou (indício: 4 eventos verify em URLs aggregator + última chamada LLM no mesmo
segundo do `finished_at`) — o run #2 em andamento deve absorvê-los no sweep pós-crawl (ou via
`ncrawl finish`); (2) `finish --force` re-processa o acervo INTEIRO e DESTRÓI o
classificado/resumo/veredito anterior no meio do caminho se interrompido — é a única
"re-run que re-processa", e é deliberada e protegida.