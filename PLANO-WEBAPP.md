# PLANO-WEBAPP — newsletter-crawler Web App (Vercel · sem backend · IndexedDB · Atomic Design)

> Plano de execução para outro modelo do Claude Code. Gerado em 2026-07-02 na branch `development`,
> após pesquisa profunda (fontes no §18) e decisões travadas com o usuário (§1).

## 0. Instruções ao modelo executor

- Leia `AGENTS.md` e `.agents/skills/catalog.md` antes de começar. O CLI existente **não pode quebrar**: o webapp nasce em `webapp/` (pasta nova); a única mudança no CLI é a fase F9 (export dump).
- Execute as fases **na ordem** (F0→F10). Cada fase tem *Definition of Done* (DoD) testável — não avance com DoD falhando.
- Referências `arquivo:linha` apontam para o código ATUAL do repo — são a fonte da verdade para portar lógica. Quando o plano diz "verbatim", copie a lógica preservando comentários/semântica, adaptando só imports/tipos.
- Itens marcados **[VERIFICAR EM RUNTIME]** são suposições a validar com um teste rápido antes de assumir.

## 1. Contexto e objetivo

**Hoje:** crawler CLI Node.js puro (ESM, sem build) com SQLite (`better-sqlite3`), Playwright, LLM via OpenRouter (DeepSeek V4 Pro/Flash), pipeline de qualidade (curadoria por seção → cadastro-com-blurb → enriquecimento → limpeza por spans → verify/classify/summarize em streaming), e um buscador local zero-build (`src/web.js` + `src/web-ui/`).

**O que será construído:** um **web app estático na Vercel** onde o usuário:
1. **Cadastra newsletters** pela interface (hoje: `ncrawl add`/TUI).
2. **Roda o crawl NO NAVEGADOR** e **vê os processos acontecendo ao vivo** (fila → fetch → curadoria IA → enriquecimento → verificação), estilo GitHub Actions.
3. Usa um layout reorganizado em **Atomic Design** (mantendo a identidade visual do web-ui atual).
4. Tem **tudo em IndexedDB** (local-first) com **download/upload via JSON** — o app não cataloga dados de ninguém ("seus dados ficam no seu dispositivo").

**Decisões travadas com o usuário (2026-07-02):**
| # | Decisão | Escolha |
|---|---------|---------|
| D1 | CORS/fetch de terceiros | **Função proxy stateless na Vercel** (runtime **Node**, não Edge — precisa de checagem DNS/IP anti-SSRF); único código server-side; sem banco, sem logs de URL |
| D2 | IA | **Pipeline completo BYOK** — chave OpenRouter do usuário, salva só no dispositivo; OpenRouter aceita fetch direto do browser (CORS ok) |
| D3 | Stack | **Vite + React 18 + TypeScript** em `webapp/`; Atomic Design |
| D4 | Acervo do CLI | **Importável** — novo `ncrawl export --format dump` (JSON de todas as tabelas) + import no webapp |

**Limitações aceitas (mostrar na UI):**
- Sem Playwright → páginas JS-gated/anti-bot falham no enriquecimento; a arquitetura "cadastro na curadoria + blurb" já cobre (item nunca se perde, fica `needs_enrich`).
- A aba precisa ficar **aberta e visível** durante um run (timers em aba de fundo são estrangulados p/ ~1s→10s; fetch em voo não é afetado, mas o agendamento sim).
- Chave BYOK exposta a XSS do próprio origin (inevitável em qualquer SPA BYOK) — disclaimers + recomendação de chave dedicada com limite de crédito.
- **Safari apaga storage após 7 dias sem uso do site (ITP)** — mitigação: `navigator.storage.persist()` + nudge recorrente de backup.

## 2. Arquitetura (visão geral)

```
┌───────────────────────── Browser (Vercel static, Vite SPA) ─────────────────────────┐
│ UI React Atomic Design (PT-BR, dark/light por CSS vars)                             │
│  Páginas: Buscador · Fontes · Execução(Processos) · Configurações                   │
│  useLiveQuery (dexie-react-hooks) → TODA lista/painel é reativo ao IndexedDB        │
│ Pipeline TS (porta de src/): frontier→claim→fetch→extract→curate→enrich→clean→      │
│  verify/classify/summarize em streaming · ledger de orçamento · eventos             │
│  ├─ páginas/feeds → GET /api/proxy?url=…   (repasse stateless)                      │
│  └─ LLM → fetch DIRETO https://openrouter.ai/api/v1/chat/completions (BYOK)         │
│ Dexie/IndexedDB: sources, articles, article_tags, frontier, events, runs,           │
│  llm_usage, classifications, selectors, settings                                    │
│ Export/Import JSON (backup local-first) · Web Locks (1 aba) · storage.persist()     │
└──────────────────────────────────────────────────────────────────────────────────────┘
                       │ único código server-side (stateless, SSRF-hardened)
                       ▼
              /api/proxy (Vercel Function, runtime Node)  →  sites/feeds das newsletters
```

