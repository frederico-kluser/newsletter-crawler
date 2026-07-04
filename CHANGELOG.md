# Changelog

Todas as mudanças relevantes deste projeto. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

Webapp bilíngue (PT/EN) com detecção de idioma e tutorial de introdução no site público.

### Adicionado
- **Idiomas PT/EN no webapp (`webapp/`):** interface bilíngue com **detecção pelo navegador**
  (português → PT; **qualquer outro idioma → EN**) e **seletor manual PT | EN** na barra do topo,
  com a escolha salva no `localStorage`. Camada i18n própria (Context `useStrings` + `DICTS` em
  `webapp/src/strings.js`, **sem `react-i18next`**); regra de detecção pura e testável em
  `webapp/src/lib/locale.js` (subtag primária `pt` → pt, resto → en), espelhada no pré-paint do
  `webapp/index.html`; formatadores de número/moeda/data por locale. `webapp/test/i18n.test.js`
  garante **paridade de chaves** entre os dois idiomas. O conteúdo do acervo (resumos/tags PT-BR)
  **não** é traduzido — só a casca da UI.
- **Tutorial de introdução (onboarding estilo Apple "Welcome"):** modal em etapas
  (`webapp/src/components/Tutorial.jsx`) explicando o que é o app e como funciona; **abre sozinho na
  1ª visita** (`localStorage nc-tutorial-seen`) e **reabre pelo botão de ajuda (?)** na barra do topo.
  Acessível (focus trap, navegação por ←/→/Esc, foco de volta ao gatilho), respeita
  `prefers-reduced-motion` e traz um seletor de idioma dentro do próprio card.
- **Skill `building-the-webapp`:** nova skill em `.agents/skills/` documentando o frontend do webapp
  (stack Vite+React+Motion, tokens de tema, a camada i18n e o tutorial), separada do porte de busca
  (que segue em `searching-the-corpus`).
- **Fontes Substack de domínio próprio (`src/substack.js`):** `isSubstack` agora detecta Substack
  mesmo em domínio PRÓPRIO (ex.: `www.deeplearningweekly.com`) via header `x-served-by: Substack` +
  probe cacheado de `/api/v1/archive` — antes só reconhecia `*.substack.com`. `substackArchive`
  pagina o arquivo JSON com o page size REAL do Substack (**12**; `limit>12` devolve `[]`), filtra o
  áudio `tts`, deduplica e **para cedo no piso `--since`**. Cobre o backfill COMPLETO do arquivo (o
  `/archive` estático traz só ~24 posts, que a heurística `looksEmpty` dava por "cheios"). Testes em
  `test/substack.archive.test.js`.
- **Scroll infinito genérico mais robusto (`src/fetch.js`):** rola o CONTAINER interno correto (div
  com `overflow`) além da janela — `window.scrollBy` não move feeds cujo scroll é num container;
  espera ADAPTATIVA por conteúdo (assenta quando a altura estabiliza, teto `SCROLL_SETTLE_MAX_MS`) no
  lugar do `pause` fixo de 800 ms (que truncava feed lento); `clickLoadMore` re-colhe links ENTRE
  cada clique (feed virtualizado perdia itens) e espera a contagem de `<a>` crescer em vez de
  `networkidle` (que em página com websockets/analytics quase nunca dispara e queimava 8 s).
- **Knobs de scroll/render por env (`src/config.js`, `.env.example`):** `SCROLL_STEP`,
  `SCROLL_SETTLE_MAX_MS`, `SCROLL_ROUNDS`, `SCROLL_ROUNDS_ARTICLE`, `RENDER_LISTING_DEADLINE_MS`,
  `RENDER_ARTICLE_DEADLINE_MS`, `MAX_LOAD_MORE` — antes hard-coded em `RENDER_PROFILES`/`autoScroll`.

