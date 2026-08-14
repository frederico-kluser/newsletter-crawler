# Captura total — 2026-08-14 (reset + 7 fontes, 1 semana)

Relatório da onda 2: RESET de todos os dados + captura total (todas as 7 fontes cadastradas,
janela `--since 2026-08-07`, pipeline de qualidade completo ligado). Todos os números abaixo
foram obtidos de comandos reais (log do run, SQLite em read-only, `npm run inspect`).

## 1. RESET

Comando: `npm run reset -- --yes` (cwd na worktree; apaga o banco real em `NC_HOME` e as fontes
voltam ao seed).

Estado ANTES (contagens no `crawler.db` de `~/.newsletter-crawler`):

| tabela | contagem |
|---|---|
| sources | 7 |
| pages | 18 |
| articles | 21 |
| frontier | 23 |
| runs | 5 (últimos: crawl run 3, reextract run 4, reclean run 5) |
| events | 134 |
| llm_usage | 282 |
| classifications | 21 |
| article_tags | 290 |
| searches | 0 |
| selectors | 6 |

Saída do reset (log do run `reset-2026-08-14T15-58-15-535Z-1759149.log`):

```
reset: todos os dados apagados (/home/ondokai/.newsletter-crawler/crawler.db).
— status —
sources: 0 · pages: 0 · articles: 0 · selectors: 0
classif.: done=0 pending=0 · resumos: done=0 pending=0
gasto LLM: US$ 0.0000 em 0 chamadas
frontier: pending=0 in_progress=0 done=0 failed=0
```

DEPOIS (verificação independente, SQLite read-only): todas as tabelas em 0. As 7 fontes voltaram
ao seed em `sources.json` (Node Weekly, JavaScript Weekly, Frontend Focus, React Status,
Postgres Weekly — `index`; AI Weekly, llmnews.ai — `listing`).

## 2. Comando da captura

```
BUDGET_USD=5 npm run crawl -- --sources "Node Weekly,JavaScript Weekly,Frontend Focus,React Status,Postgres Weekly,AI Weekly,llmnews.ai" --since 2026-08-07 --max-pages 3 --max-articles 300
```

- Duração: 15:58:30 → 16:49:21 (~51 min)
- Exit code: 0
- Run: **#1 (crawl), status done** — "run 1: 188 novo(s) artigo(s) desde a última execução."
- Orçamento: **US$ 0.8559 de US$ 5.00 (17%)** — não parou por orçamento; drenou a fila até `pending=0`
- Chamadas LLM: 2369
- Estado final: frontier `pending=0 in_progress=0 done=211 failed=0`; verify/classify/summarize com 0 pendentes

## 3. Custo por stage (extrato do run, log final)

| stage | chamadas | US$ | % do custo |
|---|---|---|---|
| classify (9 facetas/artigo) | 1724 | 0.5461 | 63.8% |
| articleClean | 185 | 0.0990 | 11.6% |
| summarize | 191 | 0.0655 | 7.7% |
| verifyRecord | 193 | 0.0458 | 5.4% |
| curate (curadoria por seção) | 33 | 0.0443 | 5.2% |
| contentSelector | 18 | 0.0236 | 2.8% |
| linkSelector | 7 | 0.0234 | 2.7% |
| dateSelector | 3 | 0.0043 | 0.5% |
| articleExtract | 13 | 0.0024 | 0.3% |
| nextLink | 2 | 0.0015 | 0.2% |
| **total** | **2369** | **0.8559** | 100% |

Observação: `classify` continua dominando (~64%) — consistente com o perfil de custo conhecido
(9 facetas × 188 artigos, mesmo com as 7 facetas não-core em Flash/medium e input recortado em
2000 chars).

## 4. Contagens por fonte (run 1)

