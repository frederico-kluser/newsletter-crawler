# Captura 2026-08-14 — Node Weekly (onda 1, teste do pipeline completo)

- **Data/hora:** 2026-08-14 12:29:00 → 12:37:02 UTC (duração 8 min 2 s)
- **Fonte:** Node Weekly (https://nodeweekly.com/issues, tipo `index`)
- **Executado por:** sub-agente onda1-captura-node-weekly, worktree `20260814-092616-342878/onda1-captura-node-weekly`
- **Skills aplicadas:** project-router, running-and-verifying-crawls, persisting-and-orchestrating, fetching-and-extracting, calling-the-llm-layer
- **Banco:** `~/.newsletter-crawler/crawler.db` (1ª coleta real desta máquina — estava vazio)
- **Log bruto:** `docs/crawl-node-weekly-2026-08-14.log` (junto a este relatório)

## Comando usado

```
BUDGET_USD=2 npm run crawl -- --sources "Node Weekly" --since 2026-08-11 --max-pages 3 --max-articles 80
```

- Chave LLM: `NC_HOME/.env` (provider openrouter; nunca logada). Probe pré-crawl: HTTP 200.
- Pipeline de qualidade 100% ligado (curadoria por seção, limpeza IA, verificação ok/suspect/junk,
  classificação por faceta, resumos PT-BR — tudo streaming). Nenhum `--no-*` usado.
- Nenhuma etapa desligada; o crawl NÃO parou por orçamento (usou 3,4% do teto).

## Run e status

| Campo | Valor |
|---|---|
| run id | 1 |
| comando | crawl (`{"sources":"Node Weekly","since":"2026-08-11","max-pages":"3","max-articles":"80"}`) |
| status | **done** (não `budget_stopped`, não `failed`) |
| budget | US$ 0.0676 de US$ 2.00 (3,4%) |
| artigos novos | 15 |
| início / fim | 2026-08-14 12:29:00 / 12:37:02 |

## Descoberta e processamento

- **Listing:** 1 página (`/issues`), 568 links de roundup; **1 novo** (issue 637), 567 < piso
  `2026-08-11` → paginação parou por piso na 1ª página (comportamento esperado).
- **Roundups processados:** 1 (issue 637). Curadoria em **3 seções em paralelo** →
  15 itens novos (news=3, tool=4, release=8); **7 dos 15 vieram do passe de cobertura**
  (`curate/coverage`: 35 links no corpo, 25 leftovers, 7 recovered, 1 filtered, 18 secondary);
  1 sponsor e 19 outros links descartados (`item/skipped`).
- **Frontier por tipo/estado:** article done=15, roundup done=1, listing done=1; pending=0, failed=0.
- **Fetches:** 16 (1 issue + 15 alvos), todos `rendered:false` (got estático; nenhuma página exigiu
  Playwright). **Zero** fetch/parse/timeout/blocked/429/403.
- **Nenhum alvo falhou:** os 15 itens foram enriquecidos com conteúdo do alvo
  (`content_source='target'` em 15/15; `needs_enrich=0` em 15/15 — sem itens blurb-only).

## Artigos por kind e vereditos

| kind | total | ok | suspect | junk |
|---|---|---|---|---|
| news | 3 | 1 | 2 | 0 |
| tool | 4 | 3 | 1 | 0 |
| release | 8 | 4 | 4 | 0 |
| **total** | **15** | **8** | **7** | **0** |

- Verificação 100% streaming (sweeps pós-crawl: "nada a verificar/classificar/resumir").
- Classificação: done=15/15 · Resumos PT-BR: done=15/15 (todas com `title_pt` + `summary_pt`).

## Distribuição de tamanho do conteúdo (chars)

| faixa | nº artigos | min | max | média |
|---|---|---|---|---|
| 500–2000 | 3 | 939 | 1394 | 1161 |
| 2000–6000 | 4 | 3434 | 4277 | 3890 |
| 6000–20000 | 6 | 7185 | 19643 | 10895 |
| ≥20000 | 2 | 21774 | 80905 | 51340 |

- `CLEAN_MAX_CHARS` = 20000 (limpeza recorta o input; o tail não é truncado — o cabeçalho do body é
  preservado). Caso "truncado:true" explícito: freecodecamp dual-write (id 12, 21774ch, 737 chars
  removidos, tail 1774ch mantido cru) — por design, não perda.
- **Suspeito de truncamento real:** Vitest 5.0 RC (id 8, 3754ch) termina em "View changes on GitHub"
  — o corpo da release page do GitHub foi capturado pela metade (ver Amostragem).
- 2 artigos ≥ 20000: Hucre (80905ch — README completo, ver Amostragem) e dual-write (21774ch).

## Custo

Total: **US$ 0.0676** em 187 chamadas (run) / 188 (all-time, inclui 1 chamada avulsa "other" fora do ledger)
— US$ 0.0045/artigo. Todos os calls em `deepseek/deepseek-v4-flash-0731` (nenhum Pro disparou).

| stage | chamadas | USD | % | prompt tok | completion tok |
|---|---|---|---|---|---|
| classify | 136 | 0.0466 | 68,9% | 236587 | 86507 |
| articleClean | 15 | 0.0077 | 11,4% | 39899 | 12032 |
| summarize | 16 | 0.0048 | 7,1% | 30377 | 6284 |
| verifyRecord | 15 | 0.0030 | 4,4% | 17741 | 4821 |
| linkSelector | 1 | 0.0030 | 4,4% | 36545 | 29 |
| curate | 4 | 0.0025 | 3,7% | 8134 | 10357 |
| other (status/probe) | 1 | ~0.0000 | — | 157 | 162 |

- classify = 15 artigos × 9 facetas = 135 + 1 (retry/extra). Perfil de custo confirmado: classify
  segue dominando (~69%), mas no perfil barato (2 facetas core Pro/high + 7 Flash/medium) o total
  ficou em ~US$ 0,005/artigo.
- curate: 4 chamadas (3 seções + 1 retry da seção que falhou?).

## Tabela de erros por tipo

Fonte: log do crawl (15 WARNs) + tabela `events` (0 entradas de erro além do `clean/fail`).

| tipo | nº | exemplos (evidência) | impacto |
|---|---|---|---|
| curadoria: seção falhou | 1 | zod `invalid_type` em `items` ("expected array, received undefined") na issue 637, 12:31:36 | Fail-open: 2 das 3 seções curaram; itens da seção perdida só entraram via passe de cobertura se fossem links do corpo (7 recuperados). `sectionNames` lista só `["IN BRIEF","Code & Tools"]` para 3 seções |
| limpeza IA falhou (saved original) | 1 | meiert.com/blog/5-npx-helpers, mesmo zod `invalid_type` em `junk_spans`, 12:32:23 — `clean/fail` no events | Conteúdo salvo cru (sem limpeza): moldura da página ("Published on Aug 12, 2026, filed under development…") e rodapé do site permanecem no body |
| JSON inválido do LLM (tentativa 1/3, recuperado) | 2 | 12:32:07 e 12:32:15 — "repetindo com deepseek/deepseek-v4-flash-0731" | 0 perda (retry com sucesso) |
| classify: tags fora do vocabulário descartadas | 11 | 16 tags: nodejs×5, typescript×2, javascript×2, static-analysis, sast, postgresql, dom, docker, ai-agents, activitypub | Tags legítimas de ecossistema Node descartadas — vocabulário da taxonomia não cobre termos core (nodejs/typescript/javascript não existem nas facetas sugeridas) |
| fetch/render/parse/LLM timeout | 0 | — | — |
| 403/429/blocked (Cloudflare etc.) | 0 | — | — |
| parse worker (SIGSEGV/timeout) | 0 | — | — |
| budget stop | 0 | — | — |
| item descartado (sponsor/other) | 2 eventos | sponsor=1, other=19 (issue 637) | Esperado e determinístico |

## Amostragem de qualidade (1-2 por issue; 1 issue: 8 casos)

Metodologia: SELECTs no SQLite + comparação com o HTML-fonte real (curl) das páginas-alvo.

### Casos BONS

1. **NodeBB 4.15.0** (id 4, release, ok, 7388ch) — Extração de release notes do GitHub perfeita:
   começa em `activitypub: use raw content for source in notes.private (3ddadff)…` — corpo real da
   release v4.15.0, sem moldura, sem menu, fim limpo. O gold standard da amostra.
2. **Fixing the Dual-Write Problem…** (id 12, news, ok, 21774ch) — Artigo longo do freecodecamp
   completo: começa no título/prosa real (`Imagine you're building an e-commerce platform…`), limpeza
   removeu 737 chars de sujeira em 13 spans. Fim do corpo preservado (tail pós-20k mantido).
3. **DeepSeek Harness** (id 13, tool, ok, 939ch) — Conteúdo é o texto real da página
   (`Agent = Model + Harness…`), página curta de marketing capturada por inteiro. Defeitos menores:
   headings colados ao parágrafo seguinte (perda de quebras de linha) e código inline sem separação.
4. **Hucre 1.0** (id 15, release, ok, 80905ch) — README completo do repositório (81k chars, o maior):
   começa limpo em `hucre / Zero-dependency spreadsheet engine. / Read & write XLSX…`, sem nav junk.
   Projeto novo (v1.0): README-como-anúncio é aceitável; verify ok coerente.

### Casos RUINS / questionáveis

5. **5 Useful npx Helpers** (id 11, news, **suspect**, 3434ch) — O `clean` falhou (zod) e o conteúdo
   foi salvo cru: começa com a MOLdura da página `Published on Aug 12, 2026, filed under development.
   (Share this post…)` colada ao artigo e termina com rodapé do site (`Here on meiert.com I talk about
   some of my perspectives…`). O texto real do artigo está entre as duas — extração substancial OK,
   mas poluída. Bônus: a data REAL do artigo (Aug 12, 2026) está no primeiro span — e mesmo assim o
   `published_at` salvo é 2026-08-05 (ver Problemas, P1).
6. **Full-Text Search in Drizzle** (id 14, tool, **ok**, 1150ch) — Conteúdo **começa com o menu de
   navegação do site**: `Website • / Docs • / Community • / Blog • / Changelog` + linhas em branco.
   O clean removeu 300 chars em 4 spans mas não pegou o nav; e a verificação deu **ok** para um corpo
   que abre com menu. Caso claro de falso-positivo de verify.
7. **Vitest 5.0 Release Candidate** (id 8, release, **suspect**, 3754ch) — Release notes do GitHub
   **truncadas no fim**: terminam em `…browser: Serve framework assets as immutable · by @sheremet-va
   in #10729 (7af87) / View changes on GitHub`. O corpo da release continua além do botão capturado.
   Verify detectou (suspect) — mas o conteúdo salvo é incompleto.
8. **TermDOM** (id 1, tool, **suspect**, 4277ch) — Conteúdo real do README (tagline, exemplo de código
   com DOM), sem menu/HTML cru. Defeitos: h1 colado ao parágrafo (`…CSS and DOM.TermDOM is…`), código
   inline misturado à prosa. As notas de verify descrevem exatamente isso — veredito justo, extração
   aproveitável.

### Observação transversal

- **Blurb do agregador presente em todos os 15** (coluna `blurb`, ex.: TermDOM → "Like the look of Ink
  but don't like React? TermDOM implements a DOM, cascade and layout engine…") — o registro definitivo
  existe mesmo com alvo OK; em caso de alvo falho, estaria disponível (nenhum caso nesta captura).
- **Quebras de linha perdidas em vários sites** (TermDOM, npx Helpers, DeepSeek Harness): o
  textContent do Readability não preserva parágrafos em certos HTML (spans sem block breaks) — cabeçalhos
  e parágrafos ficam colados. Formatação, não perda de conteúdo.
- **Resumos PT-BR corretos** na amostra (ex.: "TermDOM: Construa UIs de terminal com HTML, CSS e DOM").

## Problemas observados (para a análise da Onda 2)

### P1 — CRÍTICO: data da issue perdida; 13/15 artigos com `published_at` errado (herdado do alvo)
- A página da issue (https://nodeweekly.com/issues/637) **não tem data machine-readable** (sem
  JSON-LD, sem `<time>`, sem meta) — só o texto visível "August 13, 2026". `issueDate` da curadoria =
  null (evento `curate/ok`), e os itens foram inseridos com `published_at = NULL`.
- No enrich, `published = data do ALVO` e, se null, herda de um sibling da mesma `issue_url`
  (`src/crawl.js` ~754, fallback "siblingDate"). O 2º item enriquecido (freecodecamp dual-write, cuja
  página tem `article:published_time = 2026-08-05T17:14:47.104Z` — verificado por curl) virou a âncora
  e **12 artigos seguintes herdaram essa data**. Resultado: 13/15 artigos datados 2026-08-05 (a issue
  é de 08-13), 1 (inngest) com 07-13 (data própria do alvo, verificada por curl) e 1 (deepseek) NULL.
- **Impacto:** superfícies ordenadas por data (site, buscas por período) mostram a issue inteira 8
  dias atrasada, ou perdem os itens com data própria/Null; buscas `--since`/de período futuras podem
  excluir a issue 637 mesmo sendo nova.
- **Onde olhar:** `src/curate.js:284` (issueDate fallback só em `extractPublishedDate(capped)`), a
  ausência de data na página da issue, e o fallback de sibling em `src/crawl.js` (~754-759) que
  PROPAGA a data de UM alvo para a issue inteira. A listagem TEM a data (`<span class="issue-date">`)
  — o roundup poderia herdá-la do par da listagem em vez de null.

### P2 — Seção de curadoria perdeu itens (1 das 3 seções falhou; zod `invalid_type` em `items`)
- O retry/escalada não recuperou a seção; `sectionNames` registra só 2 nomes para 3 seções. Itens da
  seção perdida só entram se forem links do corpo (o passe de cobertura recuperou 7 — alguns
  provavelmente dela). Recall da curadoria ficou parcial nesta issue.
- Mesmo erro zod (`expected array, received undefined`) no `clean` do meiert.com — dois estágios
  distintos com o mesmo shape inválido: padrão de resposta do modelo a investigar (json_schema).

### P3 — Vocabulário de classificação não cobre termos core do ecossistema Node
- 16 tags descartadas em 11 chamadas; `nodejs` (5×), `typescript` (2×), `javascript` (2×) não existem
  nas facetas onde o modelo as sugeriu (ecosystem-language, domain, trending-emerging…). Revisar
  `config/taxonomy.json` para incluir os termos base do domínio.

### P4 — Falso-positivo de verify (Drizzle): nav-menu no início do conteúdo classificado como "ok"
- O conteúdo de `paradedb/drizzle-paradedb` começa com `Website • Docs • Community • Blog • Changelog`
  e mesmo assim `verify_status=ok`. O verificador não distingue "menu de navegação no topo". Os 7
  suspects, ao contrário, têm notas justas e úteis (README-vs-release-notes, truncamento, HTML como
  texto).

### P5 — Release notes do GitHub truncadas (Vitest)
- Corpo da release cortado em "View changes on GitHub" (botão de rodapé da página). Readability pegou
  a lista até o botão. Verify detectou (suspect), mas o conteúdo incompleto fica salvo.

### P6 — Menor: formatação (quebras de linha perdidas) e molduras não removidas
- Headings/parágrafos colados (TermDOM, DeepSeek, npx Helpers) — textContent do Readability perde
  quebras em certos layouts; o `clean` por spans não repara isso.
- Moldura de página (meta "Published on…" + rodapé do site) no meiert.com só entrou porque o `clean`
  falhou — caso P2.

## Notas metodológicas

- O stdout do crawl foi redirecionado para `docs/crawl-node-weekly-2026-08-14.log`; o pipe do npm
  bufferiza em janelas longas de chamada LLM (linhas aparecem em lote depois), então a fonte de
  verdade durante a run foi o SQLite (`llm_usage`/`events`). Log completo ao final, sem perdas.
- Todas as datas dos alvos foram verificadas por curl no HTML-fonte real (freecodecamp
  `article:published_time` e inngest `datePublished` confirmam P1).
- Custo de US$ 0.0045/artigo é o novo normal do perfil barato de classify (antes ~92% do gasto era
  classify; aqui classify = 69% mas o valor absoluto é pequeno).
