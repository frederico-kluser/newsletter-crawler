# Diário do newsletter-crawler (documento vivo)

> O **porquê** e o **como chegamos lá**. O *o quê* canónico (comandos, contratos, invariantes) vive no
> [`AGENTS.md`](AGENTS.md) e em [`docs/`](docs/); o histórico de versões no [`CHANGELOG.md`](CHANGELOG.md).
> Aqui ficam as **decisões datadas, descobertas e lições** — cada entrada leva data e cresce a cada tarefa.
> Formato sugerido: **Contexto → Decisão → Lição/Descoberta** (à moda de "Como ficou"). Este ficheiro é
> ingerido pela memória CoALA do projeto (regra `journal`, tags `docs,journal,lesson`), por isso:
> nada de segredos, só caminhos e referências.

---

## 2026-10-11 — Coleta completa desde 2026-01-01 + o `max_tokens` que estrangulava o raciocínio

- **Contexto:** pedido autónomo: correr TODOS os newsletters desde 2026-01-01 ignorando o já
  processado, com monitoramento em tempo real (trace `--llm-dev`) e "perante problema de código:
  parar, analisar, corrigir, retomar". A varredura `crawl --since 2026-01-01` cobriu as 11 fontes
  até ao piso com dedup a parar em território conhecido (4.191 links vistos · 0 novos perdidos ·
  0 perdas de `content_hash`).
- **Bug 1 (custo/qualidade):** o `stageMaxTokens` (teto de SAÍDA, adicionado a 2026-10-10 contra
  completions degeneradas) era enviado como `max_tokens` TOTAL — mas em modelos de raciocínio o
  campo cobre reasoning + conteúdo. O raciocínio comia o teto inteiro (`reasoning_tokens ==
  completion_tokens == max_tokens`) e a resposta vinha com `content` VAZIO: 101 chamadas truncadas
  (`finish_reason=length`) numa run (contentSelector 33/56!, classify 22/561, articleClean 11/73)
  — o parse lia "JSON inválido" e cada retentativa repagava o raciocínio.
- **Correção:** `max_tokens = stageMaxTokens(stage) + reasoningTokensAllowance()` (folga
  `LLM_REASONING_ALLOWANCE`, default 8.000; 0 = comportamento antigo) e o guard degenerado passou
  a distinguir CONTEÚDO (`completion − reasoning > 1.2×` do teto de saída = loop de geração) de
  total (`> 1.2×` do enviado = provider ignorou o `max_tokens`). Efeito medido na run seguinte:
  139 parses ok, ZERO `json-retry`, ZERO truncamentos (vs 36 retries + 8 falhas + 101 truncamentos).
- **Bug 2 (resiliência):** erros de TRANSPORTE não tinham retry (só 429 e JSON inválido): 16/137
  chamadas de classify penduraram 180s no provider num burst e cada uma perdeu uma faceta (artigo
  ficava `partial`). Correção: `isTransientTransportError` — timeout duro/rede/5xx re-tenta (máx.
  2); 4xx e abort do JOB (deadline/cancel) nunca. Recuperação dos parciais: re-classificar com
  `classifyArticleRow` (upsert limpo de classificação + tags).
- **Lição 1:** "teto de saída" e "teto total (com raciocínio)" são coisas diferentes; o trace é que
  separa truncamento de loop — `completion_tokens_details.reasoning_tokens` + `finish_reason` por
  stage (receita no AGENTS.md, secção do trace).
- **Lição 2:** chamadas que penduram SEMPRE (raciocínio lento até ao limite em prompts específicos,
  tipicamente as facetas de vocabulário grande) não são transitórias: 3×180s e a faceta
  não-obrigatória continua `partial` — fail-open por design, marcado como qualidade baixa.
- **Operação:** run #7 zumbi (`running` órfão desde 2026-10-09) e a run #17 morta a meio para o
  fix, ambas saneadas para `interrupted`. Os picos de data do audit (Golang 2026-08-30, llmnews
  2026-06-30/2026-09-10) são resíduo de alvos mortos/redirector Cooperpress: remédio documentado
  `scripts/reattribute-dates.mjs --target-dates --date <pico>`.