| fonte | artigos | news | tool | release | sem kind | ok | suspect | junk | blurb (aggregator) | alvo (target) | needs_enrich |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AI Weekly | 3 | – | – | – | 3 | 3 | 0 | 0 | 0 | 3 | 0 |
| Frontend Focus | 13 | 8 | 5 | 0 | 0 | 9 | 4 | 0 | 2 | 11 | 0 |
| JavaScript Weekly | 30 | 14 | 2 | 14 | 0 | 25 | 5 | 0 | 1 | 29 | 0 |
| Node Weekly | 19 | 9 | 3 | 7 | 0 | 12 | 7 | 0 | 0 | 19 | 0 |
| Postgres Weekly | 22 | 12 | 3 | 7 | 0 | 19 | 3 | 0 | 0 | 22 | 0 |
| React Status | 39 | 18 | 4 | 17 | 0 | 31 | 7 | 1 | 3 | 36 | 0 |
| llmnews.ai | 62 | – | – | – | 62 | 58 | 4 | 0 | 0 | 62 | 0 |
| **total** | **188** | **61** | **17** | **45** | **65** | **157** | **30** | **1** | **6** | **182** | **0** |

Issues/listagens visitadas (9 páginas `archive/ok`): aiweekly.co/issues; frontendfoc.us/issues/754;
javascriptweekly.com/issues/798; nodeweekly.com/issues/637; postgresweekly.com/issues/661;
react.statuscode.com/issues/486 e /487 (2 edições na janela); llmnews.ai + /page/2 + /page/3
(3 páginas de listing).

