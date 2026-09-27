# eval/jev — avaliação e calibração do Jev

Aqui ficam as peças que calibram os limiares do Jev (`typesafe/jev-1.13`) por etapa e medem
custo × qualidade contra o baseline da era DeepSeek. A regra de ouro é que **toda resposta paga é
cacheada**. Varrer limiares, re-pontuar e re-rodar custa US$ 0. Só um pedido novo vai à rede.

## Layout

| Caminho | O que é | Onda |
|---|---|---|
| `lib/cache.mjs` | Cache em disco com chave `sha256` do pedido canônico (as chaves são ordenadas, então a ordem delas não muda a chave). Tem `get`/`put`/`has`/`getOrCompute` e escrita atômica. | W0 |
| `lib/sample.mjs` | Amostragem **somente-leitura** do banco real (`EVAL_SOURCE_DB`, cujo default é `NC_HOME/crawler.db`), com ordem semeada por `sha256(seed + id)` e sem `Math.random`. | W0 |
| `lib/ledger.mjs` | Isola o ledger de custo do eval em `eval/jev/.ledger.db` e resume o `llm_usage` dele. | W0 |
| `lib/calibrate.mjs` | Funções puras: `sweep`, `selectiveSweep`, `pickThreshold`, `ece`, `wilson`, `auroc`, `brier`, `multiClassMetrics`, `cohenKappa`, `multiLabelAgreement`, `shadowAgreement`. | W0 |
| `run.mjs`, `calibrate.mjs`, `stages/<etapa>.mjs` | O runner pago, o calibrador que grava `config/jev-thresholds.json` e um módulo por etapa (`{sample, buildRequests, gold, geminiFallback, score}`). | W1+ |
| `../legacy/*.mjs` | Os prompts da era DeepSeek, **congelados** verbatim (veja abaixo). | W0 |

Estes caminhos ficam fora do git (`.gitignore`): `eval/jev/.cache/`, `eval/jev/.ledger.db*` e `eval/jev/out/`.

## Regras de segurança

- **O banco do usuário nunca é escrito.** `sample.mjs` abre a origem com `{readonly: true, fileMustExist: true}`
  e `PRAGMA query_only`. Ele não importa `src/db.js` (que abre o banco em escrita no import) nem `src/config.js`.
- **O custo do eval vai para um ledger próprio.** O processo filho recebe `ledgerEnv()`, com `DB_PATH` absoluto
  apontando para `.ledger.db` e `LLM_PROVIDER=openrouter`. Como o `NC_HOME/.env` sobrescreve o env do processo,
  o runner chama `assertLedgerIsolation({dbPath: config.DB_PATH, provider: config.LLM_PROVIDER})` **dentro do
  filho, antes de qualquer chamada paga**. Se um override do `.env` venceu, ele aborta.
- **Toda chamada paga passa pelo guarda de gasto:**
  `node scripts/dev-spend.mjs run --need X -- node eval/jev/run.mjs --stage S --max-usd X`.
- **O acervo legado não é reprocessado.** O eval só lê o acervo, que é de onde vem a gold grátis (`verify_status`,
  `article_tags`, `kind`/`section` dos itens curados, `title_pt`/`summary_pt`). Nada volta para o banco.

## Cache

```js
import { createCache } from './lib/cache.mjs';
const cache = createCache({ namespace: 'verifyRecordJev' });
const req = { engine: 'jev', model: 'typesafe/jev-1.13', stage: 'verifyRecordJev', state, questions };
const { value, hit } = await cache.getOrCompute(req, () => jevDecide({ stage, state, questions }));
```

A resposta inteira, com a distribuição de probabilidades, fica guardada. Um erro (429, 402…) nunca é cacheado.
Mudar o texto, as perguntas, o modelo ou o effort muda a chave. Mudar só a ordem das chaves do objeto não muda.

## Amostragem (gold da era DeepSeek)

```js
import { openSourceDb, sampleVerifyRecords, sampleClassifiedArticles, sampleCuratedIssues, sampleSummaries, loadIssue } from './lib/sample.mjs';
const db = openSourceDb();                       // EVAL_SOURCE_DB ou NC_HOME/crawler.db, somente-leitura
const { records, shortfall } = sampleVerifyRecords(db, { quotas: { ok: 30, suspect: 30, junk: 20 }, seed: 'w3-verify' });
```

- `sampleVerifyRecords`: registros com `gold` = `ok` | `suspect` | `junk`.
- `sampleClassifiedArticles`: artigos com `tags` = `{faceta: [tag por rank]}` e `goldKind`. O estrato default é a 1ª tag de `domain`.
- `sampleCuratedIssues` / `loadIssue`: uma edição é identificada por (fonte, data). O `issue_url` dos artigos
  restaurados é `NULL`, mas os itens herdam a data da edição. Exemplo: `loadIssue(db, {sourceId: 1, publishedAt: '2026-08-27'})` devolve a Node Weekly #638, com 23 itens.
