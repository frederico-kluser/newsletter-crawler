# Revisão adversarial — cursor de data por fonte, kept-blurb no streaming e sweep escopado à run

**Escopo:** mudanças **não commitadas** da working tree (`git status`: `src/cursor.js` novo +
`src/{commands,crawl,db,verify,classify,summarize,index}.js`, `src/ui/*`, `AGENTS.md`, + 4 testes novos).
**Revisão:** só leitura + comandos read-only. Nenhum crawl/finish/search real; o banco do usuário nunca foi
aberto (todo probe rodou com `NC_HOME` em tmpdir). Nenhum arquivo do repo foi alterado além deste relatório.
**Snapshot auditado (a árvore estava sendo editada durante a revisão):** `git diff HEAD | shasum` =
`f027d5a0d74f16f574afd42deb505f9bc102ae48`; `src/cursor.js` = `5725136`; `test/{cursor,db.cursor,kept-blurb.stream,sweep-scope}.test.js`
= `a693728`, `fc5a28c`, `e77dc16`, `0f4012f`. Data: 2026-09-11 23:15 -03.

---

## (a) Veredito curto

As três features estão **funcionalmente implementadas e bem cobertas na camada unitária** (34/34 nos 4 testes
novos; `resolveSourceFloor`/`maxPublishedForSource`/`advanceSourceCursor`/`purge` corretos, incluindo a guarda de
data futura pedida no briefing). O kept-blurb no streaming está **fechado em todos os 7 caminhos** e não quebra
nenhum contrato de chamador.

O problema está na **integração**: o piso por fonte (cursor **e** derivado) parte da premissa de que
"maior `published_at` já capturado ⇒ tudo abaixo dele está capturado". Essa premissa é falsa sempre que a captura
anterior foi **parcial** (run limitada por `--max-articles`/`--max-pages`, `--budget`, 429, Ctrl+C, deadline), que é
um fluxo **documentado e oferecido na TUI**. Nesses casos a run seguinte **descarta o backlog pendente daquela
fonte** (`below-since`) e o marca `done` na frontier — e, como `isUrlKnown` conta frontier `done`, esses itens
**não voltam nem com `--since` antigo**: só `purge`. Isso é perda silenciosa e permanente de dados (BUG-1).

Além disso: a suíte de testes **está vermelha** nesta árvore (BUG-3) por causa da mudança de texto do campo
`--since` na TUI, e o sweep escopado deixa um buraco real para fichas **enriquecidas nesta run com `run_id` de run
antiga** (BUG-2), buraco que o próprio `db.js` já tem o encanamento pronto para fechar (e nenhum chamador usa).

---

## (b) Achados

### BUG-1 — piso "high-water" descarta backlog pendente e a frontier o marca `done` para sempre (perda permanente)

