# Changelog

Todas as mudanças relevantes deste projeto. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

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
