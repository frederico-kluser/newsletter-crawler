# Changelog

Todas as mudanças relevantes deste projeto. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

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

[1.1.0]: https://github.com/frederico-kluser/newsletter-crawler/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/frederico-kluser/newsletter-crawler/releases/tag/v1.0.0