**Ingestão em camadas (novo, motivado pela pesquisa):** para cada fonte, tentar **RSS primeiro**
(payload pequeno/estruturado; ex.: `nodeweekly.com/rss/`, `aiweekly.co/issues.rss`, `tldr.tech/api/rss/tech`)
com autodetect de `<link rel="alternate" type="application/rss+xml">`; fallback = fluxo atual de
listagem HTML com seletores IA. RSS TAMBÉM passa pelo proxy (feeds raramente mandam CORS).
**[VERIFICAR EM RUNTIME]** se o `content:encoded` do feed traz a issue completa (Cooper Press
costuma trazer) — se sim, a curadoria roda direto do feed sem fetch extra da issue.

## 3. Stack e dependências exatas

```
webapp/package.json (novas):
  react ^18.3, react-dom ^18.3, typescript ~5.x, vite ^6
  dexie ^4.4, dexie-react-hooks ^4.4, dexie-export-import ^4
  zod ^4 (mesma major do repo), @mozilla/readability ^0.6, turndown ^7.2,
  normalize-url ^9, p-limit ^7, @noble/hashes ^1 (sha256 SÍNCRONO — ver §4)
api/ (função Vercel, package raiz do deploy):
  request-filtering-agent (anti-SSRF no fetch do proxy)
Dev: vitest, fake-indexeddb, happy-dom (DOMParser nos testes)
```
Proibições herdadas do repo: **nunca `axios`**; logs pelo logger portado (não `console.*` espalhado).

## 4. Mapa de portabilidade (src/ → webapp/src/core/)

Legenda: **A** = verbatim · **B** = shim pequeno · **C** = substituir.

| Módulo | Classe | Destino | O que muda |
|---|---|---|---|
| `util.js` | B | `core/util.ts` | **`sha256` (util.js:21) é síncrono via node:crypto e é chamado sincronamente dentro do pipeline** → usar `@noble/hashes/sha256` + `bytesToHex` (sync) p/ NÃO propagar async. `normalizeUrl` (pacote `normalize-url`, browser-safe), `parseDate:30`, `hostOf:48`, `domainSig:60`, `slugify:76`, `foldText:91`: verbatim. `setLogSink/log/warn/errorLog/debug:103-125`: manter — **setLogSink é a ponte p/ o feed da UI**; `process.env.DEBUG`→flag em settings |
| `parse-core.js` | A/C | `core/extract.ts` | **Verbatim (puras)**: `capHtml:18`, `looksLikeHtml:133`, `decodeEntities:141`, `ensurePlainText:180` (trocando só o backend DOM de `htmlFragmentToText:161`), `isBlockedPage:207`+`BLOCKED_PATTERNS:190`, `applyJunkSpans:280`, `sanityCheckCleaned:310`. **Trocar JSDOM/cheerio→DOMParser**: `extractArticle:29` (Readability sobre `new DOMParser().parseFromString(html,'text/html')`; passar `{maxElemsToParse: 50_000, charThreshold: 500}`), `linksInHtml:72`, `pruneForLLM:96` (manter keep-set `{href,class,id}`:99), `extractPublishedDate:239` (JSON-LD `@graph`→meta→`time[datetime]`), `fallbackTitle:265`. `htmlToMarkdown:110` (turndown): verbatim. **ORDEM CRÍTICA: extrair data/links do doc ANTES de `new Readability(doc).parse()` — Readability MUTA o doc (remove script/meta/time). Doc descartável por página → sem clone, mas 1 parse por consumidor OU parsear 2×** |
| `clean.js` | C | — | Era fachada do worker-pool (SIGSEGV de JSDOM). No browser não existe: usar chamadas diretas. **DOMParser NÃO existe em Web Worker** — parse no main thread com `capHtml` (2MB) + `await scheduler.yield()` entre páginas (polyfill `scheduler-polyfill` p/ não-Chromium) |
| `curate.js` | B | `core/curate.ts` | **Verbatim**: `SPONSOR_RE:19`, `JOB_RE:20`, `GENERIC_ANCHOR_RE:23`, `SECTION_WORDS:55`, `isRealRecoveredItem:27`, `chunkMarkdown:35`, `sectionTitleOf:59`, `splitIntoSections:91` (MAX_SECTIONS=12:90), `consolidateItems:123`. Reescrever persistência de `curateRoundup:171`: o batch db.transaction:296-336 vira `db.transaction('rw', db.articles, db.frontier, db.events, ...)` Dexie, mantendo fan-out por seção (`Promise.allSettled`:183) e passe de cobertura (`curateLeftoverLinks`:238) |
| `budget.js` | A | `core/budget.ts` | **`BudgetLedger` (classe :26) é pura e injetável — portar verbatim** (reserve:72, commit/cancel:91-123 — commit ANTES do parse, EMA:107, estimate:43, shouldStop:51, snapshot:125; seeds SEED_FLASH=0.005/SEED_PRO=0.05/RESERVE_CAP=0.25/EMA_ALPHA=0.2 :12-15). Trocar SÓ o wiring (:137-240): `persistRow`→`db.llm_usage.add`, `beginRun:157`/`endRun:189`→`db.runs` |
| `governor.js` | C | **deletar** | `getLane`→gates `p-limit` fixos (`LLM_POOL=4`, `FETCH_POOL=3` — browser já limita 6 conexões/host); `stageWindow(o)`→`min(o||∞, LLM_POOL)`; `reportRateLimit`→backoff compartilhado 429 |
| `llm.js` | C | `core/llm.ts` | SDK `openai`→**fetch puro** (§7). Porta: retry/escalação Flash→Pro, `tryParseJSON:114` defensivo, guard effort `max`→`xhigh`, reserve→commit, 429 penalty `:49-63` |
| `verify.js` | B | `core/verify.ts` | `verifyArticleRow:21` verbatim; `verifyPending:48`/`recleanSuspects:103` sobre Dexie |
| `classify.js` | B | `core/classify.ts` | `classifyOne:17` verbatim (fan-out 9 facetas fail-open; re-lança BUDGET_EXCEEDED ANTES de persistir); `persist:77`→transação Dexie (classifications + article_tags + uncovered) |
| `summarize.js` | B | `core/summarize.ts` | `summarizeArticleRow:17` verbatim |
| `crawl.js` | C | `core/pipeline.ts` | Orquestração porta (§8); I/O: fetch→proxy, stmts→Dexie |
| `fetch.js` | C | `core/fetch.ts` | `fetchSmart`→fetch via `/api/proxy` com `AbortSignal.any([AbortSignal.timeout(ms), runAbort])`. **Verbatim**: `createBreaker:49` e `createHostGate:105` (factories puras — politeness continua valendo p/ os sites). `looksEmpty:301`→DOMParser (sem render fallback: falhou = blurb) |
| `selectors.js` | B | `core/selectors.ts` | cheerio→DOMParser em `applyLinkSelector:29`, `dateFromSpec:62`, `dateNearLink:120`, `applyLinkSelectorWithDates:154`, `validateLinkSelector:166`, `applyContentSelector:177`, `validateContentSelector:189` (+`TEXT_DATE_RE:42`); cache em Dexie `selectors` |
| `taxonomy.js` | A | `core/taxonomy.ts` | Verbatim; `loadTaxonomy`→`import taxonomy from '../data/taxonomy.json'` (copiar `config/taxonomy.json`) |
| `web.js` | C | **deletar** | Shapes de `apiMeta:142`/`apiArticles:124`/`apiArticle:135` viram o contrato das queries (§9) |
| `config.js` | C | `core/config.ts` | Constantes + `models.json` como import; env→tabela `settings` |
| `substack.js` | B | `core/substack.ts` | API JSON via proxy |