### Corrigido
- **`normalizeUrl` colapsava `www.` no ápice (`src/util.js`):** `www.host` e `host` podem ser
  servidores DIFERENTES — vários Substack de domínio próprio (ex.: `deeplearningweekly.com`) NÃO têm
  DNS no ápice, então a URL normalizada dava `ENOTFOUND` e a fonte inteira falhava (a detecção e
  TODO `/p/` enfileirado). Agora `stripWWW: false`, alinhado a `hostOf`/`domainSig` (que já
  preservavam o www). Regressão coberta por `test/util.normalizeUrl.test.js`.

## [1.9.0] - 2026-07-03

Histórico de buscas IA com resultados persistidos — a busca deixou de ser efêmera nas três frentes.

### Adicionado
- **Tabela `searches` (SQLite) + histórico no CLI/TUI/web local:** toda busca IA concluída é salva
  (consulta, modo, escopo, stats e os hits como ids+vereditos LEVES; custo real vem de `llm_usage`
  via `run_id`). `persistSearch` no `runSearch`/`searchWeb`; helpers `listSearchHistory`/
  `getSearchHistoryEntry` (re-hidrata a ficha do acervo, conta ids que sumiram)/`deleteSearchHistory`.
- **Web local (`ncrawl web`):** endpoints `GET /api/searches`, `GET /api/searches/:id` (resultado
  congelado re-hidratado, ZERO LLM), `DELETE /api/searches/:id` e `DELETE /api/searches`; dropdown de
  recentes ao focar o campo + painel **Histórico** (abrir · re-rodar · apagar · limpar tudo). Reabrir
  mostra os cards salvos sem custo; re-rodar restaura o escopo e passa pela confirmação de custo usual.
- **TUI:** tela **Histórico de buscas** (`src/ui/HistoryView.js`) — lista navegável, Enter reabre o
  resultado congelado na ResultsView, `r` re-roda (fluxo de busca pré-preenchido), `d` apaga, `x`×2
  limpa tudo.
- **Webapp estático (`webapp/`):** histórico no NAVEGADOR (localStorage, `webapp/src/lib/history.js`,
  payload versionado `{v:1}`; auto-save SEM limite, poda só se a quota do localStorage estourar —
  fail-open, nunca quebra a busca). Dropdown de recentes no campo + painel Histórico com abrir/re-rodar/
  apagar; o banner marca o resultado restaurado ("salva em …", custo, itens fora do acervo).

## [1.8.0] - 2026-07-03

Publicação do site automatizada: push na main = snapshot fresco + deploy (Vercel Git integration).

### Adicionado
- **Hook `pre-push` versionado (`.githooks/`):** ao pushar a main, re-exporta o snapshot do webapp
  (`export --format web`) a partir do SQLite local e, se houver dado novo, auto-commita
  `webapp/public/data` e interrompe o push (repita o `git push`); a Vercel conectada ao repo
  publica sozinha. Instalação automática via `postinstall` (`git config core.hooksPath .githooks`).
  Guards fail-open: export falhou → push segue; snapshot com MENOS artigos que o commitado
  (máquina sem o banco exportaria um acervo vazio) → restaura sem commitar; mudança só no campo
  volátil `generatedAt` do meta.json → restaura e segue sem ruído.

## [1.7.0] - 2026-07-03

Fontes de fábrica trocadas para 6 newsletters Cooperpress, seleção de fontes por **checkbox** na TUI
(novo `--sources "A,B"`) e overhaul visual da TUI com camada de tema (tokens semânticos).

### Adicionado
- **`--sources "A,B"` no crawl:** lista por vírgula (cada item por **nome exato** ou **URL**, a mesma
  regra do `--source`), com **precedência** sobre `--source`/`--only` (avisa ao ignorá-los) e aviso
  por item sem match (nunca no-op silencioso). Helper puro `filterSeedSources` (`src/commands.js`)
  coberto pela suíte `commands.sources-filter`.
