# DeepSeek API direta (api.deepseek.com) — brief de fatos verificados

> Data de verificação: 2026-08-13. Destinado aos implementadores do provedor direto
> no crawler (Node, SDK openai) e no webapp (fetch do browser).
> Todo fato abaixo tem fonte (URL). Itens sem fonte oficial estão marcados
> **NÃO CONFIRMADO — requer teste manual**. Nada aqui foi inventado.

## Fontes principais

| Fonte | URL |
|---|---|
| Quickstart oficial (Your First API Call) | https://api-docs.deepseek.com/ |
| Referência do endpoint chat/completions | https://api-docs.deepseek.com/api/create-chat-completion |
| GET /models (list models) | https://api-docs.deepseek.com/api/list-models/ |
| Changelog oficial | https://api-docs.deepseek.com/updates/ |
| Guia thinking mode | https://api-docs.deepseek.com/guides/thinking_mode |
| Guia JSON output | https://api-docs.deepseek.com/guides/json_mode |
| Error codes | https://api-docs.deepseek.com/quick_start/error_codes |
| Rate limit & isolation | https://api-docs.deepseek.com/quick_start/rate_limit |
| GET /user/balance | https://api-docs.deepseek.com/api/get-user-balance |
| Mirror oficial da doc (base `/v1`) | https://deepseek.apidog.io/your-first-api-call-835227m0 |
| Preços (espelho, verificado 2026-07-25) | https://deepseek.ai/pricing |
| Preços (cross-check, revisado 2026-08-12) | https://benchlm.ai/deepseek/api-pricing |
| Preços (corroboração) | https://chat-deep.ai/pricing/ · https://www.morphllm.com/deepseek-api · https://www.aipricing.guru/deepseek-pricing/ · https://openrouter.ai/deepseek/deepseek-v4-pro |
| Aposentadoria dos slugs legados | https://ecorpit.com/deepseek-v4-migration-legacy-api-cutoff-july-2026/ · https://byteiota.com/deepseek-api-migration-july-2026/ |

---

## 1. Slugs de modelo válidos (ago/2026)

