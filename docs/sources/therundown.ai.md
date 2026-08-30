# Análise da fonte: therundown.ai (The Rundown — newsletter de IA/macro)

> Análise profunda de captura para o crawler de newsletters. Baseada em evidência REAL colhida
> em 2026-08-30 (curl, análise de payload RSC/Next.js, API JSON, Playwright headless e execução
> do pipeline de extração do próprio crawler contra o HTML salvo). Nenhuma alteração de código
> de produção foi feita — apenas este documento.
>
> Data da coleta: 2026-08-29/30 · Fuso dos servidores: UTC · Último artigo no índice: 2026-08-28T14:30Z.

---

## 1. Descoberta do site (fetch real)

```bash
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" \
  -o /tmp/therundown-articles.html -w "HTTP %{http_code} | %{size_download} bytes | final %{url_effective}\n" \
  "https://www.therundown.ai/articles"
```

Resultado verificado:

- `HTTP 200`, **86.387 bytes de HTML cru** (SSR real, sem JS-gating — o HTML já vem com os cards).
- Não há redirect: `final_url = https://www.therundown.ai/articles`.
- Headers: `server: Vercel`, `x-powered-by: Next.js`, `x-nextjs-prerender: 1`, `x-vercel-cache: HIT`,
  `vary: rsc, next-router-state-tree, ...` → **Next.js App Router (RSC) servido pela Vercel**, com
  pré-render estático e cache de borda. TLS ok (HTTP/2, sem erro de cert).
- `robots.txt` (107 bytes, HTTP 200):

  ```text
  User-Agent: *
  Allow: /
  Disallow: /api/
  Disallow: /landing/
  Sitemap: https://www.therundown.ai/sitemap.xml
  ```

- `sitemap.xml`: HTTP 200, 468.840 bytes, **2.693 URLs** → **1.328 URLs de artigo** (`/articles/<slug>`)
  + páginas de categoria (`/articles-category/{ai,tech,robotics}`), guides/tools/courses e páginas
  institucionais. **NÃO existe** arquivo de edições estilo beehiiv (`/n/...`), nem `/archive`, nem
  `/issues` no sitemap.

**Estrutura da página `/articles` (região crítica do HTML)**

O corpo SSR renderiza um grid de **8 cards de artigo** (sempre os 8 mais recentes). Cada card:

```html
<a class="group relative block" href="/articles/the-ox-alpha-mystery-ends-with-z-ai">
  <div class="relative">
    <span class="absolute left-3 top-3 z-10 rounded-md bg-paper px-2 py-0.5 ...">AI</span>
    <div class="relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-mist">
      <img src="https://beehiiv-images-production.s3.amazonaws.com/uploads/asset/file/4ec27bf3-.../oxalpha.jpg?t=..." loading="lazy"/>
    </div>
  </div>
  <h3 class="mt-3 font-bold ... text-[17px]">The Ox Alpha mystery ends with Z.ai</h3>
  <p class="mt-2 text-xs text-mute">Zach Mink<!-- --> • 8 minutes</p>
</a>
```

Pontos críticos do card:
- O link é **interno** (`/articles/<slug>`), âncora = card inteiro (`<a class="group relative block">`).
- O `<h3>` tem o título; o `<p>` mostra **autor • minutos de leitura** — **NÃO há data** no card.
- `loading="lazy"` nas imagens (irrelevante: o crawler bloqueia image/media/font no render).
- Nenhum `<time>` (= 0) e nenhum `[class*="date"]` (= 0) na página inteira, nem após rolagem no browser.

**Organização por data:** os cards vêm em ordem decrescente de `publishDate` (mais recente primeiro),
mas a data em si **só existe fora do DOM**: no payload RSC (`self.__next_f`) e na API JSON
(seção 2). A paginação visível ("← Previous 1 2 … 167 Next →") é **client-side**.

**Paginação (verificada, sem margem de dúvida):**
- `?page=2`, `?page=1`, `?offset=10` → TODAS retornam **byte a byte o mesmo HTML** (86.387 bytes,
  8 cards, 48 objetos no flight). Não existe paginação por query server-side.