- **Checkbox de fontes na TUI (tela Coletar):** o passo de fonte virou **multi-select** (`MultiSelect`
  do @inkjs/ui, dependência já existente e até então sem uso): **espaço** marca/desmarca, **Enter**
  confirma, **Esc** volta; **todas marcadas por padrão** (Enter direto = coletar tudo, sem flag);
  subconjunto emite `--sources "A,B"`; 0 marcadas → erro inline **sem perder a seleção** (o erro não
  remonta o MultiSelect). Componente `SourcesStep` exportado + suíte `ui.crawl-sources`.
- **Camada de tema da TUI (`src/ui/theme.js`):** tokens semânticos de cor por FUNÇÃO
  (accent/title/ok/warn/err/link/muted), glifos (estado sempre redundante à cor — NO_COLOR legível) e
  `uiTheme` via `extendTheme` recolorindo Select/MultiSelect/Spinner/ProgressBar do @inkjs/ui (foco
  azul default → accent; barra magenta → accent). `ThemeProvider` na raiz do App.
- **Widgets compartilhados (`src/ui/widgets.js`):** `Panel` (borda round; política: só **2**
  superfícies com borda no app — o overlay `v` e o card do comando equivalente no Review — borda é
  significado, não decoração), `FooterHints` (rodapé de atalhos padronizado `tecla verbo · …`, fim
  das 5 strings divergentes) e `Header` (breadcrumb `◆ <tela>`). `useSpinnerFrame` movido p/
  `src/ui/hooks.js` (regra: 1 timer de animação por árvore, sempre `.unref()`).
- **Helper de teste `test/helpers/ink.js`:** navegação do menu por **label** (segue o ponteiro `❯`,
  casando palavra inteira) — `ui.search`/`ui.web` não hard-codam mais DOWN×N nem a ordem do menu.

### Alterado
- **Fontes de fábrica (`config/sources.json` + `~/.newsletter-crawler/sources.json`):** saem
  `The Batch — Research` e `AI Weekly`; entram **Node Weekly, JavaScript Weekly, Frontend Focus,
  React Status, Postgres Weekly e Golang Weekly** (todas Cooperpress `/issues`, `type: "index"`,
  mesma extração já provada no Node Weekly). Sem purga necessária (o acervo só tinha Node Weekly).
  ATENÇÃO: a **1ª coleta** de cada fonte nova enxerga ~600 issues no arquivo — rode com
  `--since`/`--max-articles` p/ controlar custo.
- **Re-skin por tokens em toda a TUI** (StatusBar, Menu, Status, wizards, Review com card, RunView,
  ResultsView, CrawlDashboard) **sem mudança estrutural** no dashboard (fases/feed/ticker intactos;
  `crawlPhases.js`/`runLines.js` puros como antes). Rodapé do dashboard no formato novo
  (`v detalhes · q sai`). StatusScreen ganhou `.unref()` no poll de 1s (não segura o `node --test`).

## [1.6.0] - 2026-07-03

Painel do crawl reprojetado (dashboard "mission control" na TUI) + classificação muito mais barata e
um comando para terminar/retomar o pós-processamento.

### Adicionado
- **Comando `ncrawl finish` (`npm run finish`):** termina os **PENDENTES** (verify+classify+summarize)
  **sem novo crawl**, no perfil `llm-only`, honrando `--budget`/`--parallel`/`--limit` e
  `--no-verify`/`--no-classify`/`--no-summarize`. Delta/idempotente; `--budget` **para no teto e
  devolve os pendentes** (retomável) — dá p/ terminar um backlog grande em fatias com custo
  controlado. Também no menu da TUI → **"Finalizar pendentes"**. Espelha o bloco pós-crawl
  (`cmdFinish` em `src/commands.js`).
- **Backlog pendente visível na TUI:** a **barra de status** do topo, o **item do menu** (Coletar /
  Finalizar) e a **tela Status** agora mostram o que **falta terminar**, separando **"na fila"**
  (ainda não baixado → resolve com **Coletar**) de **"sem tags / sem resumo"** (já salvo → resolve com
  **Finalizar pendentes**). Antes o topo só mostrava os classificados FEITOS, o que escondia o backlog.
