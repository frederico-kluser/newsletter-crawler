# Re-verificação total dos fixes da Onda 1 — dados reais da captura (2026-08-14)

Backfill + re-verificação dos fixes da Onda 1 contra os dados REAIS da captura total
(run 1, 188 artigos, US$ 0.8559 — ver `docs/captura-total-2026-08-14.md`). Todos os
comandos rodaram da worktree `onda2-backfill-reverificacao` (branch
`do/newsletter-crawler/20260814-123910-1654592/onda2-backfill-reverificacao`), contra o
`NC_HOME` real (`~/.newsletter-crawler/crawler.db`), provider default (OpenRouter).

Backup do banco ANTES de qualquer escrita:
`~/.newsletter-crawler/crawler.db.bak-2026-08-14` (37M, `cp crawler.db crawler.db.bak-2026-08-14`).

## Resumo

| Item | Backfill | Prova | Resultado |
|---|---|---|---|
| 1. Chineses (11) | title_pt/summary_pt → NULL + re-summarize | varredura CJK do acervo = 0 | **OK** |
| 2. Abaixo do piso (2) | DELETE com cascatas | 188 → 186, 0 órfãos | **OK** |
| 3. JSON cru (react-dropzone) | content = blurb + re-hash + re-verify | não começa com `{`, verify ok | **OK** |
| 4. GitHub (26/27/28) | reextract (recovery raiz → /releases) | release notes reais + eventos reextract ok | **OK** (swift-node segue suspect-thin por design) |
| 5. kind NULL (65) | kindFromTags + setKindIfNull (NULL-only) | 0 kind NULL; curados == backup; listings derivados | **OK** (1 extensão indevida corrigida — ver §5.2) |
| 6. Vocabulário 2026-08-15 | finish --force re-classify | taxonomy_version nova; quedas só aceitas | **OK** |
| 7. reclean suspects | passe forte (Pro) | 10 ok, 1 junk, 7 limpezas fortes | **OK** (6 ficaram de fora do limit 20) |

---

## 1. Chineses (11 ids: 16, 20, 48, 49, 57, 66, 102, 108, 128, 132, 137)

### 1.1 Estado ANTES (prova)

`SELECT id, title_pt, summary_pt FROM articles WHERE id IN (…)` — as 11 fichas com
`title_pt`/`summary_pt` em chinês, ex.:

```
{"id":16,"title_pt":"node:domain 可能在 Node 27 中运行时弃用","summary_pt":"Node.js 的 `node:domain` 模块…"}
{"id":102,"title_pt":"TanStack Table v9：更快速、更模块化的基础","summary_pt":"TanStack Table V9 经过两年多的开发后正式发布…"}
```

Varredura do acervo INTEIRO com a MESMA regex do `hasCjk` de `src/util.js`
(`/[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/`): **11 artigos** com CJK — exatamente 16, 20, 48, 49, 57,
66, 102, 108, 128, 132, 137 (5,8% dos 188, consistente com o relatório da captura).

### 1.2 Backfill

```sql
UPDATE articles SET title_pt = NULL, summary_pt = NULL WHERE id IN (16,20,48,49,57,66,102,108,128,132,137)
```

Saída: `before: 11 fichas com title_pt/summary_pt setados → UPDATE changes: 11 → 0 linhas restantes`.

### 1.3 Re-summarize (guarda de idioma ativa)

```
BUDGET_USD=1 npm run finish -- --no-verify --no-classify
```

Log (`/tmp/step1-resummarize.log`):

```
summarize: 11 artigo(s) — PT-BR, force=false.
summarize ok [1/11] Parcel Delivery … [6/11] TanStack Table v9 …
WARN summarize: resposta em idioma CJK; repetindo com o reforço de idioma…   ← guarda disparou 1×
summarize ok [7/11] Improved CSS Text-Stroke … [11/11] NVIDIA Nemotron 3.5 …
summarize concluído: 11/11.
  summarize: 12x — US$ 0.0033
```

A guarda de idioma da Onda 1 funcionou em produção: **1 das 11 respostas veio em CJK no 1º
try e o re-try com o reforço de idioma convergiu** (sem precisar do fail-open NULL).

