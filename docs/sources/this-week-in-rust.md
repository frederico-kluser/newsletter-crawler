# Análise da fonte: This Week in Rust (https://this-week-in-rust.org)

- **Data da análise:** 2026-08-30
- **Fonte:** This Week in Rust — newsletter semanal da comunidade Rust (desde 2013, edições 1–666)
- **URL canônica do índice:** `https://this-week-in-rust.org/blog/archives/index.html` (**o `index.html` faz parte do path**; `/blog/archives/` também responde 200 com o mesmo conteúdo — GitHub Pages resolve o DirectoryIndex. O link "Archives" na navegação do próprio site aponta para a versão com `index.html`.)
- **Executado por:** sub-agente de análise `onda1-analise-twir`
- **Método:** fetch real (curl + o próprio código do crawler rodado contra o HTML baixado), sem chutes.

---

## 1. Descoberta do site (evidência real)

```
curl -sL -A "<UA de navegador>" https://this-week-in-rust.org/blog/archives/index.html
→ HTTP 200 | 292.048 bytes | text/html; charset=utf-8 | 0,19s | url=https://this-week-in-rust.org/blog/archives/index.html
```

- **Hospedagem:** GitHub Pages puro. Headers: `server: GitHub.com`, `via: 1.1 varnish`, `x-served-by: cache-gru-*`, `x-cache: MISS`, `cache-control: max-age=600`, `etag` + `last-modified` (HTML estático versionado por data de build). Fastly na borda → fetch é rápido e barato.
- **Sem Cloudflare, sem anti-bot na página** (verificado: nenhum header de challenge, HTML 100% estático, ver §3).
- **TLS:** HTTP/2 + HSTS (`strict-transport-security: max-age=31556952`), sem erro de certificado — é o único host, então não depende do `ignoreHTTPSErrors` do Playwright.
- **Estrutura de TODO o arquivo:** é **uma página única** com **669 linhas** dentro de **um `<ul>`** (mais a navegação do site). **Não há paginação** (`crawlArchive` faz 1 passe e para). As 669 linhas são, por ano: 2013=31, 2014=35, 2015=48, 2016=51, 2017=52, 2018=52, 2019=53, 2020=52, 2021=52, 2022=52, 2023=52, 2024=52, 2025=53, 2026=34.
- **Edições:** slugs `this-week-in-rust-N` de **1 (2013-06-07) até 666 (2026-08-26)**, 662 slugs únicos. Os números "faltantes" 8, 22 e 127 existem com slugs alternativos (`last-week-in-rust-8`, `these-weeks-in-rust-22`, `these-weeks-in-rust-127`); o 28 parece nunca ter sido publicado. Há ainda 4 posts antigos sem número ("State of Rust 0.7/0.8/0.9/0.11", 2013–2014) dentro das mesmas linhas do índice — comportamento normal do arquivo, não um problema.

## 2. Tipo da fonte: **index** (a página lista EDIÇÕES) — evidência

Cada linha do arquivo é um `<li>` com **data + título + href**, e **o href embute a data**:

```html
<li>
<div class="row post-title">
  <div class="col-xs-12 col-sm-4">
    <span class="small text-muted time-prefix">
      <time pubdate="pubdate" datetime="2026-08-26T00:00:00-04:00">26 AUG 2026</time>
    </span>
  </div>
  <div class="col-xs-12 col-sm-8 text-right custom-xs-text-left">
    <a href="https://this-week-in-rust.org/blog/2026/08/26/this-week-in-rust-666/">This Week in Rust 666</a>
  </div>
</div>
</li>
```