- **Painel do crawl (TUI) reprojetado — dashboard "mission control":** uma região de **STATUS
  persistente** (cabeçalho + badge de estado `Preparando→Coletando→Finalizando→Concluído/Falhou` +
  cronômetro, **tabela de fases** Descoberta/Curadoria/Artigos/Pós com `ProgressBar` + contadores,
  linha "agora", % por data, faixa de métricas RAM/lanes/US$) **separada** de um **feed curado de
  eventos** (só marcos). O "salvo" de cada artigo virou **ticker no lugar** (não polui o feed) e o
  ruído interno (parse-pool/governor/breaker) **colapsa** num contador `⚠ N avisos` com toggle **`v`**
  (overlay do log cru). `RunView` virou um dispatcher fino (dashboard no crawl, painel simples nos
  demais comandos). Camada de eventos estruturada nova (`src/run-events.js`) + derivação **pura** das
  fases (`src/ui/crawlPhases.js`). Testes: `run-events`, `crawlPhases`, `ui.crawl-dashboard`,
  `ui.runview`.

### Alterado
- **Custo da classificação cortado ~4× (só config, reversível por env):** classify já foi ~92% do
  gasto de uma coleta longa (9 chamadas/artigo, 6 no **Pro/xhigh** com o corpo inteiro reenviado 9×).
  Agora só as facetas **core** (`domain`, `topic-technology`) seguem no Pro (esforço `xhigh`→`high`);
  as outras 7 em **Flash/medium**, e `CLASSIFY_MAX_CHARS` **12000→2000** (título+início bastam p/ o
  vocabulário fixo). Ajuste por faceta com `LLM_MODEL_CLASSIFY_<FACETA>`/`LLM_EFFORT_CLASSIFY_<FACETA>`.
  O maior salto (classificar em **lote** de artigos por chamada) fica anotado como próximo passo.

### Corrigido
- **Timers de animação da TUI usam `.unref()`:** um `setInterval` de spinner não-unref'd segurava o
  processo vivo e **pendurava o `node --test`** (isolation=process) depois dos testes; o poll de dados
  idem. O Ink já mantém o loop enquanto renderiza, então a animação nunca precisa segurar o processo.

## [1.5.0] - 2026-07-02

Busca 100% IA no buscador web + resultados navegáveis com preview na TUI.

### Adicionado
- **Busca IA na web (`ncrawl web`):** a busca digitada virou IA de ponta a ponta (`POST /api/search`).
  **Soft** (default): 1 chamada Flash `xhigh` por lote de ~40 artigos (título+resumo; fusão tolerante de
  ids — faltou→`none`, inventado→ignorado, duplicado→1º vence). **Profunda** (toggle): 1 chamada por
  artigo (conteúdo até `SEARCH_MAX_CHARS`) com escopo por **fontes (chips) + período** e diálogo de
  confirmação com contagem + custo estimado (média real do `llm_usage` via `estimateStageCallUsd`).
  Guards re-validados no servidor (`428` sem confirmação acima de `SEARCH_MODE_A_CONFIRM`/
  `SEARCH_SOFT_CONFIRM`; `409` p/ busca concorrente — uma por processo, o run do ledger é global);
  resultados no mesmo grid com selo **Direta/Similar** + fonte, Segmented filtrando por `judge_kind`;
  teto `SEARCH_WEB_MAX_ITEMS`. Envs novos: `SEARCH_BATCH_SIZE`, `SEARCH_BATCH_CONCURRENCY`,
  `SEARCH_SOFT_CONFIRM`, `SEARCH_WEB_MAX_ITEMS`; stage novo `searchBatch` (flash/xhigh) com a MESMA
  rubrica calibrada por eval do juiz unitário.
- **Modal de key na web:** sem `OPENROUTER_API_KEY`, buscar abre um modal que valida a key na OpenRouter
  (probe) e salva em `~/.newsletter-crawler/.env` com **efeito imediato** — a key virou live binding ESM
  (`export let` + `setRuntimeKey`) e o client do `llm.js` se recria quando ela muda; `ncrawl key set`
  também ativa na hora no mesmo processo.