### 1.4 Prova DEPOIS

Varredura CJK do acervo inteiro (mesma regex): **0 linhas**. As 11 fichas agora em PT-BR:

```
{"id":16,"title_pt":"Módulo `node:domain` pode ser descontinuado em tempo de exec…"}
{"id":102,"title_pt":"TanStack Table v9: Uma Fundação Mais Rápida e Mais Modular"}
```

---

## 2. Abaixo do piso (2 itens llmnews: "OCR 4.1" e "DeepSeek V4 Flash 0731")

### 2.1 Localização

```sql
SELECT id, title, url, published_at FROM articles
WHERE url LIKE '%ocr%' OR url LIKE '%deepseek-v4-flash-0731%' OR published_at < '2026-08-07'
```

```
{"id":36,"title":"OCR 4.1","url":"https://docs.mistral.ai/models/ocr-4-1","published_at":"2026-07-16","source_id":7}
{"id":187,"title":"DeepSeek V4 Flash 0731","url":"https://arcprize.org/results/deepseek-v4-flash-0731","published_at":"2026-07-31","source_id":7}
```

Ambos de `source_id 7` (llmnews.ai), publicados em 2026-07-16 e 2026-07-31 — abaixo do
piso `--since 2026-08-07` da captura.

### 2.2 DELETE com cascatas

`article_tags` e `classifications` têm `ON DELETE CASCADE` (FK) — cascade automático;
`events` NÃO tem FK → DELETE explícito por URL; `articles_vec`/`articles_fts` têm
triggers de pós-delete no próprio schema. Executado na conexão do projeto
(`import { db } from './src/db.js'` — necessária para carregar o sqlite-vec, senão o
trigger do vec0 falha com `no such module: vec0`), em transação:

```
deleted id 36 https://docs.mistral.ai/models/ocr-4-1
deleted id 187 https://arcprize.org/results/deepseek-v4-flash-0731
articles total now: 186        ← 188 → 186 ✓
ids 36/187 present: 0
orphan article_tags: 0  · orphan classifications: 0  · orphan article_vec: 0  · orphan fts: 0
leftover events (2 urls): 0
```

---

## 3. JSON cru (react-dropzone 20.0 — React Status)

### 3.1 Localização

```sql
SELECT id, title, url, content_source, substr(content,1,80) FROM articles WHERE content LIKE '[%' OR content LIKE '{%'
```

1 linha: **id 147** `react-dropzone 20.0` (`https://react-dropzone.js.org`),
`content_source='target'`, conteúdo = JSON puro do site:

```
{"title": "Simple HTML5 drag 'n' drop zone with React", "body": "A hooks-first library for building file drag-and-drop zones — with folder support, validation, and full control over your markup.", "date": null}
```

`looksLikeJson(content)` (src/parse-core.js, o guarda da Onda 1): **true** — o guarda
identifica corretamente o caso (e impede NOVOS casos; o restore aqui é a correção da ficha).

### 3.2 Restore

`content = blurb` (o blurb do agregador existia), `content_source='blurb'`,
`content_hash = sha256(blurb)` recalculado, `verify_status=NULL`, `verify_notes=NULL`,
`needs_enrich=0`:

```
hash clash: none
UPDATE changes: 1
after: {"c":"React hook providing a standards-compliant drag-and-drop zon…","content_source":"blurb","verify_status":null,"content_hash":"7e58999ccee5…","needs_enrich":0}
```

### 3.3 Re-verify

`verifyArticleRow(artigo 147)` (a MESMA função do reclean/reextract, src/verify.js:44):

```
verdict: {"verdict":"ok","problems":[]}
persisted: {"verify_status":"ok","verify_notes":null}
```

---

## 4. GitHub (fichas 26 smol-toml 1.8, 27 BullMQ 6.1, 28 swift-node 0.1.2)

### 4.1 Estado ANTES (confirmado no banco)

