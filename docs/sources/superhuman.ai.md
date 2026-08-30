# Análise de fonte — https://www.superhuman.ai/ (Superhuman)

- **Data da análise:** 2026-08-30
- **Analista:** sub-agente `onda1-analise-superhuman` (worktree `20260830-132425-15326/onda1-analise-superhuman`)
- **Código-base de referência:** `/Volumes/Ext2TB/Projects/newsletter-crawler` @ `3c8b22d` (2026-08-30)
- **Arquivos de evidência (HTML real baixado, minificado — as linhas citadas são do arquivo salvo):**
  - `/tmp/sh-analyse/home.html` — home (674 KB)
  - `/tmp/sh-analyse/archive.html` — `/archive` página 1 (500 KB)
  - `/tmp/sh-analyse/archive-p2.html`, `page-5.html`, `page-10.html`, `page-15.html`, `page-20.html`, `page-25.html`, `page-100.html`, `page-109.html` — amostras de paginação
  - `/tmp/sh-analyse/post-ai-inflection.html` — issue `/p/ai-is-hitting-an-inflection-point-says-jensen` (763 KB)
  - `/tmp/sh-analyse/posts.html` — `/posts` (API JSON beehiiv)
  - `/tmp/sh-analyse/arch-tweet.html` — `https://archive.superhuman.ai/2093016643089887357` (embed de tweet arquivado)
- **Probes executados com o código REAL do crawler:** `probe.mjs`/`dbg-*.mjs` em `/tmp/sh-analyse` (importam `src/fetch.js`, `src/selectors.js`, `src/parse-core.js` do BASE_DIR; leitura apenas, nada escrito no repo).

---

## 1. Descoberta do site

- **Plataforma:** a Superhuman roda em **beehiiv** — `robots.txt` é o default beehiiv (`# beehiiv default robots.txt`, robots.txt:1). Apenas `Disallow: /login` para `User-agent: *`; sem bloqueio de crawler, sem captcha, sem Cloudflare.
- **robots.txt real** (`curl -sL https://www.superhuman.ai/robots.txt` → HTTP 200):
  ```
  # beehiiv default robots.txt
  User-agent: *
  Sitemap: https://www.superhuman.ai/sitemap.xml
  Disallow: /login
  ```
  `Crawl-delay: 10` existe **só** para `AhrefsBot`, `AhrefsSiteAudit` e `MJ12bot` — não se aplica ao nosso UA (`NewsletterArchiver/1.0`); nossa politeness padrão (jitter 0.5–1.5× de `REQUEST_DELAY_MS`) é suficiente.
- **Home** (`https://www.superhuman.ai/`, HTTP 200, 674 KB, SSR) é uma **landing**: carrossel "embla" com os **6 últimos posts** (`<a href="/p/..." class="...embla__slide__number" aria-label="...">`, home.html). Título `<title>Home | Superhuman AI</title>`.
  - **A home NÃO tem link para o arquivo** — `href="/archive"` e o texto "Archive" têm **0 ocorrências** na home (verificado por grep). A navegação de cabeçalho é montada por JS.
  - Logo, **o seed da fonte não pode ser a home**: dali o crawler só veria 6 issues e zero paginação.
- **Arquivo de edições passadas = `/archive`** (`https://www.superhuman.ai/archive`, HTTP 200, `<title>Archive | Superhuman AI</title>`, 500 KB SSR):
  - Lista **10 issues por página**, em ordem **decrescente de data** (a mais recente primeiro).
  - Paginação: **`?page=N` numérica** — página 1 tem `<a href="/archive?page=2">` (archive.html:438, âncora com texto "Load more"); a página 2 tem `?page=3`, etc.
  - Outros caminhos testados: `/archive/all`, `/articles`, `/editions`, `/issues` → **404**; `/posts` → 200 mas é **JSON** (API beehiiv, ver §5).
  - **Extensão do arquivo:** começa em Jan/2023 — página 109 (`page-109.html`) tem só 3 posts (Jan 22–Feb 5, 2023) e **sem** link `?page=110` (fim do arquivo). Total ≈ **1.086 issues** (Jan/2023 → Ago/2026). Cadência evoluiu de ~semanal (2023, ex.: page-108: 10 posts entre Feb 12 e Mar 22) para **diária** (2024+, páginas contíguas dia a dia, inclusive fins de semana).