- **Índice semântico:** 669 links, **todos internos** (mesmo host), todos para `/blog/YYYY/MM/DD/slug/` — ou seja, cada link é uma **edição**, e cada edição contém ~240 links **externos** (ver §3). Isso é exatamente o formato `index` do crawler: filhos = `roundup` (issues), cada issue virada em itens curados por seção.
- **Verificação com o código real (`src/detect-type.js`):** `gatherTypeSignals({url: /blog/archives/index.html, links, proseLen: 200})` → `{urlMatchesIndexPath: false, internalLinks: 674, externalLinks: 4, issueLikeInternalLinks: 669, proseChars: 200}` → `heuristicType()` → **`index`**. Detalhe: `urlMatchesIndexPath` é `false` porque `INDEX_PATH_RE` espera `archive` seguido de `/|fim` e o path é `archives/` (plural) — quem garante o `index` são os 669 links internos "de edição" (`ISSUE_LINK_RE` casa `/2026/08/26/`).
- **`dateNearLink` pode derivar a data do próprio item:** o `<time datetime>` está no **mesmo `<li>`** do link → o fallback #2 da cadeia (`$el.closest('li').find('time[datetime]')`) dá a data **sem precisar de seletor de data por IA**. Verificado rodando `applyLinkSelectorWithDates` com `dateSpec: null` no HTML real: seletor `.row.post-title a` → **669 links, 669 pareados com data parseável**. (Seletor mais solto `.row a` pega 677, incluindo rodapé — melhor `.row.post-title a`.)

## 3. Página da edição (estrutura do corpo)

Edição real analisada: **666** (`/blog/2026/08/26/this-week-in-rust-666/`), 41.057 bytes:

- **100% estático, zero JS:** `0` scripts externos, `0` blocos `<script>` inline. **Jekyll** (tema "rusted" — CSS em `/themes/rusted/`), geração estática pura. **Nenhuma página do TWIR exige Playwright** — `looksEmpty` (menos de 5 links OU menos de 500 chars de texto) nunca dispara nas listagens nem nas issues.
- **Container:** `<article class="post-content">` contém todo o corpo. Cabeçalho com um único `<time pubdate datetime>` (data da edição) → `extractPublishedDate` retorna `"2026-08-26T00:00:00-04:00"` (também verificado: a issue tem JSON-LD? **não** — cai direto no `time[datetime]`; meta tags ausentes).
- **Seções:** `<h2>/<h3>` com âncoras `toclink`: *Updates from Rust Community* (subseções *Official*, *Project/Tooling Updates*, *Observations/Thoughts*, *Rust Walkthroughs*, *Miscellaneous*), *Crate of the Week*, *Calls for Testing*, *Call for Participation; projects and speakers*, *Updates from the Rust Project* (*Compiler*, *Library*, *Cargo*, *Rustdoc*, *Rustfmt*, *Clippy*, *Rust-Analyzer*, *Rust Compiler Performance Triage*), *Approved RFCs*, *Final Comment Period*, *Tracking Issues & PRs*, *New and Updated RFCs*, *Upcoming Events* (por continente), *Jobs*, *Quote of the Week*. ~31 headings na edição 666.
- **Itens:** `<ul><li><a href="EXTERNAL">Título</a></li></ul>` — **137 de 143 `<li>` no corpo são só o link** (sem blurb); 5 têm texto extra (eventos com data/local); 48 têm múltiplos links (seções CFP/eventos com "saiba mais").
- **Links externos:** `readableLinks` (JSDOM/Readability no pool) → **276 links totais, 235 externos**; `linksInHtml` no HTML bruto → 289 totais, **239 externos**. Distribuição da edição 666: 105× github.com, 72× meetup.com, 14× luma.com, resto espalhado (blogs, rust-lang.org, users.rust-lang.org…). **Nada de cargo/anti-bot no próprio site.**
- **Readability + markdown:** `extractArticleAsync` funciona (`title: "This Week in Rust 666 · This Week in Rust"`, `publishedTime: null`); markdown resultante ≈ **27.781 chars**.

### ⚠️ Gotcha de curadoria (verificado com o código real): `splitIntoSections` NÃO divide por seção no TWIR