## 5. Camada de dados — Dexie 4.x

`webapp/src/core/db.ts`:

```ts
import Dexie, { type Table } from 'dexie';
export class NCDB extends Dexie {
  sources!: Table<Source, number>; articles!: Table<Article, number>;
  articleTags!: Table<ArticleTag>; frontier!: Table<FrontierJob, number>;
  runs!: Table<Run, number>; events!: Table<Ev, number>;
  llmUsage!: Table<LlmUsage, number>; classifications!: Table<Classification>;
  uncovered!: Table<Uncovered, number>; selectors!: Table<SelectorCache, number>;
  pages!: Table<Page, number>; settings!: Table<Setting, string>;
  constructor() { super('newsletter-crawler');
    this.version(1).stores({
      sources:   '++id, &base_url, type',
      pages:     '++id, &url, source_id',
      articles:  '++id, &url, &content_hash, source_id, run_id, kind, verify_status, needs_enrich, published_at',
      selectors: '++id, &template_sig',
      frontier:  '++id, &url, state, kind, source_id, [state+kind]',
      runs:      '++id, status',
      classifications: '&article_id',
      articleTags: '[article_id+facet+tag], [facet+tag], article_id',
      uncovered: '++id, article_id',
      llmUsage:  '++id, run_id, stage',
      events:    '++id, run_id, url, [stage+status]',
      settings:  '&key',            // apiKey, budgetUsd, pools, flags, tema
    });
  }
}
```

- Tipos TS espelham o schema SQLite (db.js:29-205); campos não-indexados vivem no objeto
  (articles: title, content, title_pt, summary_pt, issue_url, section, blurb, content_source,
  cleaned, verify_notes, extracted_at). Migrations futuras: `version(2).stores().upgrade(tx)` —
  Dexie aplica só o delta.
- Helpers que substituem funções SQL custom: `fold()` = `foldText` (db.js:19) e `isoDate()` =
  `parseDate→YYYY-MM-DD` (db.js:24).
- **Reatividade:** `useLiveQuery` em TODAS as listas/painéis — observa mudanças via Dexie
  inclusive de outras abas. É o motor da tela de processos.
- **Durabilidade:** `navigator.storage.persist()` na primeira gravação relevante; mostrar
  `estimate()` em Configurações; **nudge de backup** (Safari ITP apaga após 7 dias sem uso).