- **Sitemap** (`/sitemap.xml`): além dos `/p/...`, lista **páginas-guia evergreen** de topo (`/10-best-chatgpt-plugins-for-2025`, `/200-chatgpt-prompts-for-professionals`, …) que **não** aparecem no `/archive` — irrelevantes para a captura.

## 2. Tipo da fonte: **index** (com ressalva na detecção automática)

**Evidência no HTML real (`archive.html`):** os 10 links da página são **internos, de mesmo host, formato `/p/<slug>`** — cada um é **uma EDIÇÃO inteira** da newsletter (um post diário com várias notícias), não um artigo único:

```
<a href="/p/sunday-special-fda-greenlights-drug-to-transform-pancreatic-cancer-care" ... aria-label="Sunday Special: FDA greenlights drug to transform pancreatic cancer care">
<a href="/p/ai-is-hitting-an-inflection-point-says-jensen" ...>
<a href="/p/anthropic-launches-the-claude-academy-with-355-resources" ...>
```

E a página da issue (`post-ai-inflection.html`) é um **roundup**: `readableLinks` (código real) encontra **35 links externos** e **6.481 chars de prosa** — estrutura de edição com seções (h2): "How this week shaped AI: All the major news and releases", "What's trending on socials & headlines today", "Your voice is your best prompt engineer", "Friday Fun", "Which one is AI generated?", mais CTA de assinatura. Ou seja: **issue → dezenas de itens** = definição exata de `index` (crawl.js:121-123: `childKind = 'roundup'`).

**Ressalva — `detect-type` pode errar para `listing`:** o `npm run add` sem `--type` consulta a IA (`detectSourceType`, src/detect-type.js) e, em **fail-open, cai na heurística**. A heurística (`heuristicType`, detect-type.js:48-55) conta "links que parecem edição" com `ISSUE_LINK_RE` (`/issues|/editions|/archive|/newsletters|/numbers/<x>|/NNN|/AAAA/MM`) — **`/p/<slug>` NÃO casa nenhuma dessas formas**, então `issueLikeInternalLinks = 0` → palpite heurístico = **`listing`**. Com a IA disponível o palpite certo é alcançável (URL `/archive` casa `INDEX_PATH_RE`, 10 links internos, prosa ~135 chars, amostra mostra slugs de edição), mas **não conte com ela**: a instrução do orquestrador deve **confirmar o tipo e (se preciso) forçar `--type index`**, senão cada link `/p/` seria tratado como artigo avulso (o que ainda "funcionaria" mas sem curadoria por seção e sem âncora de issue).

## 3. Mecanismo de DATA

### 3.1. Na listagem (`/archive` — alimenta `dateNearLink` e o piso `--since`)
Cada card de issue tem a data em **texto** dentro de um `<span>`:

```html
<div class="flex flex-row gap-1 items-center flex-wrap justify-start">
  <div class="flex justify-start">
    <span class="_1mnetjdb text-xs w-fit whitespace-nowrap">Aug 30, 2026</span>
  </div>
</div>
```
(archive.html:438 — mesmo padrão nos 10 cards; datas de cada página: `Aug 30, 2026` … `Aug 21, 2026` na p1; p2: `Aug 20` … `Aug 11`; p25 cruza o piso: `Jan 2, 2026`, `Dec 31, 2025` … `Dec 19, 2025`).