- **Modelos oficiais atuais (2):** `deepseek-v4-flash` e `deepseek-v4-pro` — são os
  valores do enum do campo `model` na referência oficial do endpoint
  (https://api-docs.deepseek.com/api/create-chat-completion) e o que o
  `GET /models` retorna (https://api-docs.deepseek.com/api/list-models/).
- **Builds internos:** `deepseek-v4-flash` serve o checkpoint DeepSeek-V4-Flash-0731
  (changelog 2026-07-31); `deepseek-v4-pro` foi atualizado para DeepSeek-V4-Pro-0813
  ("The calling method remains unchanged" — quickstart). **O slug NÃO leva sufixo de
  build** — o sufixo (-0731/-0813) é descritivo do checkpoint.
- **Slugs legados `deepseek-chat`/`deepseek-reasoner`: RETIRADOS.** Aviso oficial de
  2026-04-24: descontinuação em 2026-07-24 15:59 UTC; até lá mapeavam para V4-Flash
  (chat → non-thinking, reasoner → thinking). Fontes de terceiros confirmam que após
  o corte os nomes **retornam erro, sem grace period**
  (https://ecorpit.com/deepseek-v4-migration-legacy-api-cutoff-july-2026/,
  https://byteiota.com/deepseek-api-migration-july-2026/). Comportamento real do
  erro (qual código HTTP) — **NÃO CONFIRMADO — requer teste manual**.
- Contexto: o projeto hoje usa OpenRouter `deepseek/deepseek-v4-flash-0731`; o
  equivalente direto é `deepseek-v4-flash` (mesma família; o OpenRouter adiciona o
  prefixo `deepseek/` e expõe o build no slug, o direto não).

## 2. Base URL e endpoints

- **Base oficial (OpenAI format):** `https://api.deepseek.com` — o exemplo oficial
  chama `curl https://api.deepseek.com/chat/completions` e o SDK OpenAI usa
  `base_url="https://api.deepseek.com"` (https://api-docs.deepseek.com/).
- **Alias `/v1`:** "To be compatible with OpenAI, you can also use
  `https://api.deepseek.com/v1` as the base_url" (mirror oficial da doc,
  https://deepseek.apidog.io/your-first-api-call-835227m0). Ambos funcionam; o
  quickstart oficial usa SEM `/v1`.
- **Formato Anthropic:** `https://api.deepseek.com/anthropic` (quickstart oficial).
- **Base Beta (funções experimentais, ex. Chat Prefix Completion):**
  `https://api.deepseek.com/beta` (referência do endpoint).
- **Endpoints confirmados:** `POST /chat/completions`, `GET /models`
  (https://api-docs.deepseek.com/api/list-models/), `GET /user/balance`
  (https://api-docs.deepseek.com/api/get-user-balance). O changelog de 2026-08-13
  menciona também suporte a **Responses API** ("nativamente adaptado para Codex").
- **Compatibilidade:** "API format compatible with OpenAI/Anthropic" — usar SDK
  openai trocando `base_url` e `api_key` (https://api-docs.deepseek.com/).

## 3. Parâmetros do POST /chat/completions

Fonte: https://api-docs.deepseek.com/api/create-chat-completion (salvo onde indicado).

- **`model`** (obrigatório): enum `deepseek-v4-flash` | `deepseek-v4-pro`.
- **`thinking`** (objeto): `{"type": "enabled" | "disabled"}` — thinking ligado por
  padrão. No SDK OpenAI vai via `extra_body` (guia thinking_mode,
  https://api-docs.deepseek.com/guides/thinking_mode).
- **`reasoning_effort`** (top-level, string): `low` | `high` | `max`; default `high`.
  **Mapeamento oficial:** `low→low`, `medium→high`, `high→high`, `xhigh→high`,
  `max→max` (guia thinking_mode). Ou seja: **no direto, não existe `xhigh` nem
  `medium` efetivos — tudo vira `high`** (a menos de `max`). Atenção: a tabela da
  referência do endpoint apresenta o `reasoning_effort` dentro do objeto
  `thinking`; o guia e o curl oficial do quickstart usam os dois separados
  (`"thinking": {"type": "enabled"}, "reasoning_effort": "high"`). Forma
  recomendada: `reasoning_effort` top-level + `thinking.type` (guia + quickstart).
- **`reasoning: {effort}` (param da OpenRouter): NÃO é o formato direto.** No
  formato Anthropic do direto o equivalente é `reasoning: {"effort":
  "none|low|high|max"}`; no Responses API é `output_config.effort` (guia
  thinking_mode).
- **`response_format`**: só `{"type": "text"}` (default) ou `{"type":
  "json_object"}` documentados (ver §4).
- **`max_tokens`** (não há `max_completion_tokens` documentado).
- **`stream`** + **`stream_options: {"include_usage": true}`** (chunk extra com
  usage antes do `[DONE]`).
- **`temperature`** (≤2, default 1), **`top_p`** (≤1, default 1), **`stop`** (≤16
  sequências), **`tools`** (≤128 funções; `strict` bool por tool, Beta), **`tool_choice`**
  (`none`|`auto`|`required`|objeto), **`logprobs`**/`top_logprobs` (≤20),
  **`user_id`** (≤512 chars; KVCache isolation).
- **`frequency_penalty`/`presence_penalty`: DEPRECADOS e ignorados** — "It will not
  take effect if you pass it to the API". No thinking mode, `temperature`/`top_p`/
  penalties também são ignorados sem erro (guia thinking_mode).
- **Parâmetros desconhecidos em geral:** comportamento NÃO documentado
  explicitamente; a evidência indireta (params deprecados "não têm efeito" em vez de
  erro) sugere **ignorados, não 400** — **NÃO CONFIRMADO formalmente, requer teste.
- **`usage` como parâmetro de request (`usage: {include: true}`): NÃO é parâmetro
  da API direta** (é da OpenRouter). Na API direta o `usage` **sempre** vem na
  resposta (ver §5).
- **Tools + thinking:** quando há `tools` na request, o `reasoning_content` da
  resposta do assistant **precisa ser repassado** nas requests seguintes, senão a
  API devolve **400** (guia thinking_mode).
- **Response (não-streaming):** `choices[]` com `message.content` e, em thinking,
  `message.reasoning_content` (irmão de `content`; em streaming chega em
  `delta.reasoning_content`). `finish_reason`: `stop|length|content_filter|
  tool_calls|insufficient_system_resource`. Top-level `model` ecoa o modelo usado.

## 4. response_format: json_schema NÃO é documentado

- **Só `{"type": "json_object"}` (e `text`) está documentado** na referência do
  endpoint e no guia https://api-docs.deepseek.com/guides/json_mode.
  `{"type": "json_schema", "json_schema": {...}}` **não aparece em nenhuma página
  oficial** — **NÃO CONFIRMADO que funcione (requer teste manual); tratar como
  NÃO suportado no direto.**
- **Regra do json_object:** a palavra **"json"** deve aparecer no prompt (system ou
  user) e é recomendado incluir **exemplo do formato JSON desejado** no prompt
  (guia json_mode).
- **Caveat oficial:** "When using the JSON Output feature, the API may occasionally
  return empty content" — mitigar via prompt (guia json_mode).
- Nenhuma restrição por modelo (ex.: "reasoner não aceita") está documentada nas
  páginas atuais; o exemplo oficial usa `deepseek-v4-pro` (guia json_mode).
- **Implicação para o crawler:** o pipeline usa `response_format` json_schema
  `strict:true` + zod. No direto: `json_object` + palavra "json" no prompt + o zod
  que já existe (parse defensivo) — o `callJSON` existente já faz re-sample/retry e
  escala p/ Pro; manter isso como backstop.
- `max_tokens` deve ser dimensionado para o JSON não truncar ("Set the `max_tokens`
  parameter reasonably to prevent the JSON string from being truncated midway" —
  guia json_mode).

## 5. usage na resposta (sem cost em USD)

- O response **sempre** inclui `usage`: `prompt_tokens`, `completion_tokens`,
  `total_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`
  ("prompt_tokens equals prompt_cache_hit_tokens + prompt_cache_miss_tokens") e
  `completion_tokens_details.reasoning_tokens` (referência do endpoint).
- **NÃO existe campo de custo** (`cost`) na resposta — a referência documentada não
  o inclui. **O custo em USD precisa ser calculado LOCALMENTE** com a tabela da §6.
- Cache de contexto é automático e best-effort, sem garantia de hit rate
  (https://benchlm.ai/deepseek/api-pricing) — o custo real depende dos campos
  `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` retornados.

## 6. Preços (USD / 1M tokens) — vigentes ago/2026

| Modelo | Input (cache miss) | Input (cache hit) | Output | Contexto |
|---|---|---|---|---|
| `deepseek-v4-flash` | **$0.14** | **$0.0028** | **$0.28** | 1M tokens |
| `deepseek-v4-pro` | **$0.435** | **$0.003625** | **$0.87** | 1M tokens |

Fontes: https://deepseek.ai/pricing (verificado 2026-07-25), https://benchlm.ai/deepseek/api-pricing
(revisado 2026-08-12), corroborações https://chat-deep.ai/pricing/, https://www.morphllm.com/deepseek-api,
https://www.aipricing.guru/deepseek-pricing/, https://openrouter.ai/deepseek/deepseek-v4-pro.
Sem tier gratuito de API (créditos promocionais ocasionais; só os apps de chat são grátis —
https://deepseek.ai/pricing).

**Mudança anunciada (peak/off-peak):** o changelog oficial de 2026-08-13 anuncia
preço peak/off-peak com **off-peak = metade do peak, efetivo 2026-08-16 16:00 UTC**
(https://api-docs.deepseek.com/updates/). Um espelho descreve a mecânica como
**sobretaxa 2× nas janelas UTC 01:00–04:00 e 06:00–10:00** (anunciado 2026-06-30,
"não ativo" em 02/08 — https://deepseek.ai/pricing). As duas descrições são
compatíveis em efeito (peak = 2× a tarifa-base), mas **qual conjunto de números
vira peak/off-peak não está resolvido nas fontes** — a tarifa publicada acima é a
linha de base vigente. **Recomendação:** re-verificar a página de preços oficial
após 16/08 e tratar a tabela acima como base (com possibilidade de 2× nas janelas
pico).

## 7. CORS / uso no browser (BYOK)

- **CONFIRMADO por probe real em 2026-08-14** (curl com `Origin: https://example.com`):
  - `GET https://api.deepseek.com/models` com `Authorization: Bearer` → **HTTP 200**
    com `access-control-allow-origin: https://example.com` (**refletido**),
    `access-control-allow-credentials: true` e
    `vary: origin, access-control-request-method, access-control-request-headers`.
  - Preflight `OPTIONS /models` → **HTTP 200** com
    `access-control-allow-methods: GET`, `access-control-allow-headers: authorization,content-type`
    e origin refletida.
  - Comparativo OpenRouter (`GET /api/v1/key`): 200 com `access-control-allow-origin: *`
    e preflight 204 — **BYOK funcionando nos DOIS provedores** (a chave do usuário nunca
    passa por servidor nosso no webapp).
- Nenhuma documentação oficial sobre CORS foi encontrada (a doc oficial não menciona uso
  client-side/browser), mas o comportamento REAL responde ao preflight corretamente —
  o webapp faz fetch direto com `Authorization: Bearer` sem fallback.

## 8. Probe de chave (validação de API key)

- **`GET /user/balance`** — endpoint oficial; retorna 200 com
  `is_available` (boolean) + `balance_infos[]` (`currency` CNY|USD, `total_balance`,
  `granted_balance`, `topped_up_balance`) (https://api-docs.deepseek.com/api/get-user-balance).
  Recomendado como probe: além de validar a chave, informa se há saldo (`is_available`).
  (Só o 200 está documentado; 401 em chave inválida é o comportamento padrão Bearer
  de todos os endpoints — erro 401 documentado em
  https://api-docs.deepseek.com/quick_start/error_codes.)
- **`GET /models`** — 200 com `{object:"list", data:[{id, object:"model",
  owned_by}]}` (https://api-docs.deepseek.com/api/list-models/). Alternativa de probe.
- Autenticação: Bearer em todos os endpoints; chave criada em
  https://platform.deepseek.com/api_keys (https://api-docs.deepseek.com/api/deepseek-api/).

## 9. Erros e rate limits

- **Códigos de erro oficiais** (https://api-docs.deepseek.com/quick_start/error_codes):
  - **400** Invalid Format (request body)
  - **401** Authentication Fails (chave errada)
  - **402** Insufficient Balance ("You have run out of balance" — cobrança pré-paga)
  - **422** Invalid Parameters (params inválidos — atenção: é 422, não 400)
  - **429** Rate Limit Reached ("You are sending requests too quickly")
  - **500** Server Error / **503** Server Overloaded
- **Rate limit = CONCORRÊNCIA, por conta** (https://api-docs.deepseek.com/quick_start/rate_limit):
  `deepseek-v4-pro` = **500** requests concorrentes; `deepseek-v4-flash` = **2500**;
  calculados no nível da conta (independente de qual key); estouro → **429**.
  Expansão de capacidade: gratuita mediante formulário.
- **Headers de rate limit (Retry-After etc.): NÃO documentados.** Nenhuma menção a
  `Retry-After`/`X-ratelimit-*` nas páginas oficiais — **NÃO CONFIRMADO**; o
  implementador deve tratar 429 com backoff exponencial próprio (o crawler já tem
  esse padrão para a OpenRouter).
- Nota de conexão: se a inferência não começa em **10 minutos**, o servidor fecha a
  conexão (keep-alive vazio / `: keep-alive` em SSE) — relevante para o timeout de
  job (o crawler usa 180s, OK).

## 10. Mapeamento OpenRouter → direto (resumo p/ implementadores)

| Hoje (OpenRouter, via `src/llm.js`) | Direto (api.deepseek.com) |
|---|---|
| slug `deepseek/deepseek-v4-flash-0731` | slug `deepseek-v4-flash` (sem prefixo, sem build) |
| `reasoning: {effort: xhigh/high/medium}` (nested) | `reasoning_effort` **top-level** (`low|high|max`) + `thinking: {type: enabled}` via `extra_body` |
| effort xhigh/medium | **mapeados para `high`** (oficial); `max` existe no direto |
| `usage: {include: true}` (para trazer custo) | **desnecessário** — usage sempre na resposta; **sem `cost`**; custo = tokens × tabela §6 local |
| `response_format` json_schema strict + zod | só `json_object` documentado (json_schema NÃO CONFIRMADO); exigir palavra "json" no prompt + exemplo; zod continua como guarda |
| 429 OpenRouter | 429 por conurrência (pro 500 / flash 2500); sem Retry-After documentado; 402 = saldo insuficiente |
| key probe `GET /api/v1/key` | `GET /user/balance` (is_available + saldo) ou `GET /models` |
| baseURL `https://openrouter.ai/api/v1` | baseURL `https://api.deepseek.com` (ou `.../v1`); SDK openai compatível |

## 11. Pendências de teste manual (o que o implementador deve validar com uma chave real)

1. ~~CORS: fetch direto do browser em api.deepseek.com com `Authorization` header.~~
   **RESOLVIDO (2026-08-14)** — ver §7: preflight 200 + allow-origin refletido + `authorization`
   liberado; GET com Bearer → 200.
2. `response_format: {type: "json_schema", ...}` — aceito ou 422/ignorado?
3. Parâmetros desconhecidos (ex.: `usage: {include: true}`, `reasoning: {effort}`):
   erro ou silêncio? (Observação 2026-08-14: `reasoning`/`usage`/`response_format`
   json_schema NÃO são enviados pelo crawler no direto — o body só carrega o que a API
   documenta; slug não traduzido devolve 400 com mensagem clara, ver §1.)
4. Código HTTP exato devolvido por `deepseek-chat`/`deepseek-reasoner` pós-retirement.
5. `thinking.reasoning_effort` aninhado (forma da tabela da referência) vs
   `reasoning_effort` top-level — ambos aceitos?
6. Tarifas efetivas após 2026-08-16 16:00 UTC (peak/off-peak) na página de preços oficial.