- **Frontier**: manter estados `pending→in_progress→done|failed` p/ retomabilidade entre reloads
  (`resetInProgress()` no boot); claim ordena `retries ASC, id ASC` (falha vai p/ trás — anti hot-loop).

## 6. Export / Import JSON (backup local-first)

- **Motor:** `dexie-export-import` (streaming por chunks, progressCallback p/ barra de progresso) —
  NÃO hand-rolled (JSON.stringify de 10k rows trava o main thread). Envelope próprio por fora:
  `{ app:'newsletter-crawler-webapp', appVersion, schemaVersion:1, exportedAt, dexie:<blob interno> }`.
  Validação de import com zod: rejeitar `schemaVersion` maior; migrar menores. Opções merge/substituir.
  **NUNCA incluir `settings.apiKey` no export** (filter do addon).
- **UX:** botão "Baixar acervo (.json)" (Blob + `a[download]`, nome `acervo-YYYY-MM-DD.json`) e
  zona de import (`input[type=file]` + drag-drop com `preventDefault` no dragover).
- **Gotcha conhecido:** o parser interno (clarinet) tem limite de buffer por token (~1MB por campo)
  — ok p/ artigos (corpo << 1MB), documentar; fork `@mitchemmc/dexie-export-import` se estourar.
- **Import do CLI (D4/F9):** novo `ncrawl export --format dump` no CLI grava `dump.json` com
  `{ app:'newsletter-crawler-cli', schemaVersion:1, tables:{ sources, articles, article_tags,
  classifications, runs, llm_usage } }` (SELECT * de cada tabela via `stmts`; events opcional
  `--with-events`). No webapp, o import detecta `app==='newsletter-crawler-cli'` e converte
  (mapeamento 1:1 de colunas; `article_tags`→`articleTags`).

## 7. Camada LLM no browser (BYOK · fetch puro)

`webapp/src/core/llm.ts` — substitui o SDK `openai` (llm.js:18-28):

- `POST https://openrouter.ai/api/v1/chat/completions` (CORS habilitado — confirmado) com
  `Authorization: Bearer <settings.apiKey>`, `HTTP-Referer: <origin do app>`, `X-Title: 'NewsletterArchiver'`
  (opcionais, só atribuição), `Content-Type: application/json`.
- Body: `{ model, reasoning:{effort}, response_format:{type:'json_schema', json_schema:{name, strict:true, schema}}, messages }`.
  **NÃO enviar `usage:{include:true}` — deprecado; o custo agora vem AUTOMÁTICO em `resp.usage.cost`**
  (mudança vs llm.js:77). **Strict json_schema NÃO é garantido p/ DeepSeek via OpenRouter** — a
  garantia real continua sendo o pipeline atual: zod + `tryParseJSON` defensivo (llm.js:114-133:
  parse direto → regex `{...}`) + retry re-amostrando + **escalação Flash→Pro na última tentativa**
  (llm.js:158-171). **[VERIFICAR EM RUNTIME]** `supported_parameters` do modelo; fallback:
  `response_format:{type:'json_object'}` + schema embutido no prompt.
- Guard de effort: `'max'→'xhigh'` (DeepSeek V4 rejeita `max` com 400; llm.js:139-146) — enviar
  SÓ `reasoning:{effort}`, nunca `reasoning_effort`.
- **Fluxo reserve→commit** (portar llm.js:65-90): gate p-limit(LLM_POOL) → `awaitPenalty()` →
  `ledger.reserve(stage, model)` (lança `BudgetExceededError`) → fetch com
  `AbortSignal.timeout(180_000)` → **`resv.commit({model: resp.model, usage: resp.usage})` ANTES
  do parse** (200 malformado já custou) → catch transporte: `resv.cancel()`.
- **429**: portar `bumpPenalty/awaitPenalty` (llm.js:49-63) honrando `Retry-After`, backoff
  exponencial + jitter cap 60s, 3 tentativas; halve-and-recover no pool (AIMD client-side).
- **Estágios** (prompts/schemas copiados de llm.js; modelo·effort de `config/models.json`, que
  vira `webapp/src/data/models.json`):

| Estágio | llm.js | Modelo·Effort | Schema |
|---|---|---|---|
| curateRoundupItems | :416 | flash·high | `{issue_date, items:[{url,title,kind,section,blurb}]}` (curateSchema:365; zod clampa kind→news) |
| curateLeftoverLinks | :458 | flash·high | idem (cobertura) |
| cleanArticleContent | :512 | articleClean flash·medium / articleReclean pro·high | `{title, junk_spans:[], published_at}` |
| verifyRecordLLM | :556 | flash·high | `{verdict, problems}` (clampa→suspect) |
| classifyFacet | :648 | por-faceta (`classifyFacetModel` config.js:269; difficulty/content-type/trending→flash·high) | `{tags, uncovered, confidence}` |
| summarizeArticle | :672 | flash·high | `{title_pt, summary_pt}` |
| extractArticleViaLLM | :343 | pro·xhigh | `{title, content, published_at}` — entrada MARKDOWN |
| deriveLinkSelector | :194 · deriveContentSelector :226 · deriveNextLink :254 · extractLinksItemByItem :289 · extractRoundupLinks :308 | pro·xhigh | (schemas em llm.js:177-338) |
| deriveDateSelector | :602 | flash·high | `{date_selector, date_attribute, date_regex, confidence}` |