**Cadeia `dateNearLink` (src/selectors.js:120-145) verificada na página real:**
| passo | resultado |
|---|---|
| (1) spec de data derivado por IA (`deriveDateSelector`) | **é o único que funciona com robustez** — espec `{date_selector: 'span.whitespace-nowrap'}` → **10/10 itens datados** (verificado com `applyLinkSelectorWithDates` no código real) |
| (2) `<time datetime>` (link ou `<li>` ancestral) | **não existe** no HTML do archive (0 ocorrências) |
| (3) `[class*="date"]` no container | **falha**: a classe real da data é hasheada `_1mnetjdb` (não contém "date") |
| (4) regex estrita de data no texto curto do container | **falha por causa do `.text()` do cheerio**: os spans inline são concatenados sem espaço → container vira `"Sunday Special: … cancer careZain KahnAug 30, 2026"` — o `\b` antes de "Aug" não casa (n→A, ambos word-chars) → `validDateText` retorna null. (No HTML cru o `>` antes de "Aug" daria o boundary; no texto concatenado não.) |

**Consequência:** sem `deriveDateSelector` (que só dispara com `--since` ativo e chave LLM, crawl.js:309-341), a listagem fica **sem datas** e o piso `--since` **não corta a paginação** (`below` fica 0). A parada então depende de `added===0`/known-url/`--max-pages`. Ver §6/§8.

### 3.2. Na página da issue (âncora do roundup)
`extractPublishedDate` (parse-core.js:261) acha **dois** sinais no SSR:
- `<meta property="article:published_time" content="2026-08-28T11:02:50.000Z"/>` (post-ai-inflection.html:1)
- JSON-LD `"datePublished":"2026-08-28T11:02:50.000Z"` (post-ai-inflection.html:9)

Verificado com o código real: `extractPublishedDate(html) = "2026-08-28T11:02:50.000Z"`. A data bate com a da listagem (Aug 28). Nas issues, porém, a data **autoritativa** vem do PAR da listagem (`frontier.discovered_date` herdado no `enqueue`, crawl.js:45-47 + `roundupIssueDate` crawl.js:461-466) — ou seja, o texto "Aug 30, 2026" do span vira a data da issue; o meta só é fallback.

## 4. Mecanismo de LINK dos itens

- **Issues ← arquivo:** `a[href*="/p/"]` dentro de cards `div.embla__slide > a` (archive.html:438). `applyLinkSelector('a[href*="/p/"]')` → **10 links** na p1 (o seletor esperado derivado pelo Pro é algo equivalente; validado: `validateLinkSelector` exige ≥ 3).
- **Itens de notícia ← issue:** os links externos vivem no **corpo do Readability** da issue — `readableLinks(post-ai-inflection.html)` → 35 links (excerto com host e âncora):
  - notícias reais: `nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-second-quarter-fiscal-2027` (~linha 695), `www.cnbc.com/2026/08/27/nvidia-nvda-q2-earnings.html`, `claude.com/blog/cowork-built-in-browser/`, `investor.salesforce.com/.../Salesforce-Delivers-Record-Second-Quarter-...`, `spectrum.ieee.org/silico-ai-interpretability`, `time.com/collection/time100-ai/2026/`, `aiandeducation.mit.edu/report/` (~10-12 por issue)
  - tools/startups: `x.ai/bot`, `f500-ai.netlify.app`, `vendo.run`, `www.ninjo.ai`, `ojo.art`, `www.heylemon.ai` (3× repetido)
  - embeds de tweet **arquivados no domínio próprio** `archive.superhuman.ai/<id>`: 8 por issue (ex.: `https://archive.superhuman.ai/2093016643089887357` — retorna HTTP 200 com o tweet "Joe Pompliano (@JoePompliano) on X", arch-tweet.html)
  - sponsors/ads: `srv.buysellads.com/ads/long/x/...` (3×), `hubs.ly/...`, `ref.wisprflow.ai/superhumanai`, `www.joinsuperhuman.io/ad-sponsorships`
  - links internos cruzados: `www.superhuman.ai/p/chatgpt-work-gets-website-login-access#:~:text=...` (2×, com fragmento `#:~:text=` — o `normalizeUrl` remove o hash, e `hostOf` = mesmo host → filtrados como internos em `consolidateItems`, curate.js:137)

