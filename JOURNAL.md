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