**Onde:** `src/commands.js:437-447` (piso = cursor/**derivado**), `src/commands.js:554-559` (`advanceCursorFor`),
`src/commands.js:572-575` (piso por job), `src/crawl.js:519-524` (roundup abaixo do piso),
`src/crawl.js:903-912` (artigo abaixo do piso), `src/commands.js:583` (`finish.run('done')` no caminho de sucesso),
`src/db.js:356-359` (`maxPublishedForSource`), `src/db.js:418-427` (`isUrlKnown` conta frontier `done`),
`src/crawl.js:387-389` (parada "todos os links já conhecidos").

**Cenário concreto (fluxo documentado no AGENTS.md e na TUI):**

```bash
# fonte nova, type=index (Cooperpress): o walk do índice enfileira ~600 roundups (1 por issue);
# a curadoria insere os itens das primeiras issues com published_at = data da ISSUE (curate.js:335)
npm run crawl -- --sources "X" --max-articles 5     # 1ª coleta LIMITADA (o "jeito seguro" do AGENTS.md)
node src/index.js crawl                             # 2ª run sem --since  (TUI: campo vazio -> "Seguir sem data")
```

Na 2ª run, para a fonte X: `derivado = MAX(iso_date(published_at)) = data da issue mais nova` capturada na 1ª run
→ `resolveSourceFloor` devolve esse valor com origem `derivado` → todo roundup **já enfileirado e ainda `pending`**
cuja `issueDate` é anterior cai em `crawl.js:519-524` (`below-since`), retorna sem lançar e o `dispatch`
(`commands.js:583`) grava `frontier.state='done'`. Idem para artigos avulsos via `crawl.js:903-912`.

A partir daí o item está **irrecuperável pela via normal**: `enqueue` é `INSERT OR IGNORE` (`db.js:379`),
`isUrlKnown` considera frontier em qualquer estado (`db.js:423`) e o walk do arquivo **para** na primeira página em
que todos os links já são conhecidos (`crawl.js:387-389`) — ou seja, nem `--since <data antiga>` volta a
enfileirá-los. A única saída é `purge <fonte> --yes` (apaga frontier + artigos e zera o cursor, `db.js:1080-1089`)
ou `remove` + `add`.

**Gatilhos secundários (mesmo efeito, sem `--max-articles`):** run interrompida por `--budget`/429/Ctrl+C/timeout
deixando fila pendente; `--max-pages` pequeno; e o caso geral "descobri mas ainda não processei".

**Impacto:** as issues/artigos daquela janela **nunca entram no acervo**; a run termina "verde" (o `floorHit` marca
a fonte como 100% no painel), com só uma linha de log por item (`issue anterior a --since ... ignorada`) e evento
`below-since`. É perda permanente e de diagnóstico difícil (`ncrawl inspect` mostra o motivo, mas nada indica que
havia backlog legítimo abaixo do piso).

**Sugestão (não aplicada):** três correções possíveis, em ordem de robustez —
1. **Não marcar `done`** quando o job é pulado por piso: devolver a `pending` (ou um estado próprio
   `skipped-below-floor`, revivível por um run com piso menor) em `crawl.js:519-524` / `crawl.js:903-912` +
   `commands.js:583` — hoje o piso transforma "pule" em "abandone".
2. **Não elevar o piso enquanto a fonte tiver backlog**: `advanceCursorFor` (`commands.js:554`) e o cálculo do
   derivado (`commands.js:438`) deveriam checar `frontier` `pending/in_progress/failed` daquela fonte (existe
   `countFrontierByState`; falta a variante por fonte) e cair para o piso mínimo nesse caso.
3. Derivar o piso da **cobertura da listagem** (maior `discovered_date` de par já caminhado/página `done`) em vez do
   maior `published_at` de item — o item é justamente o que pode estar faltando.

---

### BUG-2 — sweep escopado não enxerga ficha **enriquecida nesta run** cujo `run_id` é de run antiga (o encanamento existe e não é usado)

**Onde:** `src/commands.js:716` (`sweepRunId = runId`), `src/db.js:451-454/478-481/857-864` (`...ForRun`),
`src/crawl.js:929-937` (`stmts.enrichArticle.run({...})` **sem** `run_id`), `src/db.js:336-341` +
`src/db.js:429-438` (wrapper com `run_id = coalesce(@run_id, run_id)` e o comentário "Passe `run_id` p/ carimbar a
run corrente").

**Cenário concreto:** item curado na run 7 (inserido por `curate.js:329-344` com `run_id=7`, `needs_enrich=1`).
Na run 9 o alvo falha (DNS/404/PDF/bloqueio **ou** estouro de deadline): em `crawl.js:664-669` o job **lança**, não
há `verifyUrl`, logo **não há streaming** — a ficha fica `verify_status NULL`, `summary_pt NULL`, sem
`classifications`, e continua com `run_id=7`. O sweep da run 9 seleciona `run_id = 9` e **nunca a vê**; antes da
mudança o sweep global a pegava na mesma run. Com `CLASSIFY_STREAMING=false` (knob documentado) o mesmo buraco
aparece para itens que **enriqueceram com sucesso** nesta run. Nesta máquina `ENRICH_MAX_ATTEMPTS=0` (AGENTS.md) —
alvos mortos re-tentam em toda run e nunca são aposentados, que é exatamente a população dos ~400 kept-blurb
medidos em `docs/auditoria-reprocesso/sa3-sweeps-pendentes.md`: com o escopo por run, **nenhum crawl** volta a
processá-los; só `finish` (global) ou `--sweep-all`.

**Impacto:** pendência que antes era drenada pela rede de segurança do próprio crawl agora depende de um comando
explícito. Não é corrupção, é backlog invisível (e o log genérico `commands.js:729` não diz quantos nem quais).

**Sugestão (não aplicada):** passar `run_id: opts.runId ?? null` em `crawl.js:929` (uma linha; o wrapper e o
`coalesce` já existem justamente para isso e **nenhum** chamador passa — era o fix pretendido pelo comentário do
`db.js:430-434`). Complemento barato: no fim do crawl, contar os pendentes **fora** do escopo e logar
(`N pendentes de runs anteriores — rode ncrawl finish`).

---

### BUG-3 — `npm test` vermelho nesta árvore: a mudança de texto do `--since` invalidou T5/T5b (baseline HEAD: verde)

**Onde:** `test/ui.crawl-since.test.js:38-45` (T5) e `:47-58` (T5b) vs. `src/ui/i18n.js:226-232` (PT) / `:504-509` (EN).

**Evidência:** `NC_HOME=$(mktemp -d) node --test test/ui.crawl-since.test.js` na árvore → **T5 e T5b falham**
(o campo não diz mais `Vazio = piso 2026-01-01`/`MAIS AMPLO`, e o aviso não diz mais `Sem data, o piso vira ...`);
no snapshot de `HEAD` exportado para `/tmp` (`git archive HEAD`), os **4 testes passam**. `test/ui.search.test.js`
falha **nos dois** (HEAD e árvore) — é pré-existente, não regressão desta mudança.

**Impacto:** a árvore não fecha `npm test` (bloqueia commit/onda) e o teste é o registro do contrato de copy do
wizard; deixá-lo vermelho apaga a proteção contra a próxima mudança de texto.

**Sugestão (não aplicada):** atualizar T5/T5b para o novo contrato (`piso POR FONTE`/`cursor`, e o aviso
`Sem data, cada fonte usa o próprio CURSOR`) ou torná-los agnósticos de redação (assertar presença de `piso` +
as duas opções + ausência de `Máx. páginas`).

---

### CONFUSÃO-1 — `--reset-cursor` sozinho é praticamente no-op: o piso seguinte é o **derivado**, que é o mesmo MAX

**Onde:** `src/commands.js:384-402` (reset) + `src/cursor.js:46-57` (ordem cursor → derivado) +
`src/db.js:356-359` (derivado = `MAX(iso_date(published_at))`).

**Evidência (probe com o código real, base descartável):**

```
R1: cursor = 2026-09-03 | piso de R2 = 2026-09-03 (cursor)
--reset-cursor -> piso depois do reset: 2026-09-03 (derivado) == piso anterior? true
```

Como o cursor é sempre avançado para `MAX(published_at)` e o derivado é o **mesmo** `MAX`, zerar o cursor só muda
o piso quando o cursor ficou **acima** do derivado — situação que na prática só ocorre se artigos foram apagados
por fora (`purge` já zera o cursor por conta própria; `reset`/`wipeAll` apaga a tabela `sources` inteira,
`db.js:1040-1060`). Ou seja: quem lê a **ajuda da CLI** (`index.js:69-72`, "`--reset-cursor` zera") espera uma
recaptura mais funda que **não acontece** (o texto da TUI, `i18n.js:92`, já é honesto: "decide pelo
derivado/piso mínimo"); a recaptura real exige `--since <data antiga>` (que já vence o cursor sem precisar do
reset) ou `purge`.

**Impacto:** falsa sensação de recuperação; o usuário roda `--reset-cursor`, a fonte continua no mesmo piso e ele
conclui que "o crawler não acha mais nada". Nenhum dado é perdido por isso.

**Sugestão (não aplicada):** alinhar a ajuda da CLI ao efeito real ("derruba o cursor; o piso seguinte é o
derivado — para recapturar de fato use `purge` + `--since`"), ou fazer o flag gravar `MIN_CRAWL_DATE` como piso
explícito da fonte (aí sim "zera" = recaptura do zero), ou aceitar `--reset-cursor` apenas junto de
`--since`/`--purge`.

---

### CONFUSÃO-2 — `CRAWLER_SINCE` (env) deixou de ser piso global efetivo, mas o log continua anunciando que é

**Onde:** `src/commands.js:352-379` (`sinceRaw`/`sinceDate` incluem `DEFAULT_SINCE`, mas
`explicitSinceFlag` só olha `flags.since`) + `src/commands.js:368-370` (log `--since ativo (origem): piso ...`).

**Cenário:** `CRAWLER_SINCE=2026-09-05` em `NC_HOME/.env` (o `.env` do usuário é a fonte do `DEFAULT_SINCE`,
`config.js:345`) e `crawl` sem flag. O log anuncia `--since ativo (CRAWLER_SINCE): piso 2026-09-05`, mas cada fonte
semeada resolve e **imprime o seu próprio** piso (`cursor`/`derivado`, possivelmente 2026-08-20 ou 2026-09-10) e é
ele que vale. Antes da mudança, `CRAWLER_SINCE` era o piso de todas as fontes.

**Impacto:** um piso configurado no ambiente deixa de limitar a captura; fontes com cursor antigo varrem mais fundo
(custo/tempo) e o "piso" mostrado no topo do log não corresponde ao usado. O AGENTS.md documenta isso como
"fallback", mas o texto da spec ("`--since` global > `cursor_date`") e o log dizem outra coisa.

**Sugestão (não aplicada):** tratar `DEFAULT_SINCE` vindo de env como explícito (`explicitSince` quando
`flags.since` for string **ou** `process.env.CRAWLER_SINCE` estiver setado) ou separar os rótulos no log
(`piso global (referência) … piso por fonte …`).

---

### MENOR-1 — guarda de data futura também descarta `--since`/`--since-source` **explícitos**

**Onde:** `src/commands.js:445` (`maxDate: new Date()`) + `src/cursor.js:54` (`if (max && d > max) continue`).

**Cenário:** operador em fuso à frente do UTC, logo após a meia-noite local (ex.: 00:30 em UTC+2 = 22:30Z do dia
anterior), roda `--since 2026-09-12` (a data "de hoje" dele). `parseDate('2026-09-12') > now` → o candidato é
descartado e o piso cai para o **cursor** (mais antigo) — a run captura **mais** do que foi pedido, enquanto
`progressReset({sinceDate})` usa a data futura e o painel mostra outro alvo. Mesmo efeito para
`--since-source "X=2027-01-01"` (typo de ano).

**Impacto:** flag explícita silenciosamente ignorada (sem `warn`); custo maior que o pedido; alvo do progresso
contraditório. Nenhum dado perdido.

**Sugestão (não aplicada):** aplicar `maxDate` só a `cursor`/`derivado` (dado de máquina) e validar as flags
explícitas na hora do parse — como já é feito para data inválida (`errorLog` + `exit`, `commands.js:354-357`).

---

### MENOR-2 — clamp no mínimo faz `return` e joga fora um candidato mais restritivo da fila

**Onde:** `src/cursor.js:55` (`if (min && d < min) return { date: min, origem: 'piso-minimo' };`) — o guarda de
futuro usa `continue`, o de mínimo usa `return`.

**Cenário (probe real):** `--since-source "X=2020-01-01"` com cursor `2026-09-10` (ambos conhecidos) →
`{ date: 2026-01-01, origem: 'piso-minimo' }`. O cursor, que era mais restritivo, é **descartado**: a fonte varre
~8 meses de arquivo a mais (`--since-source` com data antiga é justamente o erro de digitação provável).

**Impacto:** custo/tempo extras, `origem` do log enganosa (`piso-minimo` com cursor presente). Nenhum dado perdido.

**Sugestão (não aplicada):** trocar o `return` por `continue` (o `piso-minimo` final da linha 58 já cobre "nada
qualificou"), mantendo o clamp quando nenhum outro candidato existir.

---

### MENOR-3 — `--since-source` que não casa com nenhuma fonte (ou vem sem valor) some sem aviso

**Onde:** `src/commands.js:380-383` (aviso só quando o Map inteiro fica vazio) e `src/commands.js:437` (lookup por
**nome** apenas).

**Cenário:** `--since-source "https://x.example/issues=2026-09-01"` (URL, como `--reset-cursor` aceita) → o Map tem
1 par válido, o aviso não dispara, nenhuma fonte casa e o override é ignorado em silêncio; `--since-source` seguido
de outra flag vira `true` (`parseFlags`, `src/index.js:21-44`) e também é ignorado sem aviso; `--since-source=...`
(idem `--reset-cursor=...`, `--sweep-all=1`) vira chave com `=` e é ignorada sem aviso — o repositório já conhece
essa limitação do parser (AGENTS.md, `--allow-shrink`).

**Impacto:** o operador acredita ter forçado o piso de uma fonte; a run usa cursor/global e ninguém avisa.

**Sugestão (não aplicada):** avisar por chave não casada (mesmo padrão do `unmatched` de `--sources`,
`commands.js:420`), avisar quando o valor não for string, e/ou aceitar URL/normalização no `--since-source`.

---

### MENOR-4 — pós-restore o derivado sobe por **data sintética** (`date_iso` = `extracted_at` de itens sem data)

**Onde:** `src/db.js:1247` (`published_at: row.published_at ?? row.date_iso ?? null`) + `src/db.js:1189-1191`
(o snapshot grava `date_iso`, que é `coalesce(iso_date(published_at), date(extracted_at))`) +
`src/db.js:356-359` (o derivado lê `published_at`).

**Cenário:** fonte cujos itens não têm data legível (`published_at NULL`). Depois de um `restore`, todos os itens
dela passam a ter `published_at` = **data em que foram extraídos** (ex.: 2026-08-14) → o derivado (e depois o
cursor) sobem para essa data. No 1º crawl pós-restore, itens dela **com data real** anterior a 2026-08-14 que não
estejam no snapshot são descartados pelo piso.

**Impacto:** janela de dados pulada em um cenário de recuperação (o pior lugar para perder dado); o cursor fica
"verdadeiro" para uma data que não é de publicação.

**Sugestão (não aplicada):** não alimentar o piso com datas de fallback — p.ex. marcar a origem da data
(`published_at_source`/flag no restore) e computar `maxPublishedForSource` só sobre datas reais, ou preservar
`published_at NULL` no restore e guardar `extracted_at` separado.

---

### MENOR-5 — superfícies de informação ainda falam em "piso mínimo" quando o piso é por fonte

**Onde:** `src/ui/screens.js:289` + `src/ui/i18n.js:60` (PT) / `:338` (EN) — o resumo pré-run mostra
`desde (--since): 2026-01-01 (piso mínimo — o mais amplo)` com o campo vazio, mas a run usa cursor/derivado;
`src/progress.js:87-93` + `src/commands.js:371` — o `%` rumo ao piso é calculado contra a data **global**
(`progressReset({sinceDate})`), então uma fonte com cursor aparece com `alvo 2026-01-01: 2%` até o `floorHit`
(crawl.js:425) pintar 100%; `src/classify.js:193` — o log do classify é o único dos três que não imprime o escopo
(`run N`), ao contrário de `verify.js:91` e `summarize.js:40`.

**Impacto:** só diagnóstico/UX (nenhum efeito em dados). A barra de progresso e o resumo podem levar a decisões
erradas de operação ("está em 2%, vou esperar").

**Sugestão (não aplicada):** no resumo, mostrar `piso por fonte (cursor)` quando `flags.since` está vazio; passar o
mapa de pisos para o `progress` (ou rotular o % como "global"); incluir o escopo no log do classify.

---

### MENOR-6 — data futura: a guarda funciona, mas deixa a fonte **sem piso por fonte para sempre** (não há conserto automático)

**Onde:** `src/db.js:356-359` (`maxPublishedForSource` = MAX cru, sem teto) + `src/cursor.js:54` +
`src/commands.js:556-559`.

**Evidência (probe real):** com um artigo datado `2027-03-01` na fonte,
`maxPublishedForSource = '2027-03-01'`; `resolveSourceFloor({cursor, derived, minDate, maxDate: now})` →
`{ date: 2026-01-01, origem: 'piso-minimo' }`; `advanceCursorFor` recusa gravar; e **toda run seguinte recalcula o
mesmo MAX futuro** → o piso cai no mínimo permanentemente.

**Impacto:** a guarda evita o pior (o piso em 2027 pularia todo o intervalo), mas a fonte perde o ganho da feature
para sempre: nenhum cursor é gravado e o piso efetivo é o mínimo (`crawl.js:387-389` limita o dano de custo, porque
o walk para quando todos os links já são conhecidos). Obs.: `clampFutureDate` só barra > hoje+24 h **na coleta**;
linhas futuras já existentes (base antiga, restore) continuam envenenando o derivado, e o único conserto é apagar/
corrigir a linha.

**Sugestão (não aplicada):** descontar o futuro no SQL (`MAX(min(iso_date(published_at), date('now')))`) ou ignorar
`published_at > hoje+1d` no `maxPublishedForSource`, mantendo a guarda do `advanceCursorFor` como rede.

---

## (c) O que foi verificado e está OK

**Cursor — dados e semântica**
- `maxPublishedForSource` usa `MAX(iso_date(published_at))` e filtra `published_at IS NOT NULL`: string crua
  (`"Sep 9, 2026"`) é normalizada antes do MAX (sem armadilha lexicográfica) e item sem data/impersável **não**
  envenena nem "envelhece" o cursor (`db.js:356-359`; coberto em `test/db.cursor.test.js`).
- `advanceSourceCursor` só avança (`cursor_date IS NULL OR cursor_date < @date`) — empate e retrocesso são no-op
  (`db.js:361-364`).
- Guarda de **data futura** existe nos dois pontos: `resolveSourceFloor` descarta o candidato e cai para o próximo
  (`cursor.js:54`) e `advanceCursorFor` recusa gravar (`commands.js:556-559`). Confirmei com base real que um item
  `2027-03-01` **não** crava o cursor no futuro (sem a guarda, o piso seria 2027 e a fonte pararia de capturar).
- `upsertSource` (ON CONFLICT DO UPDATE) lista colunas explicitamente e **não** zera `cursor_date` — verificado no
  banco (cursor `2026-09-10` sobrevive a um upsert que muda `type`/`max_index_pages`).
- `purgeSource` zera o cursor **na mesma transação** (`db.js:1086-1088`), e com os artigos apagados o derivado
  também é NULL → recaptura do zero não é pulada (teste dedicado).
- `reset`/`wipeAll` apaga a tabela `sources` inteira (`db.js:1040-1060`) e `removeSource` apaga a linha
  (`db.js:1139`) — **não** sobra cursor órfão apontando para dados que não existem.
- `--reset-cursor` sem valor = `true` → todas; com valor casa por nome/URL/substring e loga fonte a fonte; sem
  casar, avisa (`commands.js:384-402`). `--reset-cursor` roda **antes** do seed, então o piso já é recalculado com
  o cursor zerado.
- Fontes fora do seed caem no `--since` global (`commands.js:572`): direção **fail-open** (varre mais, nunca pula),
  então o "vazamento de piso" apontado no briefing é aceitável — o efeito é custo, não perda.
- `--no-refresh`: a listagem não é re-visitada, logo `advanceCursorFor` não roda (cursor parado, como a spec pede) e
  a fila pendente continua drenando normalmente (`claimNextArticle`/`claimNextCurate` não dependem de refresh).
- Piso **inclusivo** (`>=`): item datado exatamente no cursor é re-checado e a dedup por URL responde antes de
  qualquer LLM (`cursor.js:28-29`; teste dedicado).
- Cursor/derivado são ISO `YYYY-MM-DD` dos dois lados, então a comparação TEXT do `advanceSourceCursor` é
  cronológica (nenhum formato divergente é gravado por outro caminho — auditei todos os escritores de
  `cursor_date`).

**Kept-blurb no streaming**
- `keepAggregatorVersion` devolve `{ verifyUrl: row.url }` **em todos** os 7 caminhos (`robots` 656,
  `pdf-target` 674, `error-page` 780, `thin-content` 787, `blocked-page` 796, `json-page` 806, `dup-content` 917) e
  todos usam `return` — confirmei um a um no arquivo, não só no diff.
- O caminho `dispatch` (`commands.js:584`) lê `res?.verifyUrl` (optional chaining) e `processListing`/
  `processRoundup` retornam `undefined` em todos os caminhos — nenhum caller quebra, nenhum roundup/listing é
  streamado por engano.
- `streamPostSave` é NULL-only nos três estágios (`verify_status`, `summary_pt`, `getClassification`), então o
  kept-blurb entra no streaming **uma vez** e não paga LLM de novo (`commands.js:513-542`).
- O item mantido sai do re-enfileiramento (`finishEnrich` zera `needs_enrich`), inclusive no caminho `dup-content`.

**Sweep escopado**
- Os três statements `...ForRun` filtram `run_id = ?` e mantêm os MESMOS predicados de pendência do global
  (`verify/summary` por coluna NULL, `classify` por `LEFT JOIN ... IS NULL`) — o escopo **não** relaxa o
  delta-only (`test/sweep-scope.test.js` prova os dois lados: escopado = só a run, global = todas).
- `runId == null` (sem ledger) → `sweepRunId = null` → cai no global, sem quebrar nem escopar errado
  (`commands.js:716`); o log diz qual escopo foi usado.
- `finish` **continua global** (`commands.js:1361-1367` passa só `limit`/`force`), e `--sweep-all` volta ao
  comportamento antigo (`flags['sweep-all'] === true`).
- Os 4 testes novos passam (34/34): `cursor.test.js`, `db.cursor.test.js`, `kept-blurb.stream.test.js`,
  `sweep-scope.test.js` — inclusive os casos de data futura e de escopo por run.
- Regressão **não** encontrada nos fluxos vizinhos que só consomem os sweeps (TUI/web não chamam
  `verifyPending`/`classifyPending`/`summarizePending`; o único outro consumidor é `finish`).
- `test/ui.search.test.js` falha **também no HEAD** (conferido com um snapshot `git archive HEAD` em `/tmp`) —
  é pré-existente, **não** é regressão destas mudanças.

**Compatibilidade geral**
- `src/index.js` continua sem efeito colateral ao importar; as flags novas são lidas de `flags` (não de `rest`), e
  `--reset-cursor` sem valor chega como `true` (o `parseFlags` só consome o próximo token quando ele não começa com
  `--`).
- `printStatus` (usado por `npm run status`, smoke test, e por todos os comandos de destruição) só **lê** os
  cursores e não altera nada; a leitura de `cursor_date` em bases antigas funciona porque `ensureColumn` roda no
  boot (`db.js:185`).
- `restore`/bootstrap não gravam cursor (fonte criada por `restoreSourceByName` sem a coluna) → 1º crawl pós-restore
  usa o derivado, que é o desenho documentado (o caso ruim do derivado com datas sintéticas ficou em MENOR-4).