- **Chave BYOK (tela Configurações):** input `type=password` + toggle olho + botão "esquecer";
  copy "salva só neste dispositivo — nunca enviada a servidor nosso"; dica de criar chave
  dedicada com limite de crédito no OpenRouter. Armazenar em `settings` (Dexie; segurança
  equivalente a localStorage — mesma exposição XSS, escolha por ergonomia). Enhancement pós-v1:
  botão "Conectar OpenRouter" via OAuth PKCE (`/api/v1/auth/keys`).

## 8. Pipeline no browser (orquestração + lifecycle)

`core/pipeline.ts` — porta de `crawlRun` (commands.js:146-391) sem governor:

```
navigator.locks.request('crawl-run', {mode:'exclusive', ifAvailable:true}, run)  // 1 aba só
resetInProgress(); run = beginRun({command:'crawl', budgetUsd})
para cada fonte selecionada: upsert + enqueue(seed,'listing') + refreshListing() + requeueNeedsEnrich()
loop:
  while !ledger.shouldStop() && inflight.size < FETCH_POOL:
      job = claimNextArticle()            // frontier [state+kind]==['pending','article'], retries ASC
      dispatch(job, inflight, 90_000)
  while !ledger.shouldStop() && curating.size < CURATE_POOL:
      job = claimNextCurate()             // kind != 'article'
      dispatch(job, curating, 0)
  if all empty && streaming empty: break
  await Promise.race([...inflight, ...curating, ...streaming])
endRun() + sweeps finais (verifyPending/classifyPending/summarizePending)
```

- `dispatch` (commands.js:285-322): sucesso→`finish('done')` + `streamPostSave(url)` (verify+
  summarize+classify na folga do gate llm, set `streaming` à parte, cada um idempotente e
  engolindo erro/BUDGET_EXCEEDED); `BUDGET_EXCEEDED`→`finish('pending')` sem consumir retry;
  timeout→ficha `needs_enrich` mantém blurb+done, senão retry até MAX_RETRIES=3.
- `processListing`/`crawlArchive` (crawl.js:103-357): **RSS-first** (novo: se a fonte tem
  `rss_url`, parsear feed via `DOMParser 'text/xml'` → itens com título/link/data prontos; senão)
  seletor cacheado com self-heal → `deriveLinkSelector` Pro → fallback `extractLinksItemByItem`.
  Paradas de paginação idênticas: hash repetido, 0 links, piso `--since`, incremental added===0, sem next.
- `processRoundup` (crawl.js:360-426) → `curateRoundup` (cadastro-na-curadoria; fan-out por
  seção; cobertura por diff de links do HTML BRUTO). `processArticle` (crawl.js:436-672) →
  escada Readability≥400 → seletor → LLM(markdown); guards thin<50/isBlockedPage/piso de data;
  clean por spans; `ensurePlainText` (exceto Readability); dedup content_hash; enrich (título
  curado autoritativo, data-âncora da issue) → `{verifyUrl}`.
- **Lifecycle browser:** `scheduler.yield()` entre páginas/parses (polyfill); Page Visibility →
  banner "mantenha a aba visível" + pausa opcional; `AbortController` do run inteiro (botão
  Parar) combinado por request com `AbortSignal.any`.

## 9. Contrato de queries (substitui a API do web.js)

`core/queries.ts` reproduz sobre Dexie os shapes exatos (a UI do buscador é portada, não redesenhada):
- `getMeta()` → `{totals:{articles,summaries,classified}, cost:{totalUsd,totalCalls,lastRun}, sources:[{id,name,count}], facets:[{name,tags:[{tag,count}]}] (ordem canônica taxonomy), dates:{min,max}}` (web.js:142-183).
- `searchArticles(filtros, {limit=24, offset})` → `{total, items:[cols + tags:{facet:[tag]} + kind: a.kind||(isToolByTags?'tool':'news') + snippet=substr(coalesce(blurb,content),0,280)]}` — replicar `WEB_WHERE` (db.js:215-240): q com `fold()`, fonte, período com `isoDate` fallback extracted_at, facetas AND-de-OR (via `articleTags [facet+tag]` → interseção de Sets de article_id), kind (coluna vence tags), verify.
- `getArticle(id)` → row completa + tags (web.js:135-140).

## 10. Estrutura de pastas (Atomic Design pragmático)

Atomic SÓ para componentes visuais; lógica em pastas irmãs (regra anti-bikeshedding:
átomo = 1 elemento; molécula = poucos átomos com 1 trabalho; organismo = seção autônoma):