| id | título | URL | conteúdo ANTES | verify |
|---|---|---|---|---|
| 26 | smol-toml 1.8 | `github.com/squirrelchat/smol-toml` (raiz do repo) | README do repo (19.650 chars) | suspect |
| 27 | BullMQ 6.1 | `github.com/taskforcesh/bullmq` (raiz do repo) | README do repo (4.086 chars) | suspect |
| 28 | swift-node 0.1.2 | `github.com/biw/swift-node` (raiz do repo) | README do repo (12.257 chars) | suspect |

(54 PostgREST 16.0 e 55 PostgREST 16.1 NÃO foram re-extraídos — falso-positivo/thin por
design, conforme instrução.)

### 4.2 Reextract (recovery da raiz → /releases ativo)

```
BUDGET_USD=1 node src/index.js reextract --url smol-toml    → reextract ok [113ch, ok]: smol-toml 1.8
BUDGET_USD=1 node src/index.js reextract --url bullmq      → reextract ok [101ch, ok]: BullMQ 6.1
BUDGET_USD=1 node src/index.js reextract --url swift-node  → reextract ok [115ch, suspect]: swift-node 0.1.2
```

### 4.3 Conteúdo DEPOIS (release notes reais)

```
26 | "What's Changed  feat: stringify temporal objects by @Gouvernathor…  Full Changelog: v1.7.2...v1.8.0"   | verify ok
27 | "6.1.1 (2026-08-14)  Bug Fixes  flow: allow parent opts from root parent (#4548)…"                     | verify ok
28 | "What's Changed  ci: enforce package parity and fail on Node warnings by @biw in #6  Full Changelog: v0.1.2...v0.1.3" | verify suspect
```

Eventos (runs 3/4/5):

```
run 3 | reextract | ok | …squirrelchat/smol-toml | {"method":"readability","chars":113,"publishedAt":"2026-08-13"}
run 4 | reextract | ok | …taskforcesh/bullmq     | {"method":"readability","chars":101,"publishedAt":"2026-08-13"}
run 5 | reextract | ok | …biw/swift-node         | {"method":"readability","chars":115,"publishedAt":"2026-08-13"}
```

Observações:
- `publishedAt: 2026-08-13` = âncora da ISSUE (P1: item de issue nunca adota a data do alvo) ✓
- 28 swift-node: o conteúdo agora é release note REAL, mas o re-verify deu `suspect` com
  nota "título cita 0.1.2, mas o changelog refere-se à faixa v0.1.2...v0.1.3" — a release
  do repo é tiny (1 commit); veredito thin por design (mesma classe do PostgREST 16.1).
- 27 BullMQ: o recovery raiz → /releases cai na release MAIS RECENTE (6.1.1 de 2026-08-14),
  não na tag 6.1.0 exata do título — limitação do recovery raiz; o conteúdo é release
  notes genuíno e verify ok.

---

## 5. kind NULL (65 itens de listings)

### 5.1 Backfill

Script node descartável (importando `stmts` de src/db.js e `kindFromTags` de
src/classify.js — o MESMO caminho de produção do `classifyArticleRow`):

```js
for (a of articles WHERE kind IS NULL):
  tags = stmts.getTagsForArticle.all(a.id)
  kind = kindFromTags(tags)          // release ← content-type ∈ {version-release, release-announcement}
                                      // tool ← isToolByTags; senão news
  stmts.setKindIfNull.run({ id: a.id, kind })   // protege curados; transação por lote
```

Saída:

```
kind NULL articles: 63        ← 65 da captura − 2 deletados no passo 2 (36, 187)
setKindIfNull changes by kind: {"news":32,"tool":22,"release":9}
remaining kind NULL: 0
```

### 5.2 Correção da re-conciliação de kinds (design: curadoria é a autoridade)

**Contexto da correção:** após a re-classificação forçada (passo 6), uma passada extra
re-derivou os kinds de TODOS os artigos (`kindFromTags` sobre as tags finais) — 70 flips,
incluindo kinds da CURADORIA por seção de fontes `index`. Isso desviou do design aprovado:
`setKindIfNull` (WHERE kind IS NULL) — a curadoria é a autoridade e nunca é sobrescrita;
a derivação determinística é SÓ para os itens de listing que nasceram com NULL. O
orquestrador pediu a correção; ela foi feita assim (evidência abaixo).

