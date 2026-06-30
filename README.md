# newsletter-crawler

Crawler de newsletters em **Node.js puro** que descobre, extrai e arquiva artigos, usando um **LLM no OpenRouter (DeepSeek V4)** para *derivar seletores CSS reutilizáveis* — não para extrair página a página. O seletor é validado com Cheerio, **cacheado por template no SQLite**, e o LLM só é chamado de novo quando o cache falha (**self-healing**). Resultado: custo de LLM próximo de zero por artigo depois do primeiro acerto.

## Como funciona (visão geral)

```
seed (listing) ─► fetchSmart (got → Playwright se precisar de JS)
                     │
                     ├─ cache de seletor? ──sim──► aplica (Cheerio) ──► enfileira artigos
                     │
                     └─ não/quebrou ─► DeepSeek V4 Pro (reasoning xhigh) deriva seletor
                                        └─ valida (≥3 links) ─► salva no SQLite ─► usa p/ todas as páginas
                                        └─ falhou ─► fallback DeepSeek V4 Flash item-a-item

artigo ─► fetchSmart ─► Readability ──ok──► salva (SQLite)
                         └─ falhou ─► content selector (Pro, cacheado) ─► senão ─► Flash extrai
```

Tudo passa por uma **fila/frontier no SQLite** (`pending → in_progress → done/failed`), então o crawler é **resumível**: se cair, é só rodar de novo.

## Requisitos
- Node.js >= 22 (testado em Node 24)
- Uma chave do OpenRouter

## Instalação
```bash
npm install
npx playwright install chromium      # baixa o browser headless
cp .env.example .env                 # e preencha OPENROUTER_API_KEY
```

## Configuração
- **`.env`** — segredos e overrides (veja `.env.example`). Nunca é commitado.
- **`config/sources.json`** — as newsletters a raspar:
  ```json
  {
    "sources": [
      { "name": "The Batch — Research", "url": "https://www.deeplearning.ai/the-batch/tag/research" },
      { "name": "AI Weekly", "url": "https://aiweekly.co/issues", "type": "index", "maxIndexPages": 1 }
    ]
  }
  ```
  - `type` (default `listing`): em `listing` os links da página são artigos. Em **`index`** os links são **issues/edições** (roundups) — o crawler abre cada issue e, de dentro dela, abre os **links externos curados** (a notícia em si). Fluxo: `índice → issue (roundup) → artigo`.
  - `maxIndexPages`: quantas páginas do índice paginar (default 1 = só a 1ª).
  - Uma página apontada por um link que for, ela mesma, uma **coleção** de várias notícias (pouca prosa + muitos links externos) é **dividida em N** automaticamente (`MAX_CRAWL_DEPTH` limita a recursão).

## Uso
```bash
npm run crawl                          # semeia do config e roda até esvaziar a fila (resumível)
npm run crawl -- --max-pages 2 --max-articles 5   # limita custo/tempo (ótimo p/ 1º teste)
npm run status                         # contagens de sources/pages/articles/selectors/frontier
npm run add -- https://exemplo.com/arquivo --name "Minha Newsletter"
npm run export -- --format md          # escreve data/export/<fonte>/*.md  (ou --format json)
```

## Modelos (OpenRouter / DeepSeek V4)
- **Pro** `deepseek/deepseek-v4-pro` com `reasoning.effort: "xhigh"` — deriva/repara seletores (1 chamada amortizada por template). Use `"xhigh"`, **nunca** `"max"`.
- **Flash** `deepseek/deepseek-v4-flash` com `reasoning.effort: "high"` — fallback item-a-item, próxima página, extração de artigo.
- Saídas estruturadas via `response_format: json_schema` (strict) + validação `zod`.

## Estrutura
```
src/config.js     env + sources + constantes
src/util.js       normalizeUrl, sha256, jitter, slugify, log
src/db.js         better-sqlite3: schema (WAL) + prepared statements
src/fetch.js      fetchStatic/fetchRendered/fetchSmart + robots + circuit breaker
src/clean.js      pruneForLLM (HtmlRAG) + Readability + turndown
src/llm.js        OpenRouter: deriveLinkSelector/Content/Next + extractLinks/Article
src/selectors.js  cache get/put + validação Cheerio (self-healing)
src/substack.js   atalho opcional via API JSON do Substack
src/crawl.js      frontier + processJob + crawlArchive + paginação
src/index.js      CLI + loop principal resumível
```

## Notas
- **Cortesia/legal:** respeita `robots.txt` e Crawl-delay (desative com `CRAWLER_RESPECT_ROBOTS=false` só para conteúdo que você tem direito de arquivar), usa UA identificável, delay com jitter e circuit breaker por host. Raspe apenas conteúdo público.
- **Sem `axios`** (incidente de supply-chain de 31/03/2026); usamos `got`. As versões são fixadas no `package-lock.json`.
- **Custo:** `xhigh` é cobrado como tokens de saída — por isso o Pro só deriva seletor (uma vez por template) e o DOM é podado antes de ir ao LLM.