- Playwright (headless, UA de browser): rolar 25×4.000px **não adiciona um único card** (8 → 8).
- Existe um controle de paginação cliente: 167 páginas × 8 = 1.329 artigos, com botão "Next →".
  Clicar em "Next →" **troca os 8 cards in-place e a URL não muda** (segue `https://www.therundown.ai/articles`).
  Ou seja: a "página 2" é um estado de componente React alimentado por UMA chamada a
  `/api/articles-index`, não uma URL.

---

## 2. O mecanismo escondido: `GET /api/articles-index`

Durante o load no browser, a própria página chama:

```text
GET https://www.therundown.ai/api/articles-index   → 200, application/json, 784.014 bytes
```

O endpoint devolve **o índice COMPLETO de artigos** — um array JSON de **1.329 objetos**, sem
paginação (query `?cursor=`, `?page=`, `?offset=` são todas ignoradas; o corpo é idêntico). Shape
verificado de cada item:

```json
{
  "id": "post_92fdf022-2646-41a2-991a-b2a501e88219",
  "slug": "cursor-origin-hits-github-on-its-worst-day",
  "title": "Cursor's Origin hits GitHub on its worst day",
  "subtitle": "PLUS: Build a work 'Second Brain' that updates itself",
  "authors": ["Zach Mink", "Rowan Cheung", "Shubham Sharma", "Jennifer Mossalgue"],
  "publishDate": "2026-08-20T14:30:00.000Z",
  "thumbnailUrl": "https://beehiiv-images-production.s3.amazonaws.com/uploads/asset/file/.../cursororigin.jpg?t=...",
  "category": "ai",
  "readTimeMinutes": 7,
  "metaDescription": "Cursor's Origin launches as Gi..."
}
```

Fatos verificados sobre o payload:
- 1.329 itens, **1.329 slugs únicos**, **1.329 ids únicos**; ZERO itens com `publishDate` ou `slug` nulos.
- `publishDate` em ISO-8601 UTC (`2026-08-25T10:00:00.000Z`) — parseável direto por `parseDate`.
- URL do artigo = `https://www.therundown.ai/articles/<slug>` (1:1 com o sitemap).
- `category` = `ai` (922) | `tech` (260) | `robotics` (147). `readTimeMinutes` = 5–8.
- Tamanho típico: ~590 bytes/item → o dump inteiro pesa 784 KB.
- **robots.txt DISALLOVA `/api/`** — em modo educado (`--no-aggressive` / `CRAWLER_RESPECT_ROBOTS`)
  o crawler não deve tocar nesse endpoint. Em modo agressivo (o **default** do crawler) ele ignora
  robots e o endpoint funciona (o próprio site o consome publicamente a cada page load, sem auth).

O mesmo payload RSC (`self.__next_f.push`) do SSR carrega os **48 artigos mais recentes** com os
mesmos campos (`slug`, `publishDate`, `category`, `authors`, `readTimeMinutes`, `metaDescription`,
`bodyHtml:"$undefined"` — o corpo não é serializado). Ou seja: a data de listagem existe de graça no
flight, mas **não está no DOM**.

---

## 3. Tipo da fonte: **listing** (com evidência)

**Conclusão: `listing`.** `/articles` é uma lista FLAT de artigos; cada link é o próprio
conteúdo-alvo (um artigo/edição completo em página própria do site). Não há arquivo de edições.

Evidências:

1. **Cada item da lista é um artigo completo, não uma issue com vários itens.** A página do artigo
   (`/articles/<slug>`) contém a edição inteira como um `NewsArticle` (`JSON-LD`), com corpo de
   ~22.343 caracteres extraídos pelo Readability do próprio crawler. O conteúdo começa com
   "Good morning, AI enthusiasts, and welcome to our 3,218 new readers…" — é a newsletter inline.
   O subtítulo "PLUS: …" indica que a edição agrega temas, mas tudo vive numa página única; o
   crawler trata isso como UM artigo (ver roundup-detection na seção 6: prosa 22K >> limite de 1.500).
2. **Não existe arquivo de issues separado**: sem URLs `/n/`, `/p/`, `/issues`, `/archive` no sitemap
   nem na navegação; `robots.txt` não cita. A fonte beehiiv legada (`therundownai.beehiiv.com/archive`,
   HTTP 200) existe, mas é outro host e não faz parte da fonte canônica.