## 2026-10-10 — Consolidação inicial + memória CoALA v2.1 (adoptado do projeto `anonymous-browser`)

- **Pedido:** analisar as técnicas do projeto `anonymous-browser` (incluindo a sua skill de memória CoALA)
  e adoptar as que servem aqui.
- **Adoptado:** motor `coala.py` v2.1.0/schema v3 (ids por conteúdo, `import --jsonl` portátil,
  `forget --tag` para privacidade, fix de LIKE nas tags); migração da skill
  `.agents/newsletter-crawler-coala-memory-agent-skill` → `.agents/newsletter-crawler-agent-skill`
  (convenção obrigatória do instalador); política git **`track-dump`** (a base `memory/coala.sqlite`
  fica fora do git; o dump canónico `memory/coala.canonical.jsonl`, mascarado e determinístico,
  É versionado — exigiu re-incluir só essa pasta no `.gitignore` da raiz); regras de ingest novas
  (`AGENTS.md` → procedural, `JOURNAL.md` → lesson) e este diário.
- **Lição:** as convenções de uso da memória que faltavam aqui vieram do `CLAUDE.md` deles — a mais
  importante é a **regra de sobrevivência**: material que tem de sobreviver entra por
  `add`/`import --jsonl` com chave própria, **nunca** por regra do `ingest.json` (o ingest **expira**
  segmentos que desaparecem do ficheiro).

As entradas seguintes consolidam decisões grandes já documentadas no `AGENTS.md`/`docs/`
(proveniência aí; aqui fica o porquê em poucas linhas).

### Piso por fonte (`sources.cursor_date`) em vez de `--since` global
- **Contexto:** um `--since` global comum a todas as fontes cortava janelas diferentes por fonte.
- **Decisão:** cursor por fonte com precedência `--since-source` > `--since` > `cursor_date` >
  derivado > mínimo; só avança após listagem bem-sucedida; página 1 sempre relida (o cursor limita a
  profundidade da paginação, nunca a descoberta do que é novo).
- **Lição (o passe final):** a listagem pode terminar ANTES dos itens que ela mesma descobriu serem
  salvos — sem um passe final no fim da run o cursor ficava uma run atrás (medido: AI Weekly com itens
  de 09/09 e cursor em 20/08).

### Curadoria: cadastrar na curadoria, nunca perder o item
- **Decisão:** o blurb do agregador faz o registo (`kind` news|tool|release); o corpo do alvo vira
  enriquecimento (`needs_enrich`) — alvo raso/bloqueado/morto **não** perde o item.
- **Lição (guards):** 32 artigos lixo (placeholders `github.com/...`, `https://..`) ficaram publicados
  antes do `isPlausibleUrl`; o "HTML cru na UI" era `content` salvo com tags, nunca render — daí o
  `ensurePlainText` no armazenamento e o `sanityCheckCleaned` anti-truncamento.

### Governador AIMD calibrado por 429
- **Decisão:** falha de API (429) halva a lane llm E o teto (`GOVERNOR_LLM_CAP`, persistido em
  `NC_HOME/.env`); o grow +1/10s não passa do calibrado — convergência, não oscilação.

### Robustez de paralelismo: sobreviver ao pior
- **Decisão:** parse JSDOM/Readability num pool de workers (SIGSEGV mata só o worker; task cai em
  default seguro) + deadline por job (90s) + teto de tentativas por alvo.
- **Decisão do UTILIZADOR (esta máquina):** `ENRICH_MAX_ATTEMPTS=0` — "em falha ela volta a ser
  processada"; itens nunca são aposentados. Complementado depois pelo cooldown de host morto por TTL
  (`src/dead-hosts.js`): alvo morto não é martelado a cada run, mas volta a ser tentado.