```
webapp/
  index.html · vite.config.ts · tsconfig.json
  src/
    main.tsx · App.tsx (router leve por estado/hash — 4 páginas)
    styles/ tokens.css (3 camadas: primitivos → semânticos → componente; portar as vars
            de web-ui/styles.css:7-84, dark via [data-theme] sobrescrevendo SEMÂNTICOS;
            script pré-paint do index.html:9-16 portado) · globals.css
    data/   taxonomy.json · models.json (copiados de config/)
    core/   db.ts · util.ts · extract.ts · curate.ts · budget.ts · llm.ts · fetch.ts ·
            selectors.ts · verify.ts · classify.ts · summarize.ts · pipeline.ts ·
            queries.ts · exportImport.ts · rss.ts · substack.ts · config.ts
    hooks/  useSettings.ts · useCrawlRun.ts · useSearch.ts · useMeta.ts (todos via useLiveQuery)
    components/
      atoms/      Badge/ StatusDot/ Spinner/ ProgressBar/ Button/ IconButton/ Input/
                  Select/ Chip/ Tag/ ThemeToggle/ Icon/           ← port de app.js:102-159,189-202
      molecules/  SearchBar/ Segmented/ FormField/ StatCounter/ LogLine/ ItemStatusRow/
                  FacetGroup/ CostBadge/ DateRange/ KeyInput/     ← port de app.js:146-185 + novos
      organisms/  TopBar/ FilterBar/ ArticleGrid/ ArticleCard/ DetailSheet/ FacetPanel/
                  SourceForm/ SourceList/ PipelineBoard/ CrawlEventFeed/ ItemTimeline/
                  BudgetBar/ ExportImportPanel/
      templates/  SearchTemplate/ SourcesTemplate/ RunTemplate/ SettingsTemplate/
    pages/  SearchPage/ SourcesPage/ RunPage/ SettingsPage/
  api/ proxy.ts (função Vercel, runtime Node)
  vercel.json
```

Portes diretos do web-ui atual (manter UX): STR PT-BR + FACET_LABEL (app.js:12-64),
useDebounced 250ms (:75), bestDate (:94), infinite scroll com IntersectionObserver sentinel
(:372-380, rootMargin 600px), AbortController nas buscas, tema sem flash, sheet mobile
(styles.css:502-590), reduced-motion (:592).

## 11. Páginas

1. **Buscador (`SearchPage`)** — paridade com o web-ui atual (busca fold, segmented all/news/tool,
   filtro fonte/verify/período/facetas, badges kind+verify, DetailSheet, custo no topo) sobre
   `queries.ts`.
2. **Fontes (`SourcesPage`)** — lista com contagem/último crawl; `SourceForm`: url, nome,
   type index|listing, max_index_pages, rss_url (autodetect ao colar url: fetch via proxy da
   home → `link[rel=alternate]`); ações: crawl desta fonte, purge (apaga dados, mantém cadastro
   — semântica de `cmdPurge`), excluir.
3. **Execução (`RunPage`)** — controles (fontes, `--since`, orçamento US$, máx artigos; Iniciar/
   Parar) + visualização ao vivo (§12).
4. **Configurações (`SettingsPage`)** — chave BYOK (§7), pools/limites, uso de storage
   (`estimate()`) + `persist()`, export/import (§6), zona de perigo (reset), disclaimers.

## 12. Visualização de processos ao vivo (o "inspect" visual)

Motor: `events` + `llm_usage` + `runs` + contadores do frontier via `useLiveQuery` (o pipeline
grava; a UI reage — zero plumbing extra). Vocabulário completo `(stage:status)` mapeado do código:
`dateSelector: ok|invalid · archive: ok · fetch: ok|fail · roundup: ok|skip · curate: ok|fail|coverage|skip · enrich: ok|kept-blurb · article: skip|split · clean: ok|reject|fail|reclean · save: ok · item: saved|dup|skipped · job: timeout · verify: ok|suspect|junk`.

Composição (estética GitHub Actions/Databricks):
- `PipelineBoard` (organismo): colunas Fila→Fetch→Curadoria→Enriquecimento→Limpeza→Verificação
  com `StatCounter` ao vivo (frontier por estado + counts de events) e `StatusDot` verde/âmbar/vermelho.
- `CrawlEventFeed`: stream append-only (últimos N=200), cor por status, filtro por stage/status/url,
  auto-scroll com pausa on-hover.
- `ItemTimeline`: clicou num item → `events.where('url')` ordenado = linha do tempo da ficha
  (equivalente ao `ncrawl inspect --url X --verbose`).
- `BudgetBar` + `CostBadge`: `ledger.snapshot()` (spent/reserved/calls/byStage) + soma `llm_usage`
  — custo em tempo real, por etapa.
- Estados do run: running/done/budget-stopped/aborted (tabela `runs.status`).

## 13. Proxy stateless (`api/proxy.ts` — runtime **Node**, não Edge)

Edge não tem `dns`/`net` → não faz checagem IP anti-SSRF; Node runtime permite `request-filtering-agent`.

