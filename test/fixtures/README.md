# test/fixtures

HTML e dados fixos para os testes offline e para os evals da migração Jev. Nada aqui é baixado durante
os testes. Qualquer `.js` nesta pasta é executado pelo `node --test`, porque o padrão dele pega
`test/**/*.js`. Por isso as fixtures novas são só `.html`, `.json` e `.md`.

## Fixtures da W0 (capturadas em 2026-09-26)

- **Como foram capturadas:** `curl -L --compressed`, com um GET público, sem cookie e sem JS, usando o UA de
  navegador do crawler (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/131.0.0.0 Safari/537.36`) e `Accept-Language: en-US`.
- **O HTML está cru e sem nenhuma alteração.** Nada foi removido. Uma página com mais de 2 MB seria descartada.
- **O manifesto legível por máquina** é o [`w0-manifest.json`](w0-manifest.json). Ele traz, para cada arquivo:
  a URL pedida e a URL final (depois do redirect), o status HTTP, o content-type, os bytes, o sha256 e o
  propósito. Para as páginas `clean/`, traz também os metadados do artigo no banco no momento da captura:
  `idAtCapture`, `verifyStatus`, `verifyNotes` e o tamanho do conteúdo salvo. Os ids mudam a cada restore;
  a chave estável é a URL.
- **Tamanho total:** cerca de 3,1 MB.
- **Conteúdo de terceiros:** as páginas são públicas e foram guardadas só para os testes, seguindo o precedente
  de `meiert-5-npx-helpers.html` e `vitest-release.html`. Para atualizar uma página, basta um novo GET com o mesmo
  UA; depois é preciso regravar o sha256 no manifesto.

### `clean/`: 12 páginas de artigo para o eval de limpeza (W3)

Os artigos são recentes, de hosts diferentes, e quase todos têm `verify_status = suspect` por lixo de
navegação. O conteúdo salvo no banco já está limpo (`cleaned = 1`), por isso o eval precisa do HTML cru.

| Arquivo | URL (GET) | Fonte no banco / veredito | Lixo esperado |
|---|---|---|---|
| `clean/therundown-openai-cuts-out-spacex-owned-cursor.html` | https://www.therundown.ai/articles/openai-cuts-out-spacex-owned-cursor | The Rundown / suspect | A página de UM artigo traz o boletim inteiro: várias notícias, saudação e blocos patrocinados |
| `clean/theguardian-cockroaches-search-rescue.html` | https://www.theguardian.com/technology/2026/aug/27/cockroaches-used-search-rescue-earthquakes-science-technology-australia | Superhuman / suspect | Chamada de newsletter no meio do texto, blocos "related" e "most viewed", rodapé enorme |
| `clean/ibm-think-ai-decision-making.html` | https://www.ibm.com/think/insights/ai-decision-making-where-do-businesses-draw-the-line | Superhuman / suspect | Bloco de assinatura intercalado no texto, navegação corporativa |
| `clean/eslint-v10-9-1-released.html` | https://eslint.org/blog/2026/08/eslint-v10.9.1-released | JavaScript Weekly / suspect | Seção "From the blog" com outros posts, navegação de docs |
| `clean/techcrunch-stripe-openrouter.html` | https://techcrunch.com/2026/08/16/stripe-will-reportedly-acquire-ai-gateway-startup-openrouter-for-7b | llmnews.ai / suspect | "Topics", "Subscribe…" e "Latest" no fim |
| `clean/remysharp-progressive-enhancement.html` | https://remysharp.com/2026/08/05/progressive-enhancement-inside-of-javascript | JavaScript Weekly / suspect | Quase limpa, serve de controle. Rodapé "Published … Edit this post." |
| `clean/lordgoatius-tail-call.html` | https://lordgoati.us/blog/tail-call | This Week in Rust / suspect | Menu do site (Home, Posts, Ternary, Github) antes do texto; muito código |
| `clean/csswizardry-container-timing-api.html` | https://csswizardry.com/2026/07/meaasuring-component-performance-with-the-container-timing-api | Frontend Focus / suspect | Data, espaço em branco e Table of Contents antes do texto |
| `clean/masterdev-conic-gradients-triangle.html` | https://master.dev/blog/when-you-need-to-make-a-triangle-think-conic-gradients (redireciona para blog.master.dev) | Frontend Focus / suspect | Bloco promocional "Want to expand your CSS skills?" no fim |
| `clean/mantine-changelog-9-6-0.html` | https://mantine.dev/changelog/9-6-0 | JavaScript Weekly / suspect | Apelo de patrocínio antes das notas; demos de UI (date picker "MoTuWeThFrSaSu") |
| `clean/goose-love-metadata-analysis.html` | https://blog.goose.love/posts/three-seconds-of-compilation-shaved-by-metadata-analysis | This Week in Rust / suspect | Sumário e títulos de seção duplicados no início |
| `clean/addyo-substack-agentic-skill-decay.html` | https://addyo.substack.com/p/agentic-skill-decay | JavaScript Weekly / ok | Estrutura do Substack (assinar, compartilhar, comentários) e JSON de config com "captcha" (falso positivo em HTML cru) |

Verificado em 2026-09-26: o `extractArticle` (Readability, em `parse-core`) extrai o título e o texto das 12
páginas, e o `isBlockedPage` dá `false` em todas. O Guardian, o Substack e o TechCrunch têm "captcha" ou
"recaptcha" no JSON de configuração. Um detector que olhe o HTML cru, em vez do texto visível, erraria nessas
três páginas.

### `listings/`: 4 páginas de listagem e arquivo das fontes configuradas (W5b, linkPick/nextPick)

| Arquivo | URL (GET) | Tipo | Verdade (links de item) |
|---|---|---|---|
| `listings/nodeweekly-issues.html` | https://nodeweekly.com/issues | index (Cooperpress) | `/issues/<n>`: 573 distintos |
| `listings/javascriptweekly-issues.html` | https://javascriptweekly.com/issues | index (Cooperpress) | `/issues/<n>`: 614 distintos |
| `listings/twir-archives.html` | https://this-week-in-rust.org/blog/archives/index.html | index | `/blog/YYYY/MM/DD/this-week-in-rust-<n>/`: 666 distintos |
| `listings/therundown-articles.html` | https://www.therundown.ai/archive (redireciona para `/articles`) | listing (Next.js) | `/articles/<slug>`: 8 artigos, mais a paginação `?page=2` com `rel="next"` |

O manifesto traz o `truthRegex` usado em cada contagem.

### Edições completas: curadoria e candidatos (W5a)

| Arquivo | URL (GET) | Propósito |
|---|---|---|
| `nodeweekly-638.html` | https://nodeweekly.com/issues/638 | Node Weekly #638 (2026-08-27): layout em tabela da Cooperpress, blocos de patrocínio e "IN BRIEF". O banco tem 23 itens curados dela. São 37 hrefs externos distintos |
| `twir-666.html` | https://this-week-in-rust.org/blog/2026/08/26/this-week-in-rust-666/ | This Week in Rust #666 (2026-08-26): seções h3 e listas longas de PRs. O banco tem 76 itens curados dela. São 216 hrefs externos distintos. É o teste de volume |

### `nav/`: navegação e bloqueio (W5b)

| Arquivo | Tipo | Propósito |
|---|---|---|
| `nav/listing-overlay.html` | sintética | Banner de cookies em overlay modal (`role=dialog`, `aria-modal`) que cobre o botão **Load more**: o clique é interceptado até aceitar. Cada Load more anexa 10 itens, até 3 vezes (de 10 para 40 itens), e depois o botão some. Tem ruído para o prefiltro: tags, redes sociais, `mailto:`, RSS, login e assets. Base presumida: `https://blog.example.test/posts/` |
| `nav/listing-pager.html` | sintética | Arquivo paginado, na página 2 de 5. Tem `<link rel=next/prev>` no head, `<a rel=next>` no paginador, números com `aria-current` e um "Older posts ›" sem `rel`. A próxima página é `/archive/page/3/`. Base presumida: `https://news.example.test/archive/page/2/` |
| `nav/challenge-cloudflare.html` | sintética | Interstitial anti-bot no estilo Cloudflare: "Just a moment...", Ray ID, `cf-turnstile`, "Enable JavaScript and cookies". Dá `isBlockedPage = true` |
| `nav/challenge-cloudflare-medium.html` | **real** | Desafio Cloudflare que a medium.com devolveu (HTTP 403) ao GET de https://medium.com/@yardenlaif/go-sync-or-go-home-waitgroup-5f074a03776e. O título é "Just a moment..." e o `innerText` vem vazio. Dá `isBlockedPage = true` |

As fixtures sintéticas são determinísticas, não dependem de recurso externo e não usam a data corrente. Elas foram
verificadas no Chromium do Playwright em 2026-09-26. No overlay, `elementFromPoint` sobre o botão devolve o
backdrop antes do consentimento. Depois dos 3 cliques ficam 40 itens, com datas decrescentes, e o botão
foi removido.

### Ficaram de fora

| URL | Motivo |
|---|---|
| https://www.newscientist.com/article/2582376-first-targeted-treatment-for-guillain-barre-syndrome-nears-approval | HTTP 406 com corpo vazio (bloqueio por UA ou headers) |
| https://ui.shadcn.com/docs/components/base/questionnaire | 1,9 MB, perto do teto de 2 MB. Ficou de fora para manter o total razoável |
| https://medium.com/@yardenlaif/go-sync-or-go-home-waitgroup-5f074a03776e | HTTP 403, desafio Cloudflare. Guardado como `nav/challenge-cloudflare-medium.html` |
| https://developerlife.com/2026/08/22/to-async-or-not-to-async-rust-mcp-server | Baixou (200), mas a meta de 12 hosts já estava cumprida |
| https://archive.superhuman.ai | Redireciona para `/login` (parede de login), não é uma listagem |
| https://golangweekly.com/issues | Baixou (200), mas usa o mesmo template Cooperpress dos outros dois índices |

## Fixtures anteriores à W0 (não alterar)

| Arquivo | Usado por |
|---|---|
| `crash-worker.js` | `parse-pool.test.js`: worker IPC que força crash, SIGSEGV, trava e echo. Só é carregado via `PARSE_WORKER_PATH` |
| `github-bullmq-releases.html` | `reextract.github.test.js`: página de releases real do GitHub, recortada |
| `github-bullmq-root.html` | Raiz de repositório do GitHub. Nenhum teste lê este arquivo por nome hoje (grep em 2026-09-26) |
| `json-page.html` | `reextract.github.test.js`: página que é JSON puro |
| `meiert-5-npx-helpers.html` | `clean.truncation`, `commands.reextract` e `crawl.prune-frame`: artigo real |
| `vitest-release.html` | `commands.reextract`, `parse-core.github` e `clean.truncation`: release notes reais |