- **TUI — resultados navegáveis com preview:** ↑/↓ selecionam (fonte·data por item), **Enter** abre a
  preview (conteúdo completo do artigo, rolável, via `webGetArticle`), **`o`** abre o link no navegador,
  Esc/b volta, q sai — um único `useInput` ramificando lista|preview. O confirm do modo A mostra a
  contagem **do escopo real** + ~US$ e oferece o acervo todo quando o delta está vazio.
- **Filtro `kind=release`** no browse da web (release segue contando como tool no bucket amplo) e a opção
  **Releases** no Segmented.
- **Testes:** `web.search` (deps fake: 428/409/413/NO_KEY/serialização/enriquecimento), `search.batch`
  (lote + fusão + clamps zod), `config.key` (live binding), `ui.results` (seleção, preview, abrir link
  via spy) + `web.api` atualizado. 150 no total, verdes.

### Corrigido
- **Escopo da busca valia só no guard:** `cmdSearch` não repassava `all`/`runId` ao motor — toda busca
  varria o acervo inteiro, ignorando o passo "escopo" da TUI e o default delta. Agora o mesmo
  `getSearchScope` alimenta guard e varredura.
- **Âncora do delta:** "apenas o novo" ancorava em `MAX(runs.id)`, mas buscas/verify também abrem runs
  (sem artigos) e o escopo zerava após qualquer busca. Nova âncora: `MAX(articles.run_id)` — a última
  run **que trouxe artigos** (`stmts.maxArticleRunId`).

### Removido
- **Busca por texto no browse da web** (cláusula `@q` do `WEB_WHERE` + a função SQL `fold`): busca por
  palavras/substring saiu de propósito — toda busca com consulta passa pela IA.

## [1.4.0] - 2026-07-02

As 5 melhorias de paralelismo/robustez apontadas no `ARQUITETURA.html` — todas implementadas e testadas.

### Adicionado
- **Pool de workers de parsing (isola o JSDOM do processo principal):** `src/parse-core.js` (funções
  puras JSDOM/cheerio/turndown, sem deps de db/governor) + `src/parse-worker.js` + `src/parse-pool.js`.
  Todo JSDOM/Readability roda num worker; um crash NATIVO (SIGSEGV do parser de CSS do JSDOM) mata SÓ o
  worker — o pool **respawna** e a task resolve com um default seguro (o chamador degrada; nunca
  re-executa inline p/ não arriscar o processo). Timeout por task (`PARSE_TIMEOUT_MS`) + fallback inline
  se não houver worker_threads (`PARSE_IN_WORKERS=false`). `PARSE_WORKERS` dimensiona o pool.
- **Deadline por job (`JOB_TIMEOUT_MS`, 90s):** um artigo cujo fetch/enriquecimento passa do tempo é
  CORTADO; a ficha **continua com o blurb** (needs_enrich=1) e o próximo crawl a re-enfileira (novo stmt
  `requeueNeedsEnrichForSource`, rodado no seed). Evento `job/timeout`. Só vale p/ jobs de **artigo** — a
  curadoria (listing/roundup) faz trabalho de LLM legítimo mais longo e é isenta.
- **Verificação em STREAMING (`VERIFY_STREAMING`):** cada ficha é verificada logo após salvar/enriquecer,
  na folga da lane llm (num set à parte que não rouba capacidade de fetch/render); o veredito fica pronto
  DURANTE o crawl. `verifyArticleRow` foi extraído p/ ser compartilhado com o sweep final, que segue como
  rede de segurança (idempotente, NULL-only). `processArticle` retorna a URL a verificar.
- **Escritas em lote:** `events` entram num **buffer** gravado em UMA transação (a cada `EVENTS_FLUSH_AT`
  ou no flush do fim do comando, em `runWithLimits`); o cadastro dos itens da curadoria virou **uma
  transação** better-sqlite3 — corta o fsync de milhares de inserts minúsculos.