3. **Sinais determinísticos do `detect-type`** (calculados sobre o HTML real):
   - `urlMatchesIndexPath` = false (`/articles` não casa `/(issues?|archive|editions?|newsletters?|numbers?|posts?)/`).
   - Links internos dominam (nav + 8 cards), links "de edição" (`ISSUE_LINK_RE`) ≈ 0 (slugs não têm
     dígitos soltos nem `/AAAA/MM`).
   - Heurística → `listing`. Com LLM (default), o stage `detectType` vê títulos de artigos reais e
     links internos diretos para conteúdo → também `listing`. O `add` deve cair em `listing` sem `--type`.
4. **Consequência no crawler**: `childKind = 'article'` — os 8 links da listagem viram jobs de
   artigo (não roundup/issue). Nenhum `splitIntoSections` se aplica à fonte.

---

## 4. Mecanismo de DATA

| Nível | Onde está a data | Formato | Funciona no crawler? |
|---|---|---|---|
| Listagem (`/articles`, DOM) | **Nenhuma** — 0 `<time>`; 0 `[class*="date"]`; texto do card = "autor • N min" | — | ❌ `dateNearLink` sempre `null` |
| Listagem (`/articles`, payload RSC `__next_f`) | `publishDate` em JSON dentro do flight | `2026-08-25T10:00:00.000Z` | ⚠️ não lido pelo crawler (não há parser de flight) |
| Índice `/api/articles-index` | `publishDate` (campo de cada item) | idem | ⚠️ só via estratégia nova (item 8) |
| Página do artigo | `JSON-LD` `NewsArticle.datePublished` + `<meta property="article:published_time">` + (ausente) `<time>` | idem | ✅ `extractPublishedDate` / Readability `publishedTime` |

Verificação da extração no artigo real (rodando o pipeline do próprio crawler):

```text
extractPublishedDate = "2026-08-25T10:00:00.000Z"     # parse-core: JSON-LD primeiro ✔
```

- O `--since 2026-01-01` **não consegue pisar na listagem via DOM** (itens sem data → passam
  direto pelo filtro `if (sinceDate && d && d < sinceDate)`) — mas a data **chega na fase de
  artigo** via JSON-LD/meta, então o acervo final fica datado corretamente e ordenável.
- `deriveDateSelector` (Flash lendo a página real) vai tentar derivar spec CSS+regex quando
  `--since` está ativo e ~nenhum item tem data; como NÃO existe nenhum elemento de data no DOM,
  o spec resultante não valida (exige ≥ max(3, 50%) dos itens parseáveis) → degrada para null
  e o log avisa "seguindo sem datas". Comportamento esperado, sem inventar datas.

---

## 5. Mecanismo de LINK dos itens

- **hrefs na listagem**: âncoras `<a class="group relative block" href="/articles/<slug>">` —
  links internos, absolutos por caminho, sem redirect. `extractRoundupLinks`/`readableLinks`
  os acham; seletor candidato: `a[href^="/articles/"]` (8 matches; o link de nav `/articles`
  sem barra final fica de fora) — valida com folga (≥3).
- **Sem redirects**: `curl -sL` no artigo não muda de URL; o site é Node/Next nativo (não há
  Intercom/Medium-style redirects).
- **Artigos (nível 1)**: conteúdo extraível direto (Readability → ~22K chars); links externos
  do corpo (~23, com `?utm_source=therundownai.beehiiv.com…`), usados na detecção de coleção
  (ver seção 6) e pela curadoria apenas se virar roundup (não vai).
- **Sitemap como fonte alternativa de links**: 1.328 URLs de artigo (robots permite), porém sem
  data por item confiável (`lastmod` existe por URL mas é metadado de SEO, não `publishDate`).

---

## 6. Gotchas REAIS verificados no site

1. **Sem anti-bot/Cloudflare**: servidor é Vercel puro (`server: Vercel`, sem headers `cf-*`,
   sem challenge). `isBlockedPage(title, content)` → `false` no artigo real testado.
2. **HTML cru NÃO é vazio**: 86 KB com 8 cards e body com >500 chars. `looksEmpty()` = false →
   **fetch estático vence; o crawler NUNCA renderiza `/articles` por conta própria.**