### Guard anti-encolhimento do snapshot (fail-safe de propósito)
- **Decisão:** publicar MENOS artigos que o high-water conhecido (git + disco + `live`) bloqueia o
  export e nada é escrito; redução intencional sai só com `--allow-shrink`.
- **Lição:** este guard é fail-SAFE (bloqueia quando não lê o total) ao contrário do resto do projeto
  (fail-open) — publicar a menos é a única perda de dados difícil de reverter.

### Piso legado Jev (decisão 8 — não reprocessar o acervo)
- **Decisão:** `settings.jev_floor_run_id` fixado uma vez; runs abaixo do piso ficam FORA de toda
  varredura paga; porta única `--include-legacy` com contagem × custo e `--yes`.
- **Lição:** orçamento e reprocessamento são decisões políticas, não técnicas — daí a trava explícita.

### Custo de IA: classificar era ~92% do gasto
- **Decisão:** modelo por faceta (`classify:<faceta>`): só `domain`+`topic-technology` (core) em
  Pro/high; as outras 7 facetas em Flash/medium sobre título+início do corpo (vocabulário fixo →
  small-output → Flash basta). Corte ~4×; lote de artigos por chamada ficou deferido.

### "Nunca recomece do zero"
- **Decisão:** o acervo é versionado em `webapp/public/data` + `ncrawl restore` (união por riqueza) +
  bootstrap automático de base vazia + backup OBRIGATÓRIO antes de toda destruição (reset/purge/
  remove). A memória CoALA segue a mesma filosofia: dump canónico versionado (track-dump) e
  `import --jsonl` por id de conteúdo para viajar entre máquinas.

---

## 2026-10-15 — Dashboard da TUI: barra da run, "alvo morto" curado e colunas do feed

- **Contexto:** a captura do dashboard durante a run `--since 2026-01-01` mostrava 4 problemas que
  "ainda encontrámos": barra "Artigos" 100% cheia com "0 salvos · 25 ativos", a linha
  "Falta terminar: tudo processado ✓" (com 25 jobs em voo logo abaixo), uma parede de
  "✗ erro job falhou (article …): getaddrinfo ENOTFOUND" por alvo morto e o rótulo
  "✓ data-alvo alcança…" cortado com um vão vazio até à tag `[fonte]`.
- **Bug 1 (escopo da barra):** `derivePhases` media `done+failed` do frontier GLOBAL — os 19.266
  artigos das runs antigas dominavam num/denom e a barra nascia cheia. Passou ao burn-down da FILA
  DA RUN via `progress.jobsBase` (a base pós-seed que já alimentava a linha `progresso:` do CLI —
  existia e só o CLI usava); sem base, a barra SOME (`value: null`) em vez de mentir.
- **Bug 2 (semântica da linha "Falta terminar"):** não contava os `in_progress` e o prefixo ficava
  sempre no ecrã, mesmo com a lista vazia → "Falta terminar: tudo processado ✓". Agora conta
  "N em processamento" e o prefixo só aparece com algo pendente; vazio vira "Tudo processado ✓"
  sozinho (`StatusBar` do App + `StatusScreen`).
- **Bug 3 (erro TRATADO apresentado como falha):** o `errorLog` genérico do dispatch corria ANTES
  da classificação e o sink do RunView converte TODO `error` em marco vermelho do feed — alvo morto
  (que mantém o blurb, encerra `done` e re-tenta na próxima run) virava "✗ erro job falhou" em toda
  run, para cada um dos ~60 hosts mortos do acervo (`ENRICH_MAX_ATTEMPTS=0` + cooldown não evitam a
  tentativa por run). O detetor `isDeadTargetError` passou a correr ANTES: marco curado `alvo morto`
  (motivo por classe `deadTargetReason` + hosts em `samples` coalescidos "(×N)") + linha de log;
  `errorLog` continua só para as falhas a sério. Comportamento de estado intacto.
- **Bug 4 (layout do feed):** a coluna do rótulo era fixa em 20 e truncava '✓ data-alvo alcançada'
  (21 c/ ícone) enquanto o detalhe vazio deixava o vão até à tag. Colunas calculadas UMA vez pela
  fatia visível (rótulo = maior rótulo, cap 26; detalhe = resto; tags alinhadas à direita).