- **Curadoria SEMPRE por seção:** `splitIntoSections` divide a edição por seção (News/Tools/Releases/IN
  BRIEF…), **1 agente por seção em paralelo** com um hint do tipo de conteúdo — mais paralelismo
  intra-edição (uma issue do Node Weekly vira ~3 agentes simultâneos) e prompts especializados. Sem seções
  detectáveis (< 2), cai p/ chunk por tamanho. `sectionTitleOf` reconhece heading/negrito/rótulo com emoji.
- **Testes:** `test/parse-pool.test.js` (echo, op desconhecida, **restart on crash** e **timeout** via
  fixture `crash-worker.js`), `test/commands.timeout.test.js` (deadline), `test/events.buffer.test.js`
  (auto-flush + flush), e casos de seção em `test/curate.consolidate.test.js`. 100 no total, verdes.

### Corrigido
- `clean.js` virou uma **fachada** (re-exporta o núcleo puro + as versões async do pool) — a superfície de
  import do resto do app e dos testes não mudou.
- Deadline por job era aplicado a TODOS os jobs e cortava a curadoria dos roundups em 90s (abortando a
  issue inteira); passou a valer só p/ jobs de artigo.
- **parse-pool: `runParse` pendurava p/ SEMPRE** quando o spawn do worker falhava de forma síncrona com
  ZERO workers vivos (task na fila não tem timer — só ganha um em `assign`): a fila agora é drenada
  INLINE (fail-open) nesse caso; após `MAX_SPAWN_FAILS` o pool se desativa de vez. Teste de regressão
  `test/parse-pool.spawnfail.test.js` (força o ctor a lançar via `PARSE_WORKER_PATH` https).
- **parse-pool: worker ocupado agora é `ref()`** (e volta a `unref()` ao ficar ocioso) — todos unref'd, o
  event loop podia esvaziar numa janela em que SÓ havia parses em voo e o processo saía no meio do crawl.
- **`sectionTitleOf` promovia item/prosa a "seção"**: heading de item com link (`## [Deno 2.9](url)`)
  fatiava o item p/ fora do contexto, e frase curta com palavra de seção ("More news next week.") virava
  rótulo. Guards: linha com URL/`](` nunca é seção; rótulo solto não termina em `[.!?…]`.
- Log do crawl: plural "seçãoões" -> "seções".

## [1.3.0] - 2026-07-02

### Adicionado
- **Curadoria por IA do agregador (default ON):** cada issue de fonte `index` é processada por agentes
  Flash **em paralelo** (chunks de `CURATE_CHUNK_CHARS`) e vira **itens estruturados** — `kind`
  news|tool|release, seção e o **blurb do próprio agregador**. O item é **cadastrado já na curadoria**
  (`needs_enrich=1`, conteúdo inicial = título+blurb) e o fetch do alvo vira **enriquecimento**: ferramenta
  com alvo raso/bloqueado (GitHub, release page) **não se perde mais**; patrocínio/vaga ficam FORA
  (rótulo do LLM + backstop determinístico `sponsor|hiring|classifieds`). Links secundários de dentro dos
  blurbs deixam de virar registros.
- **Limpeza por IA antes de salvar (default ON):** o conteúdo extraído passa pelo Flash p/ remover sujeira
  de UI (menus, contadores de stars/downloads, subscribe, rodapé) preservando o texto real; régua
  anti-truncamento `sanityCheckCleaned` (rejeitou → mantém original e registra motivo).
- **Verificação pós-cadastro (default ON) + `ncrawl verify`:** varredura paralela dá veredito
  `ok|suspect|junk` + notas a cada artigo (colunas `verify_status/verify_notes`), auto pós-crawl.
- **Trace por item (tabela `events`) + `ncrawl inspect`:** todo estágio grava o que fez/decidiu (fetch,
  curadoria, item salvo/ignorado com motivo, limpeza, enriquecimento, verificação, seletor de data);
  `inspect` mostra a run em árvore (itens por issue, vereditos, custo por etapa), `--url <substr>` audita
  um link, `--verbose` inclui as notas.