3. **Paginação infinita NÃO existe como URL**: `?page=N` é inútil; o scroll não traz nada; a
   paginação é um estado React cliente alimentado por `/api/articles-index`. `findNextPage`
   (rel=next → `?page=N` → LLM) não encontra próxima página → o walk da listagem para na página 1.
   Mesmo que a listagem fosse renderizada (`forceRender`), o `clickLoadMore` acharia o botão
   "Next →" (regex casa "next"), clicaria até `MAX_LOAD_MORE` (50) trocando 8-em-8 — mas a
   colheita `harvestNewLinks` coleta só `{href,text,dt}` com `dt=null` e o `mergeScrollHarvest`
   **descarta tudo sem data parseável** → no fim, nada além dos 8 cards entraria.
4. **Limite estrutural da listagem: só os 8 mais recentes.** A janela desliza 2/dia → captura
   incremental de ~2/dia via DOM. O arquivo completo (1.329, sendo 308 desde 2026-01-01) é
   **inalcançável pelo DOM** — só via `/api/articles-index` (estratégia, item 8) ou sitemap.
5. **robots.txt proíbe `/api/`** (e `/landing/`). `/articles`, `/articles/<slug>`, `sitemap.xml`
   são permitidos. Default do crawler é agressivo (ignora robots) → o endpoint JSON funciona;
   em modo educado, apenas os 8 da listagem seriam coletáveis.
6. **Data ausente no DOM** (0 `<time>`, 0 `[class*="date"]`) — o piso `--since` não corta nada na
   listagem; datas só na fase de artigo (JSON-LD) ou via API JSON.
7. **Payload RSC (`self.__next_f`)** carrega 48 artigos com datas — uma rodada de "scrape de
   dados" alternativa, mas o crawler não consome flight.
8. **Vercel cache/edge**: respostas podem vir de `x-vercel-cache: HIT`; HTML pré-renderizado é
   estável (mesmo hash entre `?page=`); `x-nextjs-stale-time: 300` — irrelevante para o crawler.
9. **TLS**: ok (HTTP/2, HSTS). `ignoreHTTPSErrors: true` do crawler cobre qualquer caso residual.
10. **Artigos não viram roundup**: prosa ~22.343 chars ≫ `ROUNDUP_MAX_PROSE_CHARS` (1.500) →
    `looksLikeCollection` = false; cada artigo fica UM registro (bom: é a edição inteira).

---

## 7. Mapeamento para o nosso código (caminho exato)

Pipeline executado por `npm run add https://www.therundown.ai/articles --name "The Rundown"` +
`npm run crawl -- --sources "The Rundown" --since 2026-01-01` (defaults):

1. **`detectSourceType`** (`src/detect-type.js`): `fetchSmart` estático (86 KB, não-empty) →
   sinais (`gatherTypeSignals`) → stage LLM `detectType` → **`listing`** (heurística e IA
   convergem; item 3). Sem `--type` necessário.
2. **`processListing`** (`src/crawl.js`): `isSubstack(url)` → falso (probe falha/no header) →
   segue HTML. `fetchSmart(url, {profile:'listing', sinceDate})`:
   - `fetchStatic` → 200, HTML não-vazio → **retorna estático, sem Playwright** (`needsJs` nem setado).
3. **Seletor de links**: sem cache → `deriveLinkSelector` (Pro/xhigh) sobre a página podada →
   provável `a[href^="/articles/"]`; `validateLinkSelector` ok (8 ≥ 3) → cacheado em `selectors`.
   Self-healing futuro valida na hora; se o layout mudar, re-deriva.
4. **`crawlArchive`** (página 1, `depth=0`):
   - com `--since`: `applyLinkSelectorWithDates` → 8 links, **todas datas `null`**;
   - `deriveDateSelector` (Flash) roda (≥3 itens, nenhum datado) → encontra ZERO elementos de
     data → spec não valida → **segue sem datas** (log `dateSelector`/`invalid`);
   - `mergeScrollHarvest` → sem harvest (não renderizou);
   - parada known-url: run 1 → 0 conhecidos → segue; **run 2 em diante → 8/8 conhecidos → para**
     (parada determinística zero-LLM);
   - enfileira os 8 (datas null passam pelo filtro `--since`; `below=0`);
   - `findNextPage`: sem `rel=next`, sem `?page=` real, LLM não acha link "próxima" → **`sem
     próxima página` → walk termina em 1 página**. `added===0`/`below>0` como redes de segurança.