**Adaptação do predicado (documentada):** o enunciado da correção distinguia
"roundup = `issue_url IS NOT NULL`" vs "listing = `issue_url IS NULL`" — MAS neste banco
**todos os 186 artigos têm `issue_url NOT NULL`** (itens de listing carregam a URL da
listagem no `issue_url`, ex.: `issue_url = "https://llmnews.ai"` nos 60 itens do
llmnews.ai; `"https://aiweekly.co/issues"` nos 3 da AI Weekly). O predicado que separa os
grupos conforme o design é o **kind no backup pré-backfill**:

- backup kind NOT NULL (123) = roundup curado → restaura o kind do backup;
- backup kind NULL (65) = item de listing nascido NULL → mantém o derivado.

Execução (transação, JOIN por id com `~/.newsletter-crawler/crawler.db.bak-2026-08-14`):

```
ANTES (live):   [{"kind":"news","n":42},{"kind":"release","n":59},{"kind":"tool","n":85}]
curados (backup kind NOT NULL): 123 | listings (backup kind NULL): 63   (188 − 2 deletados)
restaurados (kind != backup → UPDATE): 58 | já idênticos (sem UPDATE): 65
DEPOIS (live):  [{"kind":"news","n":88},{"kind":"release","n":54},{"kind":"tool","n":44}]
kind NULL: 0
curados com kind DIFERENTE do backup (deve ser 0): 0
listings ainda NULL (deve ser 0): 0
```

Composição do estado final: curados = backup (61 news + 45 release + 17 tool) +
listings derivados (27 news + 27 tool + 9 release — derivados via `kindFromTags` das
tags FINAIS 2026-08-15; 5 dos 63 mudaram em relação à derivação pré-reclassificação,
porque as tags que os alimentam foram regeneradas no passo 6 — a derivação é
determinística sobre as tags vigentes, comportamento do design). Amostra da regra
(verificação manual):

```
{"id":1,"title":"AI agents crossed the line 19 times in UK saf…","kind":"tool","content_type":["news"],"tools":["guardrails-ai","nvidia-nim"]}
{"id":15,"title":"Bun 1.4's release appears to be imminent","kind":"release","content_type":["version-release"],"tools":["bun"]}
{"id":20,"title":"5 Useful `npx` Helpers","kind":"tool","content_type":["curated-list","tips-and-tricks"],"tools":["npm"]}
{"id":161,"title":"rshono: A Minimal Framework for React Server…","kind":"release","content_type":["product-launch","release-announcement"],"tools":["react","hono"]}
```

---

## 6. Vocabulário — taxonomia 2026-08-15

### 6.1 Re-classificação forçada

```
BUDGET_USD=1 npm run finish -- --no-verify --no-summarize --force
```

Log (`/tmp/step6-reclassify.log`):

```
classify: 186 artigo(s) — model=deepseek/deepseek-v4-flash-0731, 9 facetas/artigo, force=true.
… (1682 chamadas em ~17 min)
classify concluído: 186/186 (partial=9).
extrato do run #6 (finish): 1682 chamadas, US$ 0.4501 de US$ 1.00 (done)
```

### 6.2 Prova: taxonomy_version

```
by taxonomy_version: [{"taxonomy_version":"2026-08-15","n":186}]   ← 100% do acervo
by status: [{"status":"done","n":177},{"status":"partial","n":9}]  ← partials PRESERVADOS
classifications missing (should be 0): 0
```

### 6.3 Prova: quedas "descartou" — só facet-mismatch; os 5 termos novos nunca caíram

`grep "descartou"` no log: **33 ocorrências no total**. Todas de duas classes aceitas:
(1) termos realmente fora do vocabulário daquela faceta (ex.: `type-level-programming`,
`inngest`, `knowledge-graph`, `mcp-server`, `huggingface-transformers`); (2) **facet-mismatch**
— o modelo propôs um termo VÁLIDO na faceta ERRADA. As únicas 3 quedas envolvendo os
5 termos novos são EXATAMENTE facet-mismatch:

```
WARN classify[framework-library-tool] descartou 1 tag(s) fora do vocab: llm-models     ← pertence a topic-technology/domain
WARN classify[concept-theme] descartou 1 tag(s) fora do vocab: agentic-ai             ← pertence a topic-technology/trending-emerging
WARN classify[concept-theme] descartou 2 tag(s) fora do vocab: llm-models, ai-general ← idem
```

**Zero quedas dos 5 termos na faceta `topic-technology`** (onde pertencem). E os termos
FORAM usados — distribuição real em `article_tags`:

```
llm-models          → domain 38× + topic-technology 24×  = 62
agentic-ai          → topic-technology 30× + trending-emerging 28× = 58
software-development→ topic-technology 13×
system-design       → topic-technology 3×
model-provenance    → topic-technology 1×
```

Observação: `llm-models`/`agentic-ai` também existem nos vocabulários de `domain` e
`trending-emerging` (38×/28×) — por isso as quedas em concept-theme/framework-library-tool
não perdem a tag: o modelo a propôs lá em faceta errada, mas a faceta certa registrou.

### 6.4 Defensive parse (P2) no re-run

`grep -c "JSON inválido do LLM" /tmp/step6-reclassify.log` → **8** (retry convergiu em
todas — 0 "falhou"); `grep -c "fora do schema"` → **0** (retry do zod não precisou
disparar). Nenhum artigo perdido: 186/186 concluído, 0 classificações faltando.

---

## 7. reclean dos suspects restantes

```
BUDGET_USD=1 node src/index.js reclean --limit 20        ← comando REAL (não existe npm run reclean;
                                                            reclean/reextract são comandos CLI diretos)
```

Log (`/tmp/step7-reclean.log`):

```
reclean: 20 suspect(s) — limpeza forte (Pro) + re-verify.
reclean concluído: 7 re-limpo(s), 10 viraram ok.
extrato do run #7 (reclean): 41 chamadas, US$ 0.0270 de US$ 1.00 (done)
```

Eventos `clean/reclean` (passe forte removeu molduras/lixo) + `verify` do run 7:

| URL | clean | verify final |
|---|---|---|
| mccue.dev (Life Altering Postgresql Patterns) | 4 spans / 1328 removidos | suspect (kind) |
| denodell.com (Your SPA is Leaking Memory) | 1 span / 101 | suspect (kind) |
| youtube 6lSH1 (Own the RSC Pipeline) | 1 span / 14 | suspect (raso) |
| github swift-node 0.1.2 | 1 span / 33 | **ok** |
| master.dev (Five CSS Properties) | 2 spans / 364 | **ok** |
| github vitest 5.0 RC | 1 span / 75 | **ok** |
| motion.dev (Motion 13.1) | 6 spans / 463 | **ok** |
| freecodecamp (Dual-Write) | – | **ok** |
| PostgREST 16.0 | – | **ok** |
| devalue 5.9 | – | **ok** |
| smashingmagazine (How Baseline) | – | **ok** |
| tylersticka (CSS Text-Stroke) | – | **ok** |
| gtkx-org/gtkx (GTKX 1.0) | – | **ok** |
| youtube PypMPaW0wu4 (React Native Tools) | – | **junk** (só título do vídeo) |

Estado final: **suspect 30 → 15** (10 ok + 1 junk; 6 ficaram de fora do `--limit 20`).
Suspects remanescentes (15) são, em maioria, casos aceitos por design: conteúdo raso de
YouTube/X (89, 104, 122), blurb-only (160 Plate, 104), kind contestável (16, 17, 51, 68,
107, 138, 179), contador/conferência (142, 144), SWR genérico (145), perfil X (182).

## 8. Contagens finais (pós-backfill completo)