- **Lição 1:** painel de estado tem de medir a UNIDADE certa — fila da run, não acumulado do banco;
  quando a métrica certa já existe (`jobsBase`), reutilizá-la em vez de re-derivar do agregado.
- **Lição 2:** no TUI, erros TRATADOS não podem passar pelo `errorLog`: o sink transforma cada linha
  `error` em marco de feed, então a apresentação (curado × vermelho) decide-se no dispatch, com
  `emitRunEvent` + `log`, não no render.

---

## 2026-10-15 — "Artigo não fornecido": o `+` em falta que truncava o prompt do resumo

- **Contexto:** o acervo tinha 324 fichas com desculpas dos modelos onde devia haver leitura —
  `title_pt` "Artigo não fornecido"/"Nenhum artigo fornecido" (122), `summary_pt` "Não foi possível
  gerar o resumo porque o artigo não foi fornecido…" (~70) e `content` com recusas de extração /
  páginas "403 ERROR" / blobs JSON (87). O utilizador: "arrume TODOS e impeça que isso aconteça".
- **Bug RAIZ (o achado):** o prompt do `summarizeArticle` (src/llm.js) tinha um `+` em falta no fim
  de uma linha da cadeia de strings (a bullet "Ignore artefactos de EXTRAÇÃO", do PR #8). JS aceita
  `'a'\n'b'` como DOIS statements — a const fica com metade da cadeia e o resto é uma expressão
  pendurada que o runtime descarta **em silêncio**. Resultado: o modelo recebia as INSTRUÇÕES SEM
  O ARTIGO e respondia naturalmente "Artigo não fornecido" — que era SALVA (a recusa é PT-BR bem
  escrita, o guarda de idioma deixava passar). Todo o resumo desde 2026-10-10 foi gerado assim.
- **Correções:** (a) `+` restaurado + teste de regressão "o prompt leva o ARTIGO INTEIRO"; (b) guarda
  de RECUSA sempre ativo (`isRefusalText` em util.js — regra única usada pelo summarize, pelo crawl
  e pelo repair; sujeito+negação+menção-do-que-falta p/ "O resumo não pode ser produzido sem
  colaboração dos editores" (notícia) não casar) — re-amostra e, persistindo, lança (ficha fica NULL,
  autocorretivo); (c) campos VAZIOS ("" title_pt/summary_pt) também rejeitados; (d) prompt do resumo
  ganha o BLURB do agregador (itens sem corpo resumem do que existe, nunca "artigo em falta");
  (e) `isErrorPage` consolidado em parse-core (réplicas divergentes em crawl/reextract removidas) e
  estendido p/ corpos grandes ("403 ERROR / Request blocked" escapava da regra de <100 chars);
  (f) `isBlockedPage` apertado ("just a moment" solto marcava artigo REAL como interstitial — #9998).
- **Reparação:** `scripts/repair-placeholder-text.mjs` (detecta com os MESMOS helpers do runtime):
  324 fichas — `content` lixo → NULL + `needs_enrich=1` (a próxima run re-enriquece; sem corpo real
  fica no blurb) e camada de leitura → NULL → `finish --include-legacy` re-resumiu tudo
  (19 353/19 353, US$ 0,15).
- **Lição 1 (a cara):** uma cadeia de concatenação de strings multilinha **sem `+` no fim da linha**
  não é erro de sintaxe — é TRUNCAMENTO silencioso (o resto vira statement pendurado). Um assert
  que verifica o prompt INTEIRO enviado é o único travão.
- **Lição 2:** guarda de idioma não apanha recusa (é PT) e confunde código com inglês: PRs de Rust
  traziam resumos PT perfeitos rejeitados porque `manual_is_variant_and`/`From::from` tokenizavam
  como palavras EN — `looksPortuguese` passou a ignorar spans de código, snake_case, camelCase e
  caminhos `X::y`.