- `sampleSummaries`: artigos com `title_pt`/`summary_pt`, estratificados por `length`, `kind`, `verify` ou por uma função.

A mesma seed sempre devolve a mesma amostra. O campo `shortfall` mostra onde a cota não foi atingida,
e um estrato com N < 30 precisa ser sinalizado no relatório.

## Calibração

- **Faixa de probabilidade** `{lo, hi}` sobre o `p` de um noul (ou o `pMass` de uma choice): `p >= hi` é sim,
  `p <= lo` é não e o intervalo entre os dois é incerto, que vai para o fallback Gemini. Use `sweep(scores, labels, bandGrid(los, his), {fallback, costs})`.
- **Limiar de certeza** (`minConf`): `selectiveSweep(items, thresholdGrid(0.3, 0.95, 0.05), {fallbackAccuracy, costs})`.
  Ele devolve cobertura, acurácia dos aceitos (com intervalo de Wilson), taxa de fallback, qualidade misturada
  `Q(τ)` e custo por 1.000 itens.
- **Escolha do limiar:** `pickThreshold(rows, {metric: 'blended.f1', target: <qualidade DeepSeek>, minCoverage})`
  escolhe a linha **mais barata** que atinge o alvo. Se nenhuma atinge, devolve a de melhor métrica com `met: false`.
- Nunca compare probabilidades de perguntas diferentes: cada id de pergunta tem a sua própria varredura.
- Convenção de divisão por zero: sem previsão positiva e sem positivo no gold, precisão e recall valem 1. Com só um dos lados vazio, valem 0.

## Prompts congelados (`eval/legacy/`)

A migração apaga de `src/llm.js` as funções da era DeepSeek. Os módulos em `eval/legacy/` guardam uma cópia
**verbatim** do texto (system/user), do json_schema, do model/effort **efetivo** e do parse (sem zod).
Assim, um baseline pago continua rodando depois que os originais somem, via `callJSON` com o slug OpenRouter
`deepseek/deepseek-v4-flash-0731`. A cópia foi feita no commit `421b42c`. Na época, ela foi conferida byte
a byte contra o body que o `src/llm.js` montava, com `fetch` stubado e sem rede, em 48 comparações.

| Builder | Função original |
|---|---|
| `buildCurateRoundupRequest`, `buildCurateLeftoverRequest` | `curateRoundupItems`, `curateLeftoverLinks` |
| `buildCleanArticleRequest` (stage `articleClean` \| `articleReclean`) | `cleanArticleContent` |
| `buildVerifyRecordRequest` | `verifyRecordLLM` |
| `buildExtractLinksRequest`, `buildExtractRoundupLinksRequest` | `extractLinksItemByItem`, `extractRoundupLinks` |
| `buildExtractArticleRequest` | `extractArticleViaLLM` |
| `buildRelevanceRequest`, `buildRelevanceBatchRequest`, `buildBatchJudgePrompt`, `RELEVANCE_RUBRIC` | `judgeRelevance`, `judgeRelevanceBatch` |
| `buildQuerySpecRequest` | `compileQuerySpec` |
| `buildFacetRequest`, `buildFacetPrompt`, `buildFacetQueryRequest` | `classifyFacet` + `buildFacetPrompt`, `mapQueryToFacetTags` |
| `buildDetectTypeRequest` | `classifyWithLLM` (src/detect-type.js) |

```js
import { buildVerifyRecordRequest, toCallJSONArgs } from '../legacy/index.mjs';
const req = buildVerifyRecordRequest(record);          // {stage, schemaName, schema, system, user, model, effort, parse}
const raw = await callJSON(toCallJSONArgs(req));       // fallbackModel:null → sem escalada; sem zod
const out = req.parse(raw);                            // o mesmo retorno da função original; null = fora do schema
```

O `req.parse` repete o fim do `callJSON` com zod. Primeiro ele tenta o shape estrito e, se falhar, aplica os
defaults tolerantes nas chaves de topo. `parse(raw, {tolerant: false})` aceita só o shape estrito, o que serve
para re-amostrar como o retry de shape fazia. Particularidade do `articleReclean`: o `models.json` dizia `high`,
mas a etapa estava fora de `STAGE_KEYS`, então a produção enviava `xhigh`. O congelado guarda o que era
**enviado** de fato. **Não edite o texto:** ele é o baseline. O teste `test/eval.jev-calibrate.test.js` fixa
um fingerprint `sha256` de cada builder.