```ts
// GET /api/proxy?url=<http(s) absoluto>   — stateless, sem log de URL
import { useAgent } from 'request-filtering-agent'; // bloqueia IP privado/loopback/link-local/metadata
export default async function handler(req, res) {
  // 1. Origin check: só o próprio deploy (process.env.VERCEL_URL / lista) — 403 caso contrário
  // 2. Método GET only; url= obrigatório; scheme http|https only (rejeitar file:, data:, gopher:)
  // 3. fetch com agent SSRF-filtered (http E https p/ sobreviver redirect cross-protocol),
  //    redirect: 'manual' + re-validar CADA hop (máx 5), AbortSignal.timeout(10_000)
  // 4. Cap de resposta 4MB (stream com contador; aborta acima) — sob o limite de 4.5MB da Vercel
  // 5. NÃO repassar Cookie/Authorization em nenhuma direção; UA de navegador real
  //    (copiar de fetch.js BROWSER_HEADERS) + Accept/Accept-Language
  // 6. Devolver status/content-type upstream + Access-Control-Allow-Origin: <origin do app>
  //    + Cache-Control: no-store
}
export const config = { maxDuration: 15 };
```

Checklist SSRF (OWASP + bypasses conhecidos): resolver DNS e validar IP FINAL (não a string);
bloquear 127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16 (metadata!), fc00::/7, NAT64
64:ff9b::/96; pin do IP validado (anti DNS-rebinding — o request-filtering-agent cobre);
re-validação por redirect. `vercel.json`:

```json
{ "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" } ] }
```

Deploy: projeto Vercel com **Root Directory = `webapp/`** (framework preset Vite auto).

## 14. Fases de execução (com DoD)

**F0 — Scaffold.** `webapp/` com Vite+React+TS, tokens.css portado, vercel.json, páginas vazias
com TopBar/tema. *DoD:* `npm run dev` abre com tema dark/light sem flash; `vercel build` local ok.

**F1 — Dados.** `db.ts` (schema §5) + tipos + helpers fold/isoDate + `settings` + persist().
*DoD:* testes vitest+fake-indexeddb de CRUD e índice composto `[state+kind]` verdes.

**F2 — Core puro portado.** `util.ts` (sha256 noble sync!), `extract.ts`, `curate.ts` (puras),
`taxonomy.ts`, `budget.ts`. **Portar também os testes**: `test/clean.ensurePlainText.test.js`,
`test/clean.sanityCleaned.test.js`, `test/clean.isBlockedPage.test.js`, `test/curate.consolidate.test.js`,
`test/budget.test.js`, `test/util.parseDate.test.js`, `test/clean.extractPublishedDate.test.js` →
vitest (happy-dom p/ DOMParser). *DoD:* suíte de paridade 100% verde.

**F3 — Proxy + fetch.** `api/proxy.ts` (§13) + `core/fetch.ts` (breaker/hostgate verbatim) +
`rss.ts` (parse de feed + autodetect). *DoD:* via `vercel dev`, fetch de `nodeweekly.com/rss/`
e de uma página http retorna body; requests p/ `http://169.254.169.254`, `file://` e IP privado
→ 4xx; resposta >4MB abortada.

**F4 — LLM.** `llm.ts` (§7: transport, callJSON, 13 estágios, ledger integrado) + SettingsPage
com KeyInput BYOK. *DoD:* com chave real, 1 chamada `verifyRecordLLM` de amostra retorna verdict
válido e grava custo em `llm_usage`; sem chave, UI explica; effort `max` nunca é enviado.

**F5 — Pipeline.** `pipeline.ts` + `verify/classify/summarize.ts` + `selectors.ts`. *DoD:* run
de fonte de teste com `maxArticles=3` e orçamento US$0.30 completa: itens curados com blurb,
enriquecidos, verificados em streaming; reload no meio retoma (resetInProgress); Web Locks
impede 2ª aba; BUDGET para graciosamente com frontier retomável.

**F6 — Buscador.** `queries.ts` + SearchPage (port do web-ui). *DoD:* paridade com os testes
`test/web.api.test.js` reescritos como testes de `queries.ts` (busca fold, facetas AND-de-OR,
kind coluna-vence-tags, verify filter, release preservado, paginação).

**F7 — Fontes.** SourcesPage + SourceForm (+purge). *DoD:* cadastrar a fonte "AI Weekly" pela
UI, autodetect de RSS preenche rss_url, crawl da fonte dispara da própria página.

**F8 — Execução ao vivo.** RunPage + PipelineBoard/CrawlEventFeed/ItemTimeline/BudgetBar (§12).
*DoD:* durante um run pequeno, contadores/feed/custo se movem ao vivo (useLiveQuery, sem polling
manual); clicar num item mostra a timeline; Parar aborta e o frontier fica retomável.

**F9 — Export/Import + dump do CLI.** `exportImport.ts` (§6) + `ncrawl export --format dump` no
CLI (commands.js `cmdExport:467-496` + stmt novo; seguir `following-code-style`). *DoD:* baixar
acervo → limpar tudo → importar → buscador idêntico; dump do CLI com os 67 artigos atuais
importa no webapp e aparece no buscador; apiKey nunca aparece no arquivo.