5. **Jobs de artigo** (`processArticle`, `depth=1`, `MAX_CRAWL_DEPTH=3` sem folga):
   - `fetchSmart` estático da página do artigo (217 KB) → extrai;
   - `extractArticleAsync` (Readability no pool de workers) → conteúdo ~22 K chars,
     `publishedTime` via meta/JSON-LD → `published` preenchido; `extractPublishedDate` retorna
     `2026-08-25T10:00:00.000Z` (verificado);
   - roundup-detection: prosa 22 K > 1.500 → **não divide**;
   - `isBlockedPage` false; conteúdo >50 chars ok; `clampFutureDate` protege datas futuras
     (não é o caso aqui — datas passadas); `ensurePlainText`/`sanityCheckCleaned` normais;
   - verificação/classificação/resumo PT-BR em streaming (pipeline padrão).
6. **`--since` na prática**: inócuo na listagem (sem datas) mas **autoritativo no artigo**
   (data gravada via `published_at`/`iso_date`); o piso não vai "parar cedo" nem "pular" nada —
   apenas não consegue encurtar a descoberta via DOM. Com a estratégia JSON (item 8) o piso
   volta a funcionar na descoberta (parar exatamente em 2026-01-01 dos 308).

**O que pode falhar (riscos reais):**
- **Silêncio de backfill**: o usuário espera 308 itens desde 2026-01-01 e o crawler traz só os 8
  do topo (e depois ~2/dia). Não é bug do crawler — é o formato do site. Mitigação no item 8.
- Se o layout dos cards mudar (ex.: classes do `a`), o seletor cacheado re-deriva (self-healing).
- Se um dia a edição for curta (<50 chars após limpeza) → item pulado com `no-content`; a data
  futura imaginária não ocorre (datas sempre passadas).
- Custo: com 308 artigos enriquecidos, o driver de custo é o pipeline LLM pós-save (verify,
  classify por faceta, summarize) — não o fetch (tudo estático).

---

## 8. Volume esperado desde 2026-01-01

Medido no `/api/articles-index` (fonte da verdade):

- **Total do arquivo:** 1.329 artigos (2023-01-06 → 2026-08-28T14:30Z). Sitemap: 1.328 URLs de
  artigo (diferença de 1 = provável página `/articles` contada duas vezes ou slug removido).
- **Desde 2026-01-01 até hoje (2026-08-30): 308 artigos** — ritmo ~38–40/mês, 2/dia útil
  (manhã ~10:00 UTC + tarde ~14:30 UTC); por dia da semana em 2026: seg 63, ter 69, qua 34,
  qui 70, sex 67, dom 5 (sáb 0; quartas mais leves, domingos raros).
- **Tamanho típico por item:** página do artigo ≈ 217 KB HTML cru → conteúdo extraído ~22.343
  chars (≈ 3,5–4 mil palavras por edição, com ~23 links externos no corpo). Índice JSON: ~590
  bytes/item (784 KB no total).
- **Transferência estimada do backfill:** 308 páginas × ~217 KB ≈ **67 MB** (ou 784 KB se a
  descoberta for via `/api/articles-index`). Nada demais para o crawler (fetch estático).

---

## 9. Recomendação final

**Tipo do `npm run add`:** deixar a detecção automática → **`listing`** (ou `--type listing`).
Nome sugerido: "The Rundown".

**Seletores prováveis:**
- Links: `a[href^="/articles/"]` (8 matches; validar com `validateLinkSelector` ≥3).
- Data: **nenhum seletor existe na listagem** (não force) — a data vem do artigo (JSON-LD/meta).
- Conteúdo: Readability resolve (verificado); `content_selector` só se o Readability falhar —
  alvo do corpo seria o `#content-blocks` / `<article>`.

**Caminho que a fonte vai percorrer hoje:**
1. `add` → `listing`; 2. crawl: estático → 8 links → enfileira 8 artigos → extração ok, datas ok
   no artigo; 3. runs seguintes: known-url stop na listagem, captura só o novo que entrar no
   topo-8 (~2/dia útil → ~10–12/semana). Acervo incremental saudável, **backfill de 2026 inviável
   via DOM**.