Os headings do HTML viram markdown com âncora de link do TOC: `## [Crate of the Week](#crate-of-the-week)` e `### [](#approved-rfcs)[Approved RFCs](https://github.com/rust-lang/rfcs/commits/master)`. O `sectionTitleOf` de `src/curate.js` rejeita linhas com `](` (guard anti-heading-de-item) → **todos os headings do TWIR são rejeitados** → `marks.length < 2` → o `splitIntoSections` cai no fallback **por tamanho** (`chunkMarkdown`, teto `CURATE_CHUNK_CHARS`=24.000). Rodado contra a issue 666 real: **2 fatias `{section: null}`** (23.106 chars + 4.673 chars) e **nenhum agente "por seção"**. Consequências:
- A curadoria **funciona** (o agente vê os headings no markdown e rotula `section` por julgamento próprio — "Official", "Crate of the Week"…), mas o fan-out esperado de "1 Flash por seção em paralelo" vira **2 agentes por issue** (2 chunks), não ~12 (MAX_SECTIONS).
- **Passe de cobertura provavelmente NÃO roda:** o guard em `src/curate.js:232` é `if (leftovers.length && leftovers.length <= 40)`. Leftovers = links externos do corpo bruto (239) − emitidos pelos agentes. Um agente Flash emite tipicamente 40–150 itens por issue (o prompt fala em "15–25 itens típicos", mas TWIR tem MUITO mais links) → leftovers ≈ 90–200 → **> 40 → passe de cobertura ignorado**. Ou seja: o recall depende do(s) agente(s) de chunk; a rede de segurança determinística não engata no TWIR moderno. Vale acompanhar o trace `curate/coverage` no `ncrawl inspect` na primeira captura real (se aparecer `skipped`/ausente, é isso).

## 4. Mecanismo de DATA para o piso `--since 2026-01-01`