## 5. Gotchas REAIS verificados no site

1. **Sem anti-bot / Cloudflare / captcha.** `isBlockedPage` = false nas 3 páginas; `fetchSmart` retornou **`rendered=false`** (estático via `got`) para home, archive e issue — o HTML cru tem conteúdo completo (`looksEmpty`=false: archive com 19+ links e dezenas de KB de texto). **Playwright nunca dispara** (`needsJs` nunca é setado).
2. **UA de bot funciona igual a UA de navegador:** `curl` com `NewsletterArchiver/1.0` (nosso default) → HTTP 200 com os mesmos 500 KB e 10 cards + 10 datas. Modo agressivo **desnecessário** (mas inofensivo; é o default).
3. **`/posts` é uma API JSON interna (beehiiv):** `GET /posts` (e `?page=2`) retorna `{"posts":[{id, web_title, slug, audience, is_premium, override_scheduled_at, created_at, ...}]}`, 30 posts/página. **O crawler não tem atalho beehiiv** (o atalho é só Substack, `isSubstack` → probe de `/api/v1/archive` que beehiiv não serve → caminho normal). A API fica documentada aqui como otimização futura (espelhar `substack.js`).
4. **Data na listagem depende 100% do spec de data por IA** (ver §3.1): fallbacks genéricos de `dateNearLink` falham no layout beehiiv. Se `deriveDateSelector` não validar (Flash/high, gate `>= max(3, 50%)`, crawl.js:317-321), o `--since` não corta e o walk vai até o fim do arquivo (109 páginas = ~1.086 issues) em banco fresco.
5. **Sem paywall:** `"premium_enabled":false` no config embutido (archive.html) — todas as edições free; nada de gating.
6. **Lazy-load/scroll:** a listagem **não** é feed infinito — o "Load more" é um `<a href="/archive?page=2">`; a paginação é numérica. O caminho renderizado (scroll/`clickLoadMore`) **não é usado** (HTML estático completo). Se algum dia `looksEmpty` mudar de ideia, o perfil `listing` rola/colhe e `clickLoadMore` acharia o botão ("Load more" casa `more|load`), mas a navegação por `?page=` do `findNextPage` é o caminho natural.
7. **Embeds de tweet em domínio próprio (`archive.superhuman.ai`)**: `hostOf` ≠ `www.superhuman.ai` (util.js:71-77 preserva subdomínio) → **não são filtrados** como internos; a curadoria LLM pode cadastrar itens apontando para essas páginas (que respondem 200 com o texto do tweet — enriquecimento "funciona", mas é ruído: ~8/issue). Filtrar por host no futuro (ou aceitar e deixar o `verify` julgar).
8. **Frequência/cadência:** evolução semanal (2023) → diária (2024+), com **folgas** em feriados (p25: faltam Dec 24-26, Dec 30-31 2025 e Jan 1, 2026). Não assumir 365/ano — para o piso de 2026-01-01 o efeito é pequeno (ver §7).
9. **"Friday Fun" / "Which one is AI generated?" / CTAs** ("Want more?", "What did you think of today's email?") são seções de boilerplate/interação — a curadoria pode gerar itens de brinquedo; os rótulos SPONSOR/other devem absorver a maior parte.

## 6. Mapeamento para o nosso código (caminho exato)

Seeded com **`https://www.superhuman.ai/archive`**, tipo `index`, o crawl faz:

1. **Listing** (`processListing`, crawl.js:118-239): `isSubstack` → probe beehiiv falha → segue. `ensureAllowed` → modo agressivo default ignora robots (ou politeness: permitido). `fetchSmart(url, {profile:'listing', sinceDate})` → **estático** (`rendered:false`), sem harvest de scroll.
2. **Seletor de links:** sem sel cacheado → `deriveLinkSelector` (Pro, xhigh) sobre a página podada → candidato tipo `a[href*="/p/"]` → `validateLinkSelector` ≥ 3 → OK, cacheado em `www.superhuman.ai:listing:/archive` (`domainSig`; page 2 mantém o mesmo sig pois query não entra).
3. **Data dos itens (com `--since`):** `applyLinkSelectorWithDates` → fallbacks genéricos falham (0/10, §3.1) → dispara `deriveDateSelector` (Flash, high; gate `dated.length >= 3 && nenhum parseable` — 10 ≥ 3 ✓) → spec tipo `{date_selector:'span.whitespace-nowrap'}` → trial 10/10 → **cacheado** (`date_selector`/`date_attribute`/`date_regex` na tabela `selectors`).
4. **`crawlArchive` (crawl.js:265-420):** p1: 10 links datados ≥ piso → enqueue 10 roundups com `discovered_date = "Aug 30, 2026"`…; `below` só > 0 na página ~25 (Jan 2 enfileira; Dec 2025 fica abaixo) → `floorHit` + parada por piso. Sem datas (se 3 falhou): páginas até `added===0`/known-url/`--max-pages`.
5. **Paginação (`findNextPage`, crawl.js:423-451):** p1 não tem `?page` → sem `rel=next` → **LLM `deriveNextLink`** vê o `<a href="/archive?page=2">Load more</a>` e devolve a URL (seletor cacheado como `next_selector`); da p2 em diante `?page=N` → incremento **síncrono, sem LLM**. Atenção: `?page=110` devolveria página vazia → para por "sem links".
6. **Roundup** (`processRoundup`, crawl.js:468-543): `fetchSmart(url, {profile:'listing'})` → estático; data da issue = `job.discovered_date` (span do archive) — autoritativa; piso por issue (`below-since` skip). Com LLM: **`curateRoundup`** (curate.js) → Readability → markdown → **`splitIntoSections`** (curate.js:91-116) por headings h2 — issue tem ~5-6 seções → 5-6 agentes Flash em paralelo → `consolidateItems` filtra internos/sponsors (`SPONSOR_RE`/`JOB_RE` — buysellads/hubs.ly/wisprflow/joinsuperhuman casam; heylemon/vendo/ninjo/ojo ficam como tools) → itens `needs_enrich=1` com blurb do agregador, cadastrados na MESMA transação → passe de cobertura (`curate/coverage`) sobre links crus da página.
7. **Artigos/enriquecimento** (`processArticle`, crawl.js:598-932): cada item curado → `fetchSmart(url, {profile:'article'})` por alvo (nvidia/cnbc/claude/…; estáticos na maioria; target com JS-gate → Playwright individual); corpo Readability ≥ 400 chars → limpeza IA por spans → data = **âncora da issue** (`enrichAnchorDate`, nunca a data do alvo) → `clampFutureDate` → verify/classify/summarize streaming. Alvos `archive.superhuman.ai` enriquecem com o tweet (200 OK). Falha/Pdf/blocked → `keepAggregatorVersion` (blurb permanece).
8. **`--since 2026-01-01`:** corta na p25 (Jan 2). **`MAX_CRAWL_DEPTH`=3:** o split artigo-é-roundup (`looksLikeCollection`, crawl.js:668-683) só aplica a avulso com `depth < 3`; itens curados nunca dividem; risco baixo.
9. **Anti-bot:** `isBlockedPage` nunca dispara (verificado). **Paginação é ~109 páginas no total** — o piso de data é o que torna o backfill viável.

## 7. Volume esperado