```
articles: 186   (era 188; −2 abaixo do piso)
verificação: ok=169 suspect=15 junk=2
kinds: news=88 release=54 tool=44   (0 NULL) — curados (123) == backup; listings (63) derivados
taxonomy_version: 2026-08-15 em 186/186 classifications (done=177 partial=9)
resumos: 0 pendentes · verify: 0 pendentes · classify: 0 pendentes · frontier: done=211
runs: 1 crawl (US$ 0.8559) · 2 finish-summarize (US$ 0.0033) · 3–5 reextract (US$ 0.0019)
      6 finish-classify force (US$ 0.4501) · 7 reclean (US$ 0.0270) · +1 verificação direta (US$ 0.0001)
custo TOTAL do ledger: US$ 1.3382 em 4112 chamadas
custo DESTA re-verificação (runs 2–7 + verificação direta): US$ 0.4823   ← dentro do teto US$ 2
```

## Problemas remanescentes (aceitos por design)

1. **R1 — kinds derivados de tags têm o ruído da classificação (só nos listings)**:
   a derivação determinística se aplica APENAS aos itens de listing que nasceram com
   kind NULL (63 após os 2 deletes). Casos notáveis entre os derivados: "AI agents
   crossed the line 19 times" virou `tool` (tags guardrails-ai/nvidia-nim) e "Critical
   CSS Generator" ficou `news` (o modelo o rotulou tutorial/how-to). Regra fiel ao fix;
   a qualidade do kind derivado é a qualidade das tags. Os kinds da curadoria (123)
   foram restaurados do backup e NÃO têm este ruído (correção §5.2).
2. **R2 — recovery raiz → /releases cai na release MAIS RECENTE**: BullMQ 6.1 (id 27)
   recebeu as notas da 6.1.1 (2026-08-14), não da tag 6.1.0 exata. Conteúdo é release
   notes genuíno (verify ok) — limitação conhecida do recovery.
3. **R3 — suspect thin legítimos**: swift-node 0.1.2 (115 chars, 1 commit) e PostgREST
   16.1 (352 chars) seguem `suspect` com nota "changelog refere-se à faixa…" — veredito
   correto para releases minúsculas; sem ação.
4. **R4 — quedas de vocabulário em faceta errada**: `llm-models` (framework-library-tool,
   concept-theme) e `agentic-ai` (concept-theme) foram PROPOSTOS pelo modelo nas facetas
   onde não pertencem e o guard cortou (facet-mismatch). As tags foram registradas nas
   facetas certas (62×/58×) — comportamento correto do guard; candidato a re-visão do
   prompt de faceta, não do vocabulário.
5. **R5 — 2 junk + 15 suspect permanentes por design**: junk = Reddit arquivado (Next.js
   AMA) + YouTube título-only; suspects = rasos/kind contestável/blurb-only — todos com
   nota de verificação registrada; reclean não muda casos de conteúdo inerentemente raso.
6. **R6 — 6 suspects fora do `--limit 20` do reclean** (não processados): ids 142
   (React Alicante), 144 (reactCon), 145 (SWR 2.5), 160 (Plate), 179 (Denmark oral
   defenses), 182 (ClaudeDevs no X) — todos por design (conteúdo de conferência/raso/
   perfil). Rodar `reclean --limit 20` de novo retoma pelos próximos por id.
7. **R7 — um chamada LLM direta (US$ 0.0001, run_id NULL)** na re-verificação do item 3
   (verifyArticleRow avulso) — fora de run; custo contabilizado no ledger total.

---

## Anexo — arquivos de evidência

- `/tmp/step1-resummarize.log` — re-summarize dos 11 chineses (guarda CJK + re-try)
- `/tmp/step4-reextract-{smol,bullmq,swift}.log` — reextract dos 3 repos do GitHub
- `/tmp/step6-reclassify.log` — re-classificação forçada (186 artigos, 1682 chamadas)
- `/tmp/step7-reclean.log` — reclean forte dos suspects (run 7)
- `/tmp/final-inspect.log` — `npm run inspect` final (run 1, 186 artigos)
- Logs do NC_HOME: `~/.newsletter-crawler/logs/{finish-*,reextract-*,reclean-*}` (runs 2–7)
- Backup pré-backfill: `~/.newsletter-crawler/crawler.db.bak-2026-08-14`