- **No índice:** data em `<time pubdate datetime>` **no mesmo `<li>`** do link → `dateNearLink` (fallback #2) → vira `discovered_date` no `enqueue` (6º parâmetro) → **`frontier.discovered_date` é a âncora AUTORITATIVA do roundup** (`roundupIssueDate` em `src/crawl.js:461-466`). O href também embute a data (`/2026/08/26/…`) — redundante, mas consistente com o `<time>` (conferido em todos os 669).
- **Na página da issue:** um único `<time pubdate datetime>` no cabeçalho → `extractPublishedDate` devolve a mesma data (fallback do `roundupIssueDate` e do `curateRoundup`). As duas fontes batem.
- **Formato parseável:** `2026-08-26T00:00:00-04:00` → `parseDate` → `2026-08-26T04:00:00Z` ✓ (também entende `26 AUG 2026`, formato visual). `clampFutureDate` inócuo (datas no passado).
- **Para `--since 2026-01-01`:** **34 edições** entram (2026-01-07 = #633 … 2026-08-26 = #666), cadência semanal **sem gaps > 9 dias**. No passe do arquivo: 669 pareados → 34 ≥ piso enfileirados como `roundup`, 635 `abaixoDoPiso` → `floorHit` → parada na primeira (única) página. Na segunda visita, todos os 669 são `isUrlKnown` → parada determinística por URL já capturada (sem LLM).

## 5. Gotchas verificados (resumo)

| Item | Status verificado |
|---|---|
| `robots.txt` | **404** (GitHub Pages "File not found") → `checkRobots` fail-open (`robotsParser('')` → `isAllowed=true`); de qualquer forma o modo **agressivo é default** (`AGGRESSIVE_DEFAULT`, `src/config.js:290`; `--no-aggressive` volta ao educado) |
| Cloudflare / anti-bot | Ausente no site (0 scripts, headers limpos); alvos externos (meetup.com etc.) podem ter challenge — coberto pelo `isBlockedPage` + keep-blurb (fail-open) |
| TLS | OK (HTTP/2, HSTS); GitHub Pages com Fastly na borda |
| Estático puro | Sim — **Jekyll**, sem JS-gating; `fetchSmart` fica no caminho `got` estático, sem Playwright, sem `needsJs` |
| Volume `--since 2026-01-01` | ~34 roundups × ~100–240 itens → **~3.400–8.000 jobs de artigo** na 1ª coleta (cada item curado vira um job `article` com `needs_enrich=1` = fetch do ALVO). Primeira coleta **SEMPRE com `--since` + `--max-articles`/budget** |
| `detect-type` | Heurística → `index` confirmado por execução real; LLM do `add` deve confirmar (sinais muito fortes) |
| Caching | `max-age=600` + etag — re-fetch do arquivo é barato; mas o crawler sempre baixa o HTML de novo a cada run (sem condicional GET no `fetchStatic` é OK: 292 KB) |

## 6. Mapeamento para o nosso código (caminho exato e riscos)

| Etapa | Onde | Comportamento para o TWIR |
|---|---|---|
| Fetch da listagem | `src/fetch.js` `fetchSmart` (603–636) + `looksEmpty` (588–598) | Estático (200, 292 KB, ≥5 links, ≥500 chars) → **nunca** cai no Playwright; `needsJs` não é setado |
| robots | `src/fetch.js` `checkRobots` (155+) + `crawl.js` `ensureAllowed` (101–107) | robots.txt 404 → fail-open allowed; agressivo default ignora |
| Tipo da fonte | `src/detect-type.js` | **index** (heurística verificada) |
| Extração de links do índice | `src/crawl.js` `crawlArchive` (265–420) + `applyLinkSelectorWithDates` (`src/selectors.js:154`) + `dateNearLink` (`src/selectors.js:120–145`) | Seletor provável `.row.post-title a` (669 links, validado ≥3); datas via fallback `time[datetime]` no `<li>` — `deriveDateSelector` (IA) **nem é necessário** (só roda se nada datar); piso `--since` para a paginação; `known-url` (`stmts.isUrlKnown`, 351–361) para o incremental |
| Enfileirar edições | `src/crawl.js` `enqueue` (34–47) | `enqueue(issueUrl, 'roundup', archivesUrl, sourceId, depth+1, it.date)` → data da listagem vira `frontier.discovered_date` |
| Piso por ISSUE | `src/crawl.js` `roundupIssueDate` (461–466) + `processRoundup` (485–492) | `discovered_date` é a autoridade; fallback `extractPublishedDate` da própria issue (mesma data, verificado) |
| Curadoria da edição | `src/curate.js` `curateRoundup` (171–357) | Readability → markdown → `splitIntoSections` (**2 chunks por tamanho, `section=null` — ver gotcha §3**) → `curateRoundupItems` (1 Flash por chunk, paralelo, stage `curate`) → `consolidateItems` (skip sponsor/job/interno; salva `news|tool|release`; `SPONSOR_RE`/`JOB_RE` em `src/curate.js:19-21`) → coverage pass (provavelmente ignorado, §3) → `insertArticle` + `enqueue('article', depth+1, issueDate)` com `needs_enrich=1`, `published_at=issueDate`, `issue_url=issueUrl` |
| Enriquecimento dos itens | `src/crawl.js` `processArticle` (598+) | Fetch do alvo (`profile:'article'`, clock 90s, PDF/`isPdfUrl` → kept-blurb); corpo fracassado/bloqueado → mantém blurb (`keepAggregatorVersion`, fail-open); **data final = data da ISSUE** (`enrichAnchorDate`, 568–572 — a data do alvo fica só no trace); `isBlockedPage` (`src/parse-core.js:226`) gateia todo save; roundup-detect de alvo-coleção limitado por `depth < MAX_CRAWL_DEPTH` |
| Profundidade | `src/config.js` `MAX_CRAWL_DEPTH = 3` (415) | índice=0 → issue=1 → item=2 → eventual coleção-aninhada=3 (raro) |
| Verificação/classificação/resumo | streaming pós-save + sweeps | Default ON; `--no-verify/--no-classify/--no-summarize` para controlar custo na 1ª coleta grande |

**Riscos no caminho mapeado:**
1. **`splitIntoSections` chunk-by-size** (não por seção) — paralelismo menor e rótulo `section` por julgamento do LLM (não as seções reais do TWIR). Não é erro, mas difere do esperado pelo pipeline "por seção".
2. **Coverage pass ≤ 40 leftovers** — provavelmente não engata no TWIR (239 links externos vs ~40–150 emitidos). Recall depende dos agentes de curadoria; conferir `curate/coverage` no inspect.
3. **Volume da 1ª coleta** — ~3,4–8 mil jobs de artigo. Usar `--since` + `--max-articles`/`BUDGET_USD` (fábrica Cooperpress já ensina isso).
4. **Alvos externos ruins/JS-gated** — meetup.com (72/issue!) e luma.com podem ser 403/challenge ou JS; o pipeline segura com kept-blurb, mas polui um pouco; Github é 105/issue e vai bem.
5. **Itens antigos com links mortos** — irrelevante com `--since 2026-01-01` (as 34 issues são recentes); se um dia for coletar histórico completo, esperar mais kept-blurb.

## 7. Recomendação final

- **Tipo esperado do `npm run add`:** **`index`** (confirmado pela heurística real; a IA do `detectType` verá os mesmos sinais). Comando sugerido:
  ```
  npm run add -- https://this-week-in-rust.org/blog/archives/index.html --name "This Week in Rust"
  ```
  (o `add` persiste em **`NC_HOME/sources.json`** — o `config/sources.json` do repo é só o seed de instalação nova; se quiser de fábrica, editar os dois.)
- **Seletores prováveis:** link `.row.post-title a` (attribute `href`, 669 links) — derivado pelo Pro no `deriveLinkSelector` e cacheado em `selectors`; **nenhum seletor de data por IA é necessário** (o `<time datetime>` do `<li>` cobre 669/669). `next_selector` não existe (página única).
- **Primeira coleta (obrigatório bounded):**
  ```
  npm run crawl -- --sources "This Week in Rust" --since 2026-01-01 --max-articles <N> [--budget <USD>]
  ```
  Esperado: 1 fetch do arquivo → 34 roundups → ~34 × 40–150 itens; depois o enriquecimento dos alvos nas próximas run (delta-only, `known-url` para).
- **Riscos finais:** (a) curadoria em chunks, não por seção; (b) coverage pass desligado na prática; (c) volume ~3,4–8k jobs na 1ª vez; (d) meetup.com/luma como alvos fracos; (e) sem robots.txt (fail-open ok), sem anti-bot no site, 100% estático — **fonte muito saudável para o crawler**.

## Apêndice — como reproduzir a evidência

```bash
# 1. Índice
curl -sL -A "<UA browser>" -o /tmp/twir-archives.html https://this-week-in-rust.org/blog/archives/index.html
# 2. Issue 666
curl -sL -A "<UA browser>" -o /tmp/twir-issue-666.html https://this-week-in-rust.org/blog/2026/08/26/this-week-in-rust-666/
# 3. robots.txt → 404
curl -s https://this-week-in-rust.org/robots.txt
# 4. Rodar o pipeline real do crawler sobre os arquivos (probe) — confirmou:
#    . parseDate("2026-08-26T00:00:00-04:00") ✓; extractPublishedDate → "2026-08-26T00:00:00-04:00"
#    . readableLinks(issue666) → 276 links (235 externos)
#    . splitIntoSections(markdown 27.781 chars) → 2 fatias {section: null}
#    . applyLinkSelectorWithDates(".row.post-title a", dateSpec=null) → 669/669 datados
#    . gatherTypeSignals + heuristicType → index
```