- **Frequência:** **diária** em 2026 (verificado: p1–p25 contíguas dia a dia; p25 mostra quebra só no Natal/Ano Novo).
- **Issues desde 2026-01-01 até 2026-08-30:** **≈ 241** (pages 1–24 inteiras = 240 com Aug 21 → Jan 3, + Jan 2 na p25; Jan 1 não publicado).
- **Itens por issue:** ~35 links externos no corpo → após filtro de sponsor/internal/duplicados/embeds de tweet ≈ **10–15 itens curados** (news ~8-10 + tools ~3-5 + eventuais releases).
- **Total do backfill:** ≈ 241 issues → **~2.400–3.600 artigos** para enriquecer.
- **Páginas do arquivo a visitar com `--since`:** ~25 (de 109 totais). Sem `--since`/sem spec de data: **109 páginas, ~1.086 issues** — proibitivo na 1ª coleta.
- **Custo estimado (referência captura Node Weekly: ~US$0,0045/artigo all-in com perfil Flash):** ~US$ 11–18 de LLM para o backfill completo + curadoria (~1.200 chamadas de seção) — **da ordem de US$ 15–25** no total; tempo estimado 2–4 h de crawl (ritmo ~45 jobs/min + curadoria/sweeps).

## 8. Recomendação final

**Comando sugerido (orquestrador):**
```
npm run add -- https://www.superhuman.ai/archive --name "Superhuman"   # conferir o tipo detectado!
# se detectar 'listing' (heurística sem IA) ou por segurança:
npm run add -- https://www.superhuman.ai/archive --name "Superhuman" --type index
```
- **URL seed: `/archive`, NUNCA a home** (home não linka o arquivo e só tem 6 issues no carrossel).
- **Tipo esperado: `index`.** O `detect-type` com IA deve acertar (URL `/archive` + 10 links internos + prosa mínima); **em fail-open heurístico dirá `listing`** (porque `/p/` não casa `ISSUE_LINK_RE`) — por isso a conferência do tipo é o ponto crítico do `add`. Sintoma de tipo errado: itens salvos sem `issue_url`/`section`/`kind` e sem curadoria por seção.

**Seletores prováveis (serão derivados e cacheados):**
- `link_selector`: algo como `a[href*="/p/"]` (10 links/página).
- `date_selector`: `span.whitespace-nowrap` (validado 10/10 na página real) — se a IA derivar `span` genérico (0/10, pega o autor) ou só `date_regex` (0/10, boundary), re-derivar ou validar pós-1ª run com `ncrawl inspect`.
- Paginação: `?page=N` (síncrono da p2 em diante; 1ª página depende de `deriveNextLink` via link "Load more").
- Extração da issue: Readability resolve (35 links / 6,5k chars) — nenhum `content_selector` esperado.

**Bounds da 1ª coleta (crítico):**
```
npm run crawl -- --sources "Superhuman" --since 2026-01-01 --max-pages 30 # (~241 issues; p25 corta no piso)
```
Só remover `--max-pages` depois de confirmar no `inspect` que a spec de data foi derivada (senão o walk vai às 109 páginas). Runs seguintes (incremental) param por known-url/`added===0` na p1.

**Riscos:**
1. **Data da listagem não pareada** (spec de data falhou) → backfill inteiro sem piso; mitigado com `--max-pages` + conferência do `dateSelector` no inspect.
2. **Itens apontando para `archive.superhuman.ai`** (embeds de tweet) — ruído ~8/issue; não quebram (200 OK), mas vale considerar exclusão futura de host.
3. **Sessões de boilerplate** ("Friday Fun", CTAs) geram itens fracos — o verify ok/suspect/junk e a curadoria absorvem; revisar amostra pós-1ª run.
4. **Custo/tempo do backfill** ~US$ 15–25 e 2–4 h — usar `--budget` se precisar conter (retomável).
5. **Mudança de layout beehiiv** (classes hasheadas mudam com o tema): o self-healing de `validateLinkSelector` + re-derivação cobre (crawl.js:171-177).

---
*Sem alterações de código de produção — apenas este documento de análise.*