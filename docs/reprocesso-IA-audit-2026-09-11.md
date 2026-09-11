# Auditoria de Reprocessamento por IA — crawler em data já coberta (2026-09-11)

**Escopo aprovado:** âncora `--since 2026-09-05` (janela de 1 dia, 11 fontes), teto `--budget 0.5`, entrega = diagnóstico completo + correções.
**Banco:** `~/.newsletter-crawler/crawler.db` (17.471 artigos antes da validação; 15.502 restaurados do git, 1.969 da run #1).
**Evidência:** run de validação real (#2) + forense SQL + análise estática com `file:line` (relatórios detalhados em `docs/auditoria-reprocesso/sa1..sa5*.md`).

---

## 1. Resumo executivo (veredito)

**O núcleo de dedup funciona: artigo JÁ SALVO com conteúdo completo (`needs_enrich=0`) NUNCA volta para a IA.** O gate `processArticle` (`src/crawl.js:644-647`) devolve antes de fetch/parse/clean, e verify/classify/summarize são exclusivamente NULL-only. Issues já curadas não são re-curadas (497 ficaram intocadas na validação). Paginação com piso para na 1ª página.

**Mas a run de validação (que devia custar ~US$ 0,05) custou US$ 0,4242 / 990 chamadas LLM — e ~⅓ disso foi REPROCESSAMENTO de artigos que já existiam** (ver §4):

| Componente | Chamadas | Custo aprox. | O que é |
|---|---|---|---|
| Conteúdo novo legítimo (44 artigos, 43 publicados após o fim da run #1) | ~560 | ~US$ 0,28 | curate 21 (3 issues novas), clean 41, verify 41, summarize ~44, classify ~396 |
| **Reprocesso de artigos antigos (run #1 + restaurados)** | **~430** | **~US$ 0,14** | **verify 178/219 em artigos antigos (153 restaurados + 25 da run #1), ~198 classify extras, 27 clean em itens só-blurb da run #1** |
| Fetch de alvos mortos (sem LLM, mas tempo/CPU) | 140 `fetch fail` | — | os MESMOS 38+ URLs falhando nas duas runs |

---

## 2. A prova (metodologia)

| | Run #1 (ontem, 10/09) | Run #2 (validação, 11/09) |
|---|---|---|
| Comando | `crawl --since 2026-01-01` (sem caps) | `crawl --since 2026-09-05 --budget 0.5` |
| Resultado | 1.969 artigos novos (run_id=1) | **44 novos** (run_id=2; 43 com `published_at` ≥ fim da run #1 → conteúdo legítimo novo; 1 antigo) |
| Custo IA | US$ 13,67 · 23.041 chamadas | **US$ 0,4242 · 990 chamadas** — status `budget_stopped` (cortou no sweep) |
| Eventos-chave | `item dup` 9.107 · `item skipped` 1.251 · `curate ok` 494 = `coverage` 494 · `enrich kept-blurb` 353 · `job timeout` 29 · `fetch fail` 140 | `fetch fail` 140 (idêntico) · `verify` 219 (ok 116 / suspect 96 / junk 7) · `clean ok` 66 · `enrich ok` 64 · `kept-blurb` 5 · `job timeout` 5 · `curate ok` 3 = `coverage` 3 |

**Atribuição medida (SQL):** das 219 verificações da run #2, **178 foram em artigos ANTIGOS** (153 restaurados + 25 da run #1) e só 41 nos 44 novos. Dos 69 cleans, **27 foram em artigos da run #1** (re-enriquecimento de itens só-blurb). As 594 classificações excedem as ~396 necessárias para os 44 novos em ~198 (artigos antigos sem linha em `classifications`).

---

## 3. O que está FUNCIONANDO (com evidência)

1. **Dedup em 4 camadas, custo crescente** — `isUrlKnown` (4 ramos: `articles.url`, `pages.url`, `frontier` done/failed/pending/in_progress, `articles.issue_url` — `src/db.js:401-410`) → `enqueue` INSERT OR IGNORE (`db.js:626-629`) → `insertArticle` INSERT OR IGNORE + UNIQUE(`url`) (`db.js:59`) + UNIQUE(`content_hash`) (`db.js:91`) → gates NULL-only.
2. **Zero LLM para artigo completo repetido** — `if (pre && !enriching) return` em `crawl.js:644-647` (o `item dup` 9.107 da run #1 não custou IA item-level). `dup` por hash: `crawl.js:908-915`.
3. **Piso de data e parada de paginação** — run #2: todas as 8 listagens Cooperpress pararam com "piso atingido, parando paginação" na página 0 (ex.: 571 links, 570 < `--since`, 0 novos em nodeweekly.com); `known-url` 100% para o que está acima do piso. Só 8 páginas de listagem fetchadas em toda a run.
4. **Issues curadas não re-curam** — 497 jobs `roundup` `done` intocados; só 3 issues novas curadas (21 chamadas = ~7 seções × 3). **Zero duplicação de conteúdo**: 0 colisões de `content_hash` entre os 1.969 da run #1 e o acervo restaurado (SA-5). A lacuna pós-restore (`issue_url` ausente no snapshot → ~745 issues re-curadas na 1ª coleta) **já foi paga e curada na run #1** (494 issues + 3.609 chamadas `curate`, US$ 6,53 — a maior fatia daquele custo; hoje 27 `template_sig` de seletores cacheadas → a run #2 gastou só 10 `contentSelector` vs 315 na run #1). **Caveat**: 176 das 494 issues curadas salvaram 0 itens (só dups, `issue_url` ausente) — estão protegidas APENAS pela frontier (`frontier done`); limpeza da frontier ou um novo restore no formato antigo REABRE o buraco (~US$ 9,85 em ~745 issues — ver Furo 5).
5. **Sweeps e streaming delta-only de verdade** — verify/classify/summarize re-selecionam só `NULL`/linha ausente (`db.js:427-430, 451-453, 821-828`); 15.252 dos 15.502 restaurados são imunes ao sweep (têm `classifications` com `status='restored'` — `restoreTags(..., {markClassified:true})`, `restore.js:1057,1163`); streaming pós-save roda apenas para a ficha recém-salva/enriquecida (`commands.js:511`). O único caminho full-corpus é `finish --force --yes` (opt-in, backup antes — `commands.js:1239-1268`).
6. **Budget funcional** — `--budget 0.5` cortou a run no meio do sweep (`budget_stopped`) sem adulterar dados; pendentes ficam retomáveis (NULL-only).

---

## 4. O QUE ESTAMOS ERRANDO — vazamentos de reprocesso (ordenados por causa-raiz)

### Furo 1 — Itens kept-blurb NUNCA passam pelo streaming; a dívida é paga na run seguinte (P0)
`keepAggregatorVersion` (`crawl.js:607-613`) **não devolve `verifyUrl`**, então um item cujo alvo não rendeu corpo (blocked/raso/morto/PDF/junk) fica salvo com blurb e **zero verify/summarize/classify até o sweep pós-crawl** — que é interrompível e não escopado (Furo 3). Medido: a run #1 terminou com a última chamada LLM no MESMO segundo do `finished_at` (22:42:43) → sweep interrompido → **~400 itens kept-blurb da própria run #1 ficaram pendentes** e foram drenados pela run #2. Consequência: `finish` hoje custaria ~US$ 1,69 em cima do acervo que já pagamos (ver Furo 3).

### Furo 2 — `ENRICH_MAX_ATTEMPTS=0` (decisão do usuário nesta máquina): alvos mortos e timeouts re-processados em TODA run (P0-decisão)
No seed de cada run: `requeueNeedsEnrichForSource` re-ativa TODOS os itens `needs_enrich=1` (`commands.js:405`; `db.js:686-691`) — com o teto desligado (`NC_HOME/.env`), o bump `bumpFailedEnrichAttempts` (`commands.js:404`/`db.js:680-685`) nunca roda e o cap vira `Number.MAX_SAFE_INTEGER` ⇒ **nenhum alvo é aposentado**. Medido:
- 34 URLs `failed` na frontier (domínios mortos: `scientificcomputing.org`, `blog.embedded-rust.dev`, `wordgard.dev`, `www.33jsconcepts.com`, `astryx.meta.com`, `bitfan.app`…) → re-fetchadas com fallback **Playwright** (estático falha → render 30-60s cada) em todo crawl. `fetch fail` = **140 nas DUAS runs** (38 URLs exatas iguais). Enquanto o DNS falha, o custo LLM é ~zero; **se o alvo voltar à vida, cada tentativa custa ≈ US$ 0,0042–0,0055** (clean US$ 0,00155 + verify US$ 0,00035 + summarize US$ 0,00026 + classify 9 facetas US$ 0,00203 — preços `config.js:177-181`).
- 67 itens só-blurb re-enfileirados no início da run #2 ("enriquecer: N item(ns) só-blurb…" — 41 TWIR, 11 Superhuman, 9 Node, 3 JS, 2 Go, 1 React); 27 deles renderam corpo e consumiram clean IA + verify/classify/summarize; os demais re-falharam. **Só `job timeout` (90s) e falha de FETCH re-enfileiram**; kept-blurb (PDF/blocked/thin/dup) NÃO: `finishEnrich` zera `needs_enrich` (`crawl.js:606-613`). Ainda assim, os 5 timeouts novos da run #2 entram na fila da próxima run. Correção de comportamento (sem tocar em código): reativar `ENRICH_MAX_ATTEMPTS=3` ou adotar lista de exclusão de domínios mortos.

### Furo 3 — Sweep pós-crawl varre pendentes de QUALQUER run (não é escopado por run) e é cortado no meio (P1)
`verifyPending`/`classifyPending`/`summarizePending` selecionam `WHERE verify_status IS NULL` etc. **sem filtro de run/fonte/data** (`db.js:427-430, 451-453, 821-828`) e rodam logo após o crawl (`commands.js:639-648`). Numa run de data coberta isso transforma o "custo ~0" em "drenagem do backlog de todas as runs" — medida na run #2: 178/219 verifies + ~198 classifies + 27 cleans em artigos antigos (~US$ 0,14). E ele é interrompível: **a run #1 foi cortada no MESMO segundo do `finished_at`** (22:42:43; 26 dos 28 eventos verify em artigos restaurados têm esse timestamp — SA-5) → ~400 kept-blurbs da própria run #1 ficaram pendentes. Estado hoje (pós-corte de budget da run #2): **453 sem verify, 637 sem resumo, 661 sem classificação** — `finish` sem budget custaria ≈ 7.039 chamadas ≈ **US$ 1,69** (453×verify + 637×summarize + 661×9×classify; médias reais por stage: classify US$ 0,00023 · verify US$ 0,00034 · summarize US$ 0,00026; classify = 81% do custo de finish). Obs.: o verify usa heurísticas grátis quando possível (137 dos 153 restaurados re-verificados na run #2 foram por heurística).

### Furo 4 — Placeholders e domínios mortos entram no acervo pela curadoria e viram alvos perpétuos (P1)
A curadoria LLM aceitou links-lixo: `blog.example.com`, `particle-charts.example.com`, `thewayofflesh.localhiiv.com`, `marketing.superhuman.ai`… (presentes na frontier `failed`) — o filtro determinístico (`curate.js:155-170`) valida só URL/scheme/host-interno/sponsor/job; não há checagem de exemplo/reserved TLD/DNS. Cada um deles entra na roda do Furo 2 para sempre.

### Furo 5 — Curadoria gasta LLM ANTES do dedup: issue "só-dup" custa a curadoria inteira (P1)
`splitIntoSections` + 1 agente Flash por seção + passe de cobertura rodam **antes** do `INSERT OR IGNORE` (`curate.js:204-214, 256-289, 324-368`): média **7,31 chamadas / US$ 0,0132 por issue** (6,21 seções), custo fixo mesmo quando todos os itens já são conhecidos. Medido na run #1: **176/494 issues renderam 0 itens novos — ~US$ 2,32 de US$ 6,53 queimados em issues só-dup**; no total, ~95% dos itens vistos pela IA já existiam (9.107 `item dup`). Não existe guard "issue já coberta" no job roundup — a proteção é só o enfileiramento via `isUrlKnown` (ramos 3/4). O mesmo vale para a 1ª coleta pós-restore sem `issue_url` (0/15.502 restaurados têm — artefato do export antigo; 1.969/1.969 novos têm): restore sem snapshot novo reabre ~US$ 9,85.

### Furos menores
6. **`normalizeUrl` preserva `www.` (`util.js:14-17`)** — `www.webb-world.com/...` e `webb-world.com/...` NÃO colidem (decisão deliberada para Substack de domínio próprio, mas gera dup potencial onde o ápice existe). Ex.: 5 URLs distintas de `www.webb-world.com` na frontier.
7. **Telemetria** — o contador de progresso dizia "+65 salvos" mas a run gravou 44 (eventos `item saved` 42 + `save ok` 2); `runs.new_count=44`. A linha de progresso superestima o que vira acervo.
8. **Busca pós-run sem artigos** — âncora `MAX(articles.run_id)` (`db.js:779`): run que não traz artigo não move o escopo; a busca "última run" re-varre o MESMO conjunto (estável por construção, não é furo de custo, mas surpreende: "última run" ≠ "run mais recente").
9. **Classify são 9 facetas por artigo (2 Pro + 7 Flash)** e rodam até em blurb-only — 13.879 chamadas na run #1 = 1.536 artigos × 9 + 55 retries (0,4%); com o Furo 1, um blurb provisório é classificado como se fosse artigo definitivo (e depois o corpo chega com tags potencialmente diferentes); 433 artigos da run #1 ficaram sem classificar no fim (sweep cortado, Furo 3).
10. **Ruído de telemetria**: articleClean 1.642 chamadas vs 1.626 eventos clean (+16 aborts sem evento); verifyRecord 1.578 vs 1.572 eventos (+6 falhas sem evento — ficha re-selecionada, sem perda). `articleExtract` 431 ≠ enrich ok 1.537 é arquitetura: 1.355 enriches via Readability grátis, 33 content-selector, 149 LLM (SA-5).

---

## 5. Correções recomendadas (priorizadas)

| # | Ação | Onde | Efeito esperado |
|---|---|---|---|
| P0-1 | `keepAggregatorVersion` devolver `verifyUrl` (ou agendar o streaming pós-kept-blurb) | `src/crawl.js:607-613` | Elimina o acúmulo de ~400 pendentes/run (Furo 1) |
| P0-2 | **Decidir** com o usuário: reativar `ENRICH_MAX_ATTEMPTS=3` (ou) lista de exclusão persistente de domínios mortos | `NC_HOME/.env` / novo stmt | Para de re-processar 34+ alvos mortos e 67 só-blurbs em toda run; alvos mortos param de queimar Playwright (Furo 2) |
| P1-1 | Escopar o sweep pós-crawl à run atual (`WHERE run_id = <atual>`), deixando o backlog para `finish --budget` explícito | `src/commands.js:639-648` | Run de data coberta volta a custar ~0; dívida vira ação explícita (Furo 3) |
| P1-2 | Pré-filtro "issue só-dup" ANTES dos agentes de seção: checar razão de URLs conhecidas da issue (mesma lógica `isUrlKnown` da listagem) e pular a curadoria LLM se 100% conhecida e sem `issue_url` nova | `src/curate.js` | Economiza ~US$ 0,0132/issue em issues só-dup; no cenário pós-restore antigo, ~US$ 9,85 (Furo 5) |
| P1-3 | Filtro de placeholder/DNS na consolidação (regex `example\.com`, reserved TLDs; resolução DNS com fail-open rápido) | `src/curate.js` | Placeholders não entram no acervo/alvos (Furo 4) |
| P2-1 | Garantir `issue_url` no próximo snapshot exportado (`export --format web` já grava) para fechar o ramo 4 do restore — e SEMPRE `--since` na 1ª coleta pós-restore | `src/export-web.js` (verificar) / operação | Restore futuro não reabre o buraco da re-curadoria (Furo 5) |
| P2-2 | Alinhar contador de progresso com o real (44 ≠ 65) | `src/progress.js` | Telemetria honesta (Furo 7) |
| P2-3 | Opcional: colapsar `www.`/ápice com validação (HEAD no ápice quando `www` falha) | `src/util.js:14-17` | Menos dups/retries em domínios com ambos (Furo 6) |

---

## 6. Estado pós-validação (fronteira para a próxima decisão)

- Acervo: **17.515 artigos** · pendentes: **453 verify / 637 resumo / 661 classificação** (≈ união ~670) · `needs_enrich=1`: **40** (todos da run #1 — ficam de fora do `finish` e vão para o próximo crawl) · frontier: 17.958 done / 0 pending / 8 in_progress / 34 failed.
- Custo IA acumulado: **US$ 14,10 em 24.031 chamadas** (run #1 US$ 13,67 / 23.041 + validação US$ 0,42 / 990).
- Se rodar `finish` sem budget agora: ≈ 7.039 chamadas ≈ **US$ 1,69** (classify = 81%) — **a drenagem do backlog é a maior despesa futura previsível**, e é recuperável sem reprocessar nada completo.

## 7. Reprodução (queries-chave)

```sql
-- atribuição da run de validação
SELECT stage, count(*), printf('%.4f',sum(cost_usd)) FROM llm_usage WHERE run_id=2 GROUP BY stage;
SELECT CASE WHEN a.run_id=2 THEN 'novo' WHEN a.content_source='restore' THEN 'restaurado'
            WHEN a.run_id=1 THEN 'run1' END, count(DISTINCT e.url)
  FROM events e JOIN articles a ON a.url=e.url WHERE e.run_id=2 AND e.stage='verify' GROUP BY 1;
-- zero conteúdo duplicado (prova de que o dedup de hash funcionou)
SELECT count(*) FROM articles a1 WHERE a1.run_id=1 AND a1.content_hash IS NOT NULL
  AND EXISTS (SELECT 1 FROM articles a2 WHERE a2.run_id IS NULL AND a2.content_hash=a1.content_hash);  -- 0
-- alerta de dívida
SELECT count(*) FROM articles WHERE verify_status IS NULL;      -- 453
SELECT count(*) FROM articles WHERE summary_pt IS NULL;         -- 637
SELECT count(*) FROM articles a WHERE NOT EXISTS
  (SELECT 1 FROM classifications c WHERE c.article_id=a.id);    -- 661
-- custo médio por stage (para estimar finish/busca)
SELECT stage, count(*), printf('%.4f', avg(cost_usd)) FROM llm_usage GROUP BY stage;
```

## 8. Referências

- Relatórios completos dos subagents: `docs/auditoria-reprocesso/sa1-dedup-novidade.md` · `sa2-curadoria-enrich.md` · `sa3-sweeps-pendentes.md` · `sa4-paginacao-refresh.md` · `sa5-run1-forensics.md`.
- Log da validação: `/tmp/nc-validate.log` · log do run: `~/.newsletter-crawler/logs/crawl-2026-09-11T16-32-40-948Z-67410.log`.