- **Seletor de DATA por IA lendo a página real:** quando `--since` está ativo e o layout não expõe
  `<time datetime>` (Node Weekly usa `<span class="issue-date">`), o Flash deriva um par **CSS + regex**
  por template de weekly, validado contra a própria página (≥50% dos itens datados) e cacheado em
  `selectors.date_selector/date_attribute/date_regex`; fallbacks genéricos (`[class*=date]`, regex estrita)
  continuam de custo zero.
- **`ncrawl purge <fonte> --yes [--selectors]`:** apaga os DADOS de uma fonte (artigos+tags, pages,
  frontier, events; a fonte continua cadastrada) p/ refazer um crawl do zero de forma reprodutível.
- **Passe de COBERTURA da curadoria:** o recall do curador não é garantido (observado: 3 itens do meio
  da issue omitidos) — a diferença determinística de conjuntos (links externos do corpo − itens
  emitidos) alimenta um agente extra que decide item real que faltou vs link secundário; um pós-filtro
  determinístico (`isRealRecoveredItem`: exige blurb real e título não-genérico) impede que âncoras
  como "Demo."/"Release notes" virem registros. O diff usa o HTML BRUTO e o agente dos faltantes
  recebe o HTML PODADO da página INTEIRA como contexto (o Readability descarta blocos reais vizinhos
  de anúncio — sem isso os itens omitidos nem apareciam no funil). Evento `curate/coverage` audita o
  funil por URL. Validado end-to-end (run #10): 59 fichas, 3 itens recuperados na #631, 0 patrocínios.
- **`ARQUITETURA.html`** na raiz: a arquitetura desenhada em canvas (pipeline, paralelismo, gargalos,
  números reais) explicada p/ leigos — zero dependências, abre direto no navegador.

### Corrigido
- **`RENDER_PROFILES` não existia em fetch.js** (perdido no merge dos branches): TODO fetch renderizado
  (Playwright) crashava com `RENDER_PROFILES is not defined` — páginas JS-gated nunca eram capturadas.
- **Crawl abria 2 linhas em `runs`** (ledger + `startDeltaRun`) e **crashava** em DBs criados pelo branch
  robot-bypass (`runs.command NOT NULL`); agora a marca d'água do delta reusa o run do ledger.
- **Duplicação de logs** no fim do crawl (bloco repetido do merge).

### Alterado
- **Modo agressivo virou o DEFAULT** (`CRAWLER_AGGRESSIVE=false` ou `--no-aggressive` p/ modo educado);
  segue NÃO salvando páginas de desafio e NÃO relaxando breaker/delays.
- No fluxo de item curado, o **título do agregador é autoritativo** (ex.: "Node-GTK 4.0" em vez de
  "The GTK Project - …") e a **data-âncora é a da issue**; artigo curado com data própria antiga não é
  mais censurado pelo piso `--since` (o piso segue valendo p/ artigos avulsos e p/ as issues).

## [1.2.0] - 2026-07-01

### Adicionado
- **Modo agressivo (`--aggressive`)** por execução (flag na CLI + toggle no menu Coletar): ignora o
  `robots.txt` e usa **User-Agent de navegador real + headers/client-hints** (`Accept-Language`,
  `sec-ch-ua`, `sec-fetch-*`) no fetch estático e no Playwright, para passar por 403/anti-bot em sites
  que você tem direito de arquivar. **Não** relaxa o circuit breaker/delays e **não** salva páginas de
  desafio (o descarte anti-bot continua ativo). UA sobrescrevível por `CRAWLER_AGGRESSIVE_UA`.
- **Re-crawl incremental automático:** rodar de novo re-visita as listagens das fontes e traz **só o que
  é novo** — a paginação para na 1ª página sem itens novos e a dedup de artigo impede re-baixar o já
  salvo. Desligue a re-visita com `--no-refresh`.
- **Marca d'água por execução (delta):** tabela `runs` + coluna `articles.run_id`. `export` e `search`
  mostram por padrão **só o novo desde a última execução**; use `--all` para o acervo inteiro.

### Corrigido
- **TUI (Ink): o valor do 1º campo do wizard vazava para os campos seguintes.** O `TextInput` do
  `@inkjs/ui` é não-controlado e era reaproveitado entre os passos; agora cada campo tem `key=${step}`
  (remonta com buffer limpo). Cobre os fluxos Coletar e Adicionar; teste de regressão adicionado.

### Alterado
- Menu **Coletar** ganhou um **resumo pré-execução** (mostra `--since`, máx. páginas/artigos e o estado do
  modo agressivo, com aviso) e **Exportar/Buscar** ganharam um passo **"apenas o novo / todo o acervo"**.

## [1.1.0] - 2026-07-01

### Adicionado
- **CLI global `ncrawl`** (via `npm link`; alias longo `newsletter-crawler`). Dados do usuário passam a
  morar em **`NC_HOME`** (default `~/.newsletter-crawler/`): `crawler.db`, `.env`, `sources.json`, `export/`.
  `ncrawl key set/test` valida a chave na OpenRouter (probe `GET /api/v1/key`) e grava com precedência.
- **Harness de avaliação de prompt em `eval/`**: golden set curado (36 artigos × 5 cenários), 5 variantes
  de prompt, testa cada uma em **DeepSeek V4 Flash e Pro** (modelos isolados), mede F1 macro, precisão,
  recall, acurácia 3-vias, acerto tool/news e latência; `aggregate.mjs` → `eval/REPORT.md`.

### Alterado
- **Busca (Modo A): prompt de relevância (`judgeRelevance`) melhorado via avaliação** — variante
  *rubrica + few-shot contrastivo* (`v2_fewshot`), vencedora em 3 rodadas nos dois modelos: **F1 macro no
  Flash 0.731 → 0.848 (+0.117)**, precisão 0.59 → 0.79 (corta falsos positivos), mesma latência, 0 falhas
  de JSON. Pro 0.778 → 0.807.
- Scripts npm usam `--env-file-if-exists=.env` — não quebram sem um `.env` no repo (o `NC_HOME/.env`
  continua com precedência).
- `src/llm.js` exporta `callJSON`, `relevanceSchema` e `relevanceZ` (reuso fiel pelo harness de avaliação).

### Corrigido
- Contexto do Playwright com **`ignoreHTTPSErrors: true`** — sites com certificado TLS de CN inválido
  (ex.: `kedglobal.com` → `ERR_CERT_COMMON_NAME_INVALID`) voltam a renderizar.
- Documentado o pré-requisito **`npx playwright install chromium`**: sem o browser headless, todo site que
  exige render (403 → Playwright) falhava com `browserType.launch: Executable doesn't exist`.

## [1.0.0] - 2026-06-30

### Adicionado
- Primeira versão estável: crawler de newsletters em **Node.js puro** (ESM, Node ≥ 22, sem build).
- **Crawl multinível** `índice → issue (roundup) → artigo`; **frontier no SQLite** resumível
  (`pending → in_progress → done/failed`); `robots.txt` + Crawl-delay, jitter e circuit breaker por host.
- **Seletores CSS derivados por LLM** (OpenRouter / DeepSeek V4), validados com Cheerio e **cacheados por
  template no SQLite** — re-derivados só quando o cache falha (**self-healing**).
- **Dedup garantido** por URL canônica pós-redirect + `content_hash` (UNIQUE).
- **Parada por data** (`--since`); **tags multi-faceta** contra vocabulário controlado; **resumos e títulos
  em PT-BR**.
- **Busca na base** em 2 modos: A exaustivo (Flash, varre tudo) e B por tags (Pro), com buckets
  **Notícias** e **Ferramentas**.
- **Menu guiado (TUI)** Ink/React (htm, sem build), bilíngue PT/EN, com painel de progresso ao vivo.

[1.2.0]: https://github.com/frederico-kluser/newsletter-crawler/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/frederico-kluser/newsletter-crawler/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/frederico-kluser/newsletter-crawler/releases/tag/v1.0.0