**Riscos:**
- **Backfill limitado a 8** (principal limitação; documentado acima, não um bug).
- **robots `/api/`**: a via de backfill real está em rota disallowed — usar somente no default
  agressivo do crawler (ou registrar a escolha consciente na fonte).
- Volume/custo baixo-médio (308 itens; fetch barato; custo é o LLM pós-save, como sempre).

**Melhoria recomendada (para o orquestrador — não implementada aqui):**
Adicionar uma **estratégia de descoberta por API JSON** no espelho do `src/substack.js`
(`isSubstack`/`substackArchive`): um probe `isTherundown`/genérico "json index" que detecte
`/api/articles-index` e, no `processListing`, enfileire `https://www.therundown.ai/articles/<slug>`
com `discovered_date = publishDate` (parâmetro 6 do `enqueue`, como o Substack). Efeito: 1 request
(784 KB) → 1.329 links datados → o piso `--since 2026-01-01` corta exatamente nos 308 e a parada
known-url evita re-trabalho. Alternativa simples (menos elegante): ingerir `sitemap.xml`
(1.328 URLs, robots permitido) sem datas por item.

---

## 10. Implementado: atalho JSON (`src/therundown.js`)

> Esta seção documenta o que MUDOU no crawler com a implementação — o resto da análise acima
> permanece como a evidência original. Merge 2026-08-30.

**O que foi adicionado** (espelho do atalho Substack, zero mudança em outras fontes):

- `src/therundown.js` (`isRundown` + `rundownArchive`), integrado em `src/crawl.js` `processListing`
  ANTES do caminho HTML, com o MESMO estilo do bloco substack (try/catch → warn e cai no HTML,
  `dateSeen`/`floorHit`/`enqueue` com `discovered_date = publishDate` do payload, log
  `rundown: N artigos (M novos) de <host>`).
- **Única diferença vs. Substack:** o atalho só age quando `opts.aggressive !== false`. Motivo:
  `robots.txt` **DISALLOWA `/api/`** — o probe e o índice só rodam no default agressivo do crawler
  (que ignora robots); em modo educado (`--no-aggressive`) o crawler nunca toca o endpoint e segue
  o fluxo HTML normal (os 8 cards).
- `rundownArchive` faz **1 GET** em `{origin}/api/articles-index` (índice completo, ~1.329 itens,
  sem paginação) e devolve `[{url: origin + '/articles/' + slug, published_at: publishDate}]` —
  **sem filtrar por data** (o chamador filtra, igual ao Substack). Itens sem `slug`/`publishDate`
  válidos são descartados; array vazio/parse falho → `[]` (fail-open p/ o HTML). Timeout curto
  (20s), retry limitado (2), `throwHttpErrors: false`, UA de `USER_AGENT` (config.js), `got`
  (regra do repo: nunca axios).
- `isRundown` faz o probe **cacheado por host** (Map por processo, como o `needsJs`): 200 + array
  JSON com ≥1 item `{slug, publishDate}` → `true`; erro/timeout → `false` (fail-open).
- Testes: `test/therundown.archive.test.js` (deteção por payload, fallbacks fail-safe, item sem
  `publishDate` ignorado, cache por host; wire de `processListing` com `mock.module` provando o
  `discovered_date` na frontier, o piso `--since` no chamador e o gate do modo educado).

**Efeito no comportamento da fonte** (com o atalho ativo, default agressivo):

- 1ª coleta com `--since 2026-01-01`: o índice chega inteiro numa request (784 KB), o piso corta
  exatamente nos ~308 artigos desde 2026-01-01 e todos são enfileirados como `kind=article`
  (semântica listing) com a data do payload (que também alimenta o `%` do progresso rumo ao piso).
- Runs seguintes: o índice é re-baixado, mas `enqueue` é INSERT OR IGNORE por URL e a parada
  known-url/`added===0` segue valendo — só o novo entra (log `rundown: N artigos (M novos)`).
- Modo educado: comportamento exatamente como ANTES da implementação (8 cards via HTML, sem datas
  na listagem — descrito nas seções 4–7), pois o endpoint disallowed nunca é consultado.