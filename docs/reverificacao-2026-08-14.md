# Re-verificação integrada dos fixes P1–P6 — dados reais (2026-08-14)

Re-verificação da correção dos problemas P1–P6 detectados na captura real (run 1,
Node Weekly issue 637, 15 artigos) — evidência gerada contra o NC_HOME real
(`~/.newsletter-crawler/crawler.db`), provider default (OpenRouter), chave real,
custo total das provas: **US$ 0,0373** (runs 3+4+5; teto das provas: US$ 0,05).
Todas as provas foram executadas da worktree
`onda4-reverificacao` (branch `do/newsletter-crawler/20260814-092616-342878/onda4-reverificacao`).

## Resumo

| Prova | Resultado | Evidência principal |
|---|---|---|
| A. Gate | **OK** | 533/533 testes em ~6,1s; `npm run status` boota (15 artigos, 0 pendentes) |
| B. P1 backfill | **OK** | `SELECT published_at … GROUP BY` → 1 linha: `2026-08-13` × 15 |
| B. P1 herança data | **OK** | evento `curate/ok` com `issueDate: "August 13, 2026"`; 6 itens novos com a MESMA data; reextract preserva `publishedAt 2026-08-13` (nunca a data do alvo) |
| B. P2 retry zod | **OK** | re-run (80 chamadas LLM): **0** ocorrências de "fora do schema" |
| B. P3 taxonomia | **OK** | `taxonomy_version = 2026-08-14` nas classifications dos 6 novos; adições (nodejs/static-analysis/sast/dom/activitypub) presentes e NENHUMA caiu; 1 queda (`bun`) classificada |
| C. P5 Vitest | **OK** | fim "View changes on GitHub" REMOVIDO; 82→103 linhas; re-verify `ok` |
| D. P4 Drizzle | **OK** | falso-positivo `ok` → **`suspect`** com nota "conteúdo começa com menu de navegação" (heurística determinística) |
| E. Amostragem | **OK** | 3 artigos avaliados (Vitest, Drizzle, NodeBB) + 1 bônus; datas 2026-08-13, textos limpos |

---

## A. Gate

### A.1 `npm test` (worktree, node_modules via `npm ci`, HUSKY=0)

```
ℹ tests 533
ℹ pass 533
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 6060.160358
```

### A.2 `npm run status`

```
[2026-08-14T15:09:28.477Z] — status —
sources:   1      pages:  1      articles: 15      selectors: 1
classif.:  done=15 pending=0   resumos: done=15 pending=0
gasto LLM: US$ 0.0676 em 188 chamadas
frontier:  pending=0 in_progress=0 done=17 failed=0
```

---

## B. P1 + P2 + P3 — replay da issue 637

### B.1 Backfill (P1) — prova estática

```sql
SELECT published_at, COUNT(*) n FROM articles
WHERE issue_url='https://nodeweekly.com/issues/637' GROUP BY published_at;
```

```
[ { "published_at": "2026-08-13", "n": 15 } ]
```

1 linha, 15 artigos — o backfill (`scripts/fix-issue-dates.mjs`, commit `b340553`) está
aplicado no banco real.

### B.2 Re-enfileiramento da issue

```
ANTES:  {"state":"done","retries":0}     (frontier, url https://nodeweekly.com/issues/637)
UPDATE changes: 1
DEPOIS: {"state":"pending","retries":0}
```

### B.3 Re-crawl delta

```
BUDGET_USD=1 npm run crawl -- --sources "Node Weekly" --since 2026-08-11 --max-pages 3
```

Trechos do log (arquivo da re-run, run #3):

```
[15:11:32] arquivo p0: 568 links roundup (0 novos, 567 < --since) em https://nodeweekly.com/issues
[15:11:32] --since: piso atingido, parando paginação em https://nodeweekly.com/issues
[15:20:22] roundup curado (3 seções em paralelo): 6 itens novos (news=6) [7 do passe de cobertura]
           +13 já conhecidos, fora: sponsor=2 other=14 em https://nodeweekly.com/issues/637
[15:27:35] crawl concluído.
[15:27:35] run 3: 6 novo(s) artigo(s) desde a última execução.
[15:27:35] verify: nada a verificar.   classify: nada a classificar.   summarize: nada a resumir.
```

- Listagem re-visitada: **0 links novos** (parada determinística `known-url` + piso `--since`).
- Dos 19 itens curados da issue 637: **13 `dup`** (caminho de dedup — eventos `item/dup` 87, 93–105)
  e **6 `saved`** — todos da seção **IN BRIEF** (eventos `item/saved` 88–96; ver Observação 1).
- **0 duplicatas** no banco: `SELECT COUNT(*) - COUNT(DISTINCT url) FROM articles WHERE issue_url=…637` → `{ dup: 0 }`.
- Sweeps pós-crawl: tudo feito em streaming (nada a re-fazer).

### B.4 P1 — evento `curate/ok` com a data da ISSUE (herdada)

Evento (run 3, stage `curate`, status `ok`, url `…/issues/637`) — detail completo:

```json
{
  "itemsTotal": 19, "saved": 6, "dup": 13, "enqueued": 6,
  "byKind": { "news": 6, "tool": 0, "release": 0 },
  "skipped": { "sponsor": 2, "job": 0, "other": 14, "internal": 0, "invalid": 0 },
  "recovered": 7, "sections": 3,
  "sectionNames": ["IN BRIEF", "Code & Tools"],
  "issueDate": "August 13, 2026"
}
```

`issueDate: "August 13, 2026"` — **mês por extenso** (o fallback do P1), herdado da cadeia
roundup→itens. Detalhe do caminho nesta re-run: o frontier de 637 não tinha
`discovered_date` (issue conhecida de run 1, par da listagem sem data gravada), então a
ancora veio da própria página da issue via `roundupIssueDate` (crawl.js:461) →
`extractPublishedDate(html)` → "August 13, 2026", que `parseDate` entende (fallback
mês-por-extenso do P1). Os 6 itens novos gravaram a MESMA string:

```
16 | run 3 | August 13, 2026 | Node maintainer Matteo Collina explains how he 'triages the AI ho…
17 | run 3 | August 13, 2026 | Bun 1.4's release appears to be imminent
18 | run 3 | August 13, 2026 | `node:domain` could become runtime-deprecated in Node 27
19 | run 3 | August 13, 2026 | Several teams are reporting out-of-memory crashes after upgrading…
20 | run 3 | August 13, 2026 | Vercel now offers a one-click Node.js upgrade mechanism
21 | run 3 | August 13, 2026 | A Deep Dive into How Hono Is Built
```

`published_at` é string crua por design; o `iso_date` do SQLite (o MESMO `parseDate` do
crawler, db.js:31) normaliza as duas formas:

```
iso_date("August 13, 2026") = 2026-08-13
iso_date("2026-08-13")      = 2026-08-13
```

**"enrich nunca adota a data do alvo"** — provado também no reextract (C): evento
`reextract/ok` do artigo Vitest carrega `publishedAt: "2026-08-13"` (âncora da issue),
não a data da release do GitHub.

### B.5 P2 — retry central de zod: grep do log da re-run

```
$ grep -c "fora do schema" rerun-637.log        → 0
$ grep -c "JSON inválido"   rerun-637.log        → 2   (retry defensivo pré-existente; ambos
                                                            convergiram na tentativa seguinte)
$ grep -c "WARN"            rerun-637.log        → 3
```

Em **80 chamadas LLM** na re-run: **zero** WARNs "fora do schema" (o retry central de zod
do `callJSON` — P2 — não precisou disparar). As 2 ocorrências de "JSON inválido do LLM
(tentativa 1/3)" são o retry de parse defensivo (já existente) e convergiram na
tentativa seguinte (itens enriquecidos normalmente).

### B.6 P3 — taxonomia 2026-08-14

Estático (config/taxonomy.json, commit `0232df1`): `"version": "2026-08-14"` com as
adições presentes — `nodejs` (ecosystem-language), `static-analysis`/`sast`
(concept-theme), `dom` (frontend), `activitypub` (backend).

Dinâmico — os 6 artigos novos foram classificados com a versão nova:

```
16 | v 2026-08-14 | deepseek/deepseek-v4-flash-0731 | Node maintainer Matteo Collina…
17 | v 2026-08-14 | deepseek/deepseek-v4-flash-0731 | Bun 1.4's release appears to be imminent
18 | v 2026-08-14 | deepseek/deepseek-v4-flash-0731 | `node:domain` could become runtime-deprecated…
19 | v 2026-08-14 | deepseek/deepseek-v4-flash-0731 | Several teams are reporting out-of-memory crashes…
20 | v 2026-08-14 | deepseek/deepseek-v4-flash-0731 | Vercel now offers a one-click Node.js upgrade…
21 | v 2026-08-14 | deepseek/deepseek-v4-flash-0731 | A Deep Dive into How Hono Is Built
```

(os 15 originais seguem com a versão da captura, `2026-08` — não foram re-classificados,
como esperado: estão `done`.)

### B.7 Quedas de tags (grep "descartou")

```
$ grep -n "descartou" rerun-637.log
35: WARN classify[ecosystem-language] descartou 1 tag(s) fora do vocab: bun
```

1 única queda, classificada: **`bun` na faceta `ecosystem-language`** — queda POR DESIGN
(vocabulário fixo da faceta; `validateFacetTags` corta o que o modelo propõe fora dele).
Não é regressão: nenhuma das adições do P3 (nodejs/static-analysis/sast/dom/activitypub)
caiu. Observação: `bun` existe em `topics_by_domain.nodejs` (a taxonomia conhece o Bun no
domínio Node), mas não no vocabulário da faceta `ecosystem-language` — candidata a adição
futura (ver Observação 2).

---

## C. P5 — reextract na Vitest (release notes do GitHub)

Comando: `node src/index.js reextract --url vitest --limit 1` (run #4)

```
[15:24:37] reextract: 1 artigo(s) — re-fetch + re-parse + re-clean + re-verify.
[15:26:25] reextract ok [3753ch, ok]: Vitest 5.0 Release Candidate
[15:26:25] reextract concluído: 1 re-extraído(s), 0 pulado(s) (ok=1).
[15:26:25] extrato do run #4 (reextract): 2 chamadas, US$ 0.0006 (done)
```

### Antes × depois (artigo 8, https://github.com/vitest-dev/vitest/releases/tag/v5.0.0-rc.1)

| | ANTES (captura run 1) | DEPOIS (reextract run 4) |
|---|---|---|
| tamanho | 3.758 chars, 82 linhas | 3.753 chars, **103 linhas** |
| fim do texto | `"…browser: Serve framework assets as immutable … (7af87)\n\n    View changes on GitHub"` | `"…Lowers peak memory usage when using --changed… (9f23f)\n\nbrowser: Serve framework assets as immutable … (7af87)"` |
| botão "View changes on GitHub" | **presente** (fim truncado) | **removido** |
| quebras de bloco | coladas | **blocos separados por linha em branco** (103 vs 82 linhas) |
| início do texto | (com sujeira de moldura) | `"🚨 Breaking Changes\n\nInline projects extend the root config by default …"` |
| veredito | `suspect` (motivo: "Conteúdo truncado: lista termina com 'View changes on GitHub' sem links ou rodapé completo") | **`ok`** |

Eventos da prova (run 4):

```
80 | verify | suspect | …vitest/releases/tag/v5.0. | {"problems":["Conteúdo truncado: lista termina com 'View changes on GitHub'…","Ausência de cabeçalhos/seçõ…
82 | reextract | ok | …vitest/releases/tag/v5.0. | {"method":"readability","chars":3753,"publishedAt":"2026-08-13"}
83 | verify | ok | …vitest/releases/tag/v5.0. | null
```

O strip do gatilho + 2º passe do container (P5) funcionou: o fim do texto é agora o
último item REAL da release, e o re-verify (LLM) dá `ok`. O `publishedAt: "2026-08-13"` no
evento confirma de novo o P1: item de issue NUNCA adota a data do alvo.

---

## D. P4 — reclean na Drizzle (falso-positivo `ok`)

Contexto: o artigo 14 ("Full-Text Search in Drizzle Without a Second System",
https://github.com/paradedb/drizzle-paradedb) tinha o corpo abrindo com o menu de
navegação do site — `"Website •\n Docs •\n Community •\n Blog •\n Changelog"` — e o
verificador pré-fix deu `ok` (falso-positivo da captura).

O que foi rodado:

1. `node src/index.js reclean --limit 1` (run #5) — comando REAL como pedido. **Atenção
   documentada: `reclean` NÃO aceita `--url`** (confirmado em `--help`: `reclean [--limit N]`)
   e só processa linhas `verify_status='suspect'` — o artigo 14 era `ok`, portanto não
   entra na fila do reclean. O `--limit 1` processou o 1º suspect por id (TermDOM, id 1),
   com passe FORTE (Pro, stage `articleReclean`):

```
[15:26:52] reclean: 1 suspect(s) — limpeza forte (Pro) + re-verify.
[15:27:44] reclean concluído: 1 re-limpo(s), 1 viraram ok.
event 133 | clean | reclean | https://termdom.org | {"spans":4,"removidos":1485}
event 134 | verify | ok | https://termdom.org | null
```

2. Prova P4 determinística no artigo 14 — o conteúdo AINDA abre com o menu (nunca foi
   re-extraído), então a heurística pré-LLM dispara:

```
$ startsWithNavMenu(content do artigo 14) → true
  (primeiros 130 chars: "Website •\n Docs •\n Community •\n Blog •\n Changelog\n…")

$ verifyArticleRow(artigo 14)   ← MESMA função que o reclean/reextract chamam (verify.js:44)
verdict:  suspect
problems: ["conteúdo começa com menu de navegação"]
persistido: {"verify_status":"suspect","verify_notes":"conteúdo começa com menu de navegação"}
```

O falso-positivo foi corrigido: o artigo 14 agora está `suspect` com a nota da heurística
determinística (zero custo LLM). Como o menu de fato está no conteúdo salvo, o caminho
natural de correção é um `reextract` futuro nessa URL (o 2º passe/limpeza tira a moldura e
o re-verify volta a decidir com o LLM — não executado aqui por escopo).

---

## E. Qualidade pós-fixes — amostragem (3 artigos)

| Artigo | título | conteúdo | datas | quebras |
|---|---|---|---|---|
| id 8 (run 4, reextract) | "Vitest 5.0 Release Candidate" — condiz | limpo, inicia em "🚨 Breaking Changes", sem botão/moldura | `2026-08-13` (âncora da issue) | sim (103 linhas, blocos separados) |
| id 14 (run 1) | "Full-Text Search in Drizzle Without a Second System" — condiz | corpo útil limpo, MAS abre com o menu de navegação (por isso `suspect` — correto) | `2026-08-13` | sim |
| id 4 (run 1, release normal) | "NodeBB 4.15.0" — condiz | limpo (changelog da release, 7.388 chars, 284 linhas), sem botão "View changes on GitHub" no fim | `2026-08-13` | sim |
| id 20 (run 3, IN BRIEF) | "Vercel now offers a one-click Node.js upgrade mechanism" — condiz | texto limpo do alvo (enriquecido) | `August 13, 2026` (= 2026-08-13 via iso_date) | n/a (parágrafo único) |

---

## Custo das provas (ledger llm_usage)

```
run 1 | 187 chamadas | US$ 0.0676   (captura original — não desta re-verificação)
run 2 |  10 chamadas | US$ 0.0147   (crawl acidental — ver Observação 3)
run 3 |  80 chamadas | US$ 0.0362   (re-run delta, teto US$ 1,00 — gastou US$ 0,04)
run 4 |   2 chamadas | US$ 0.0006   (reextract Vitest)
run 5 |   2 chamadas | US$ 0.0005   (reclean TermDOM)
```

Provas da re-verificação (runs 3+4+5): **US$ 0,0373** — dentro do teto de US$ 0,05.

---

## Observações (achados da re-verificação)

1. **A re-run curou 6 itens NOVOS da issue 637 (seção IN BRIEF)** — não é regressão: o
   dedup funcionou (13 `dup`, 0 duplicatas no banco) e o que entrou é material que a
   captura original perdeu (gap de recall do curador LLM, comportamento documentado em
   persisting-and-orchestrating: "Curator recall is NOT guaranteed"). Efeito colateral
   POSITIVO: a issue está mais completa (15→21 itens). O "0 artigos novos" esperado no
   enunciado assumia curadoria determinística; o caminho de dedup é que é determinístico e
   foi provado.
2. **Queda de tag `bun` (ecosystem-language)** — comportamento correto do
   `validateFacetTags` (vocabulário fixo por faceta). Sugestão não-bloqueante: `bun` já é
   tópico de `topics_by_domain.nodejs`; adicioná-lo ao vocabulário da faceta
   `ecosystem-language` (junto de `deno`) evita a queda futura.
3. **Crawl acidental (run 2, US$ 0,0147)** — `node src/index.js crawl --help` NÃO exibe
   help e inicia um crawl (o help de crawl não existe; `--help` foi ignorado como flag).
   O crawl rodou ~20s (só listagens, 0 artigos salvos), foi morto, o frontier foi
   RESTAURADO ao estado anterior (273 linhas de lixo removidas) e o run 2 marcado
   `failed`. Nenhum dado de artigo foi afetado. Custo da falha: US$ 0,0147 (fora das
   provas). Recomenda-se tratar `--help`/`-h` no parse do CLI como ação de help (não
   iniciar o crawl).
4. **`reclean` não tem `--url`** e só mira `suspect` — para um artigo específico `ok`
   falso-positivo, o caminho é `reextract --url <substr>` (re-extrai + re-verifica) ou a
   verificação direta (como feito aqui, via `verifyArticleRow` — a mesma função de
   produção).
5. **Formato misto de `published_at`** — os 15 originais estão ISO (`2026-08-13`, via
   backfill) e os 6 novos estão crus (`August 13, 2026`, via herança da issue). Sem efeito
   prático: `iso_date()` normaliza as duas formas (2026-08-13). Sem ação.

## Estado final do banco real

```
articles: 21 (issue 637 completa: 15 + 6 IN BRIEF) · classif. done=21 · resumos done=21
frontier:  pending=0 in_progress=0 done=23 failed=0
runs:      1 done (captura) · 2 failed (acidental, restaurado) · 3 done (re-run) ·
           4 done (reextract) · 5 done (reclean)
```

## Arquivos de referência

- Fixes: commits `7116b35` (P1), `d2d231b` (P2+P4), `0232df1` (P3), `dea316b` (P5+P6),
  `b340553` (backfill), `d221a89` (testes reextract).
- Código citado: `src/verify.js` (heurística nav-menu:25-37, `verifyArticleRow`:44),
  `src/reextract.js`, `src/curate.js` (herança issueDate:280-291), `src/crawl.js`
  (`roundupIssueDate`:461), `src/db.js` (`iso_date`:31), `src/taxonomy.js`
  (`validateFacetTags`:113).