**F10 — Deploy + QA.** Deploy Vercel (Root Directory webapp/), smoke em produção com fonte real
pequena, disclaimers/nudges finais, README-WEBAPP.md. *DoD:* URL pública funcional; Lighthouse
sem erro grave; `npm test` do repo (CLI) segue 112+ verde.

## 15. Testes

- **vitest + fake-indexeddb + happy-dom** em `webapp/`. Paridade dos módulos portados (F2) copiando
  os casos de `test/*.test.js`; queries (F6) espelhando `test/web.api.test.js`; export/import
  round-trip; proxy testado via `vercel dev` (integração manual documentada).
- Fluxos pequenos SEMPRE (regra do usuário): `maxArticles<=3`, orçamento <=US$0.30.

## 16. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Safari apaga IndexedDB após 7 dias sem uso (ITP) | persist() + nudge de export recorrente (padrão Excalidraw) |
| DeepSeek sem strict json_schema garantido via OpenRouter | zod + tryParseJSON + retry + escalação Pro (já é a garantia hoje); fallback json_object |
| Cap 4.5MB de resposta na função Vercel | stream + cap próprio de 4MB + capHtml no cliente |
| SSRF no proxy (rebinding, redirect, NAT64, metadata) | request-filtering-agent em http+https, redirect manual re-validado, GET-only, origin check |
| Tab em background estrangula timers | Page Visibility banner + Web Locks + "mantenha visível"; fetch em voo não é afetado |
| clarinet ~1MB/token no export | corpos de artigo << 1MB; documentar; fork @mitchemmc se precisar |
| Chave BYOK exposta a XSS | disclaimers, chave dedicada com limite, forget-key; zero third-party scripts no app |
| Anti-bot sem Playwright | item mantém blurb (needs_enrich) — regressão aceita e comunicada |

## 17. Critérios de aceite globais

1. Fluxo completo SEM terminal: cadastrar fonte → rodar crawl → ver processos ao vivo → buscar
   → exportar JSON → importar em outro navegador.
2. Custo de IA visível em tempo real durante o run (total, por etapa, orçamento restante).
3. Nenhum dado do usuário toca servidor nosso (proxy é repasse; chave só no dispositivo;
   export sem apiKey).
4. Reload/fechar aba no meio de um run NÃO perde nada (frontier retomável, dedup idempotente).
5. Identidade visual do web-ui atual preservada (tokens, dark/light, PT-BR) em Atomic Design.
6. CLI intacto (112+ testes verdes) com a única adição do `export --format dump`.

## 18. Apêndice — fontes da pesquisa (2026-07)

- Dexie 4.x/liveQuery/export-import: dexie.org/docs (Typescript, Dexie.version(), useLiveQuery(),
  ExportImport), pkgpulse.com (dexie vs idb 2026), github.com/dexie discussions #1455/#1554.
- Storage/quotas/eviction: MDN Storage quotas & eviction; WebKit storage policy; Search Engine Land
  (Safari 7-day ITP); RxDB indexeddb-max-storage-limit.
- Vercel: docs Functions Limitations (300s Hobby, payload 4.5MB, streaming), frameworks/vite
  (SPA rewrite), monorepos (Root Directory), Hobby plan (Active CPU não conta I/O wait).
- Proxy/SSRF: OWASP SSRF Prevention in Node.js; github.com/azu/request-filtering-agent;
  Doyensec cross-protocol redirect bypass; HackerOne NAT64 report; HTTP Toolkit "are CORS proxies
  safe"; corsproxy.io pricing (dev-only free); Grokipedia list of free CORS proxies.
- OpenRouter: docs app-attribution (HTTP-Referer/X-Title), guides/oauth (PKCE p/ public clients),
  guides/features/structured-outputs (DeepSeek ausente da lista), cookbook usage-accounting
  (usage.include deprecado — custo automático), api/reference/streaming (SSE, comments keep-alive),
  zendesk rate-limits (Retry-After, backoff+jitter); blog.kowalczyk.info (CORS browser confirmado).
- Readability/DOM: github.com/mozilla/readability README (parse() MUTA o doc; maxElemsToParse,
  charThreshold; issue #964), MDN DOMParser (inexistente em Workers; whatwg/dom#1217),
  Chrome scheduler.yield, MDN Web Locks / Page Visibility / AbortSignal.timeout,
  npm p-limit (ESM zero-dep).
- Atomic Design: atomicdesign.bradfrost.com cap.2; codebrahma/danilowoz react-atomic-design;
  propelius.tech best practices; dev.to "Atomic Design em 2025" (atomic p/ UI, lógica fora);
  penpot design tokens (primitivo→semântico→componente).
- Local-first UX: Local-First Academy (Excalidraw), tldraw persistence/snapshots, Actual Budget FAQ.
- RSS: nodeweekly.com/rss/, aiweekly.co/issues.rss, tldr.tech/api/rss/{tech,ai,...} (confirmados);
  feeds ainda exigem proxy (CORS).