- Paginação: as 6 fontes Cooperpress pararam no **piso** já na página 0 ("`--since: piso atingido,
  parando paginação`", ex.: 568 links em nodeweekly.com/issues, só 1 novo); llmnews.ai paginou até
  `max-pages` 3 (não há datas na listagem p/ pisar cedo).
- Curadoria: 6 edições curadas **por seção em paralelo** (ex.: JavaScript Weekly 798 → 7 seções,
  30 itens novos, "2 do passe de cobertura"; fora: sponsor=3, job=3, other=22). 123 itens salvos
  na curadoria + 65 via `save` (itens diretos de listing/AI Weekly) = 188.
- Dedup: 9 `item/dup` (duplicados entre edições/fontes — ex.: Motion 13.1 e GTKX 1.0 em JS Weekly
  e React Status) e 17 `item/skipped`.
- Excluídos pela curadoria (determinístico): sponsors/jobs/other — Node Weekly 3+13, JS Weekly
  3+3+22, Frontend 3+1+14, Postgres 1+2+7, React Status 486: 1+2+18, 487: 1+3+8.
- Enriquecimento: 117 `enrich/ok` (método: readability 140x, content-selector 3x, llm 4x — 3 com
  data do alvo extraída; todos `cleaned:true`) + 6 `enrich/kept-blurb` (ver erros abaixo).
- `needs_enrich`: 0 no final (os 6 blurb-only ficaram com o blurb — decisão de manter o item).

## 5. Distribuição de tamanho de conteúdo (chars)

| faixa | artigos |
|---|---|
| < 200 | 5 |
| 200–999 | 18 |
| 1.000–4.999 | 65 |
| 5.000–19.999 | 85 |
| ≥ 20.000 | 15 |

Média 8.889 chars; máx 80.811; mín 45. Média por fonte: AI Weekly 9.373 · Frontend 6.919 ·
JS Weekly 7.195 · Node Weekly 11.668 · Postgres 8.809 · React Status 8.676 · llmnews 9.409.
Conteúdo limpo na prática: "The Dangers of Postgres Subtransactions" (21.286 chars) tem 199
quebras de linha e 0 tags HTML; "Inside vLLM" (51.117 chars) tem 670 quebras de linha e 6 tags
HTML residuais.

## 6. Erros e desvios por tipo (eventos da run + resumo do log)

| tipo | qtd | exemplo (detalhe) |
|---|---|---|
| enrich/kept-blurb — thin-content | 5 | "Plate: Build Your Own Rich Text Editor" (React Status) — alvo raso, mantido com blurb |
| enrich/kept-blurb — blocked-page | 1 | alvo bloqueado por anti-bot; item mantido com blurb (fail-open) |
| clean/reject (sanityCheckCleaned) | 2 | "curto demais (192 < 200)", spans=28; "curto demais (878 < 1626)", spans=64 — original preservado |
| article/skip — below-since | 8 | itens individuais filtrados pelo piso (publicados 06-24, 07-14, 08-04, 08-05×3, 08-06×2) — filtro a nível de item FUNCIONA |
| article/skip — no-content | 2 | https://openrouter.ai/deepseek/deepseek-v4-pro-0813; shreveporttimes.com |
| dateSelector/invalid | 3 | derivations de spec de data falharam sem cache: `.feed > a time` (0/25), `.meta time small` (0/29), `time` (0/25) — llmnews/aiweekly |
| item/dup | 9 | dedup por URL canônica entre edições (ex.: issue 486 ×4) |
| verify/junk | 1 | "The Next.js team … AMA on Reddit" — o Reddit arquivou a thread; conteúdo = mensagem genérica de interface |
| llmnews abaixo do piso | 2 | "OCR 4.1" (2026-07-16) e "DeepSeek V4 Flash 0731" (2026-07-31) foram SALVOS apesar do `--since 2026-08-07` — ver Problemas §1 |

WARNs (não são erros): `classify[topic-technology] descartou N tag(s) fora do vocab: llm-models,
agentic-ai, model-provenance, software-development, system-design` — guard de vocabulário agindo;
mas o vocabulário não cobre tópicos correntes (agentic, proveniência de modelo).

O log novo expôs os erros na linha `resumo:` com timestamp (ex.: `erros 16:39:57 thin-content |
16:44:16 thin-content | 16:45:52 thin-content`); o detalhe por URL vem do `npm run inspect`.

## 7. Amostragem de qualidade (12 artigos)

| fonte | título | kind/seção | verify | chars | fonte do conteúdo | observação |
|---|---|---|---|---|---|---|
| Node Weekly | `node:domain` could become runtime-deprecated in Node 27 | news/IN BRIEF | suspect | 13.402 | alvo (nodejs.org docs) | conteúdo = documentação oficial, não a notícia — suspect correto; **title_pt/summary_pt em CHINÊS** |
| Node Weekly | Out-of-memory crashes reported after upgrading from Node 24.18.1 → 24.19.0 | news/IN BRIEF | suspect | 2.297 | alvo (github issue) | conteúdo = issue do GitHub; condiz com o título; kind 'news' contestável (é issue) |
| JS Weekly | Bun 1.4 continues to be teased on 𝕏 | news/IN BRIEF | ok | 90 | alvo (X) | conteúdo raso (título + 1 frase) — verify ok mesmo assim |
| JS Weekly | TanStack Table v9: A Faster, More Modular Foundation | release/Code & Tools | ok | 10.065 | alvo (blog tanstack) | conteúdo rico e limpo; data 2026-08-11 correta; **title_pt/summary_pt em CHINÊS** |
| Frontend Focus | WCAG-EM Report Tool | tool/Tools, Code… | ok | 186 | blurb do agregador | conteúdo = blurb (alvo raso); aceitável, item preservado |
| React Status | react-dropzone 20.0 | release | suspect | 210 | alvo | **JSON cru no conteúdo** (`{"title": "Simple HTML5 drag 'n' drop zone…`) |
| React Status | React Native 0.87 Released | release | ok | 10.792 | alvo (reactnative.dev) | conteúdo rico; data da edição 2026-08-14 |
| Postgres Weekly | The Dangers of Postgres Subtransactions | news | ok | 21.286 | alvo (planetscale blog) | prosa limpa, 199 quebras de linha, 0 tags; data 2026-08-12 |
| Postgres Weekly | PostgREST 16.0 | release/IN BRIEF | suspect | 4.514 | alvo (github releases) | release notes truncada no final (verify apontou) |
| AI Weekly | AI agents crossed the line 19 times in UK safety tests | sem kind | ok | 9.817 | alvo | conteúdo limpo; data 2026-08-07 (item da listagem) |
| llmnews.ai | Inside vLLM: Anatomy of a High-Throughput LLM Inference System | sem kind | ok | 51.117 | alvo | conteúdo longo limpo (6 tags residuais); data 2026-08-07 |
| llmnews.ai | Flock (Again!) Activates A Camera System… | sem kind | ok | 4.907 | alvo (techdirt) | conteúdo limpo; data 2026-08-13 |

Conclusões da amostragem: títulos condizem com o conteúdo na maioria; datas das edições corretas
(2026-08-11/12/13/14 conforme a edição); quebras de linha preservadas; HTML residual ~zero.
Desvios: resumos em chinês (2/12 da amostra), JSON cru (react-dropzone), conteúdo raso em X
(Bun 1.4), release notes do GitHub truncadas (PostgREST 16.0) e README em vez de release notes
(BullMQ 6.1, swift-node — ver suspects).

## 8. Acompanhamento — o log novo funcionou (prova real)

Primeira linha do run (anuncia o arquivo):

```
[2026-08-14T15:58:30.156Z] log do run: /home/ondokai/.newsletter-crawler/logs/crawl-2026-08-14T15-58-30-156Z-1760211.log
```

Linhas `resumo:`/`progresso:`/`gasto parcial` a cada ~10s (cadência :00/:10/:20/:30/:40/:50), com
fase, fila (p/a/d/x), voo (artigos/curadoria/pós), salvos, vereditos e erros:

```
[2026-08-14T15:58:50.162Z] resumo: fase limpeza,curadoria,fetch · fila 0p/10a/4d/0x · voo artigos=3 curadoria=7 pós=0 · salvos +0
[2026-08-14T16:08:10.174Z] progresso: fontes 6/7 · artigos +35 · fila 41p/21a/44d/0x · curados +41 · pós 23v/23r/18c · agora: 4 curadoria 17 classificação 15 limpeza 12 verificação 12 resumo · alvo 2026-08-07: 100%
[2026-08-14T16:08:10.174Z] resumo: fase curadoria,classificação,limpeza,verificação,resumo · fila 41p/21a/44d/0x · voo artigos=16 curadoria=5 pós=41 · salvos +35 · vereditos pend=48 ok=22 suspeitos=1
[2026-08-14T16:19:10.188Z] progresso: fontes 7/7 · artigos +77 · fila 103p/16a/92d/0x · curados +123 · pós 68v/66r/60c · agora: 17 classificação 16 limpeza 9 verificação 11 resumo · alvo 2026-08-07: 100%
[2026-08-14T16:39:20.208Z] gasto parcial: US$ 0.7232 em 1919 chamadas / teto US$ 5.00
[2026-08-14T16:46:50.220Z] resumo: fase classificação · fila 0p/0a/211d/0x · voo artigos=0 curadoria=0 pós=1 · salvos +182 (+6 blurb) · vereditos ok=156 suspeitos=25 pend=6 junk=1 · erros 16:39:57 thin-content | 16:44:16 thin-content | 16:45:52 thin-content
```

Fechamento (sweeps finais + extrato):

```
crawl concluído.
run 1: 188 novo(s) artigo(s) desde a última execução.
verify concluído: 6/6 (ok=1 suspect=5). · summarize concluído: 6/6. · classify concluído: 6/6 (partial=2).
extrato do run #1 (crawl): 2369 chamadas, US$ 0.8559 de US$ 5.00 (done)  [por etapa, ver §3]
```

O que funcionou: anúncio do caminho do log; periodicidade de ~10s das 3 linhas; o campo `erros`
com timestamps na linha `resumo`; o `progresso:` com contadores de pós (v/r/c) e % rumo ao piso;
o custo ao vivo com teto; sweeps finais visíveis no mesmo log. O que faltou (sem impacto): o
`resumo` guarda só os últimos erros (a fila completa está nos eventos/`inspect`); a fase `fetch`
some do "agora" quando o pool de artigos está cheio (é o esperado); `alvo 2026-08-07: 100%` chega
cedo porque a maioria das fontes não tem data por item na listagem.

## 9. Problemas observados (para a análise da Onda 3)

1. **Resumos/títulos PT-BR em CHINÊS: 11 de 188 (5,8%)** — `title_pt`/`summary_pt` com CJK
   (ex.: "`node:domain` 可能在 Node 27 中运行时弃用" id 16; "TanStack Table V9 经过两年多的开发后
   正式发布" id 102; id 20, 48, 49, 57, 66, 108, 128, 132, 137). O stage `summarize`
   (deepseek-v4-flash) respondeu em chinês; o prompt pede PT-BR, mas não há guarda de idioma na
   saída. Sugestão de correção: validação de script (CJK → re-tentar/descartar) ou reforço do
   prompt.
2. **2 itens do llmnews.ai salvos ABAIXO do piso `--since`**: "OCR 4.1" (2026-07-16) e
   "DeepSeek V4 Flash 0731" (2026-07-31). O filtro de data a nível de item existe (8 skips
   `below-since` na run), mas esses 2 escaparam — provável enfileiramento sem data emparelhada na
   listagem (data só determinada no fetch, tarde demais). Relacionado ao dateSelector/invalid ×3
   nas listagens de llmnews/aiweekly (0 de 25/29 itens com data parseável → spec não cacheada).
3. **JSON cru no conteúdo**: "react-dropzone 20.0" (id do react-dropzone.js.org) — a extração
   (método llm) devolveu o JSON estruturado do site como texto (`{"title": "Simple HTML5 drag 'n'
   drop zone…`); verify suspeitou corretamente.
4. **Release notes do GitHub truncadas/erradas**: "smol-toml 1.8" (corta no meio da frase, seção
   Dates), "PostgREST 16.0" (truncada no final), "BullMQ 6.1"/"swift-node 0.1.2" (README do repo
   em vez da release note) — padrão de extração do GitHub com botões/molduras (o AGENTS.md já
   menciona `reextract` para isso: "conserta release notes do GitHub truncadas").
5. **1 junk**: AMA do time Next.js no Reddit — o Reddit arquivou/removeu a thread e a página
   virou mensagem genérica; verify classificou junk corretamente (não há re-tentativa).
6. **`kind` NULL nas fontes listing** (65/188: AI Weekly 3 + llmnews 62): itens diretos de
   listing não recebem kind — provavelmente by design (kind vem da curadoria de roundup), mas
   significa que buscas/web com filtro por kind não pegam esses itens. Confirmar.
7. **verify suspect 30/188 (16%)**: maioria com causa conhecida — 6 blurb-only, conteúdo raso de
   X/YouTube (título como conteúdo), JSON/README (itens 3-4), docs-oficiais-como-notícia
   (node:domain). Vereditos parecem precisos; `reclean` existe para os de baixa qualidade.
8. **classify partial=12** (12/188): facetas com erro não persistidas (invariante NULL funciona —
   não há pendentes no final). Sinaliza alguma perda pontual na etapa mais cara.
9. **WARNs de vocabulário** (llm-models, agentic-ai, model-provenance, software-development,
   system-design): guard agindo como esperado, mas o vocabulário está defasado para tópicos
   correntes (agentes, MCP, proveniência de modelo).

## 10. Comandos e evidência

- Reset: `npm run reset -- --yes` — log `reset-2026-08-14T15-58-15-535Z-1759149.log`
- Crawl: `BUDGET_USD=5 npm run crawl -- …` (comando completo em §2) — exit 0; log
  `crawl-2026-08-14T15-58-30-156Z-1760211.log` (espelho em /tmp/crawl-total-2026-08-14.log)
- Verificação: SQLite read-only sobre `~/.newsletter-crawler/crawler.db` + `npm run inspect`
  (run #1) — saídas citadas nas seções 3-7
