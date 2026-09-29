# Backend Vercel — análise JEV × webhook (página /admin)

> Pedido (2026-09-28): backend na Vercel **provido de chave OpenRouter** que **toda a noite re-roda a
> busca completa**; **segunda página (`/admin`) mediante login e senha** com cadastro de um
> **webhook de disparo** e uma **análise JEV** por **input digitado** + **filtro de data O MESMO DO
> SITE** — as **notícias separadas** disparam num **JSON array** para o webhook cadastrado.

## 1. O que foi construído

| Peça | Onde | O que faz |
|---|---|---|
| API admin | `webapp/api/admin/*` | login/logout/sessão, config (input, período, fontes, limiar, webhook), teste de webhook, runs (criar/estado/avançar/reenviar), estimativa de escopo |
| Cron noturno | `webapp/api/cron/nightly.js` + `vercel.json` (`0 3 * * *` UTC) | re-roda a análise **completa** com a configuração guardada e dispara o array |
| Motor da análise | `webapp/api/_lib/analyze.js` | escopo idêntico ao do site → batches → 1 request Jev por batch → separadas → dispatch |
| Núcleo Jev | `webapp/src/shared/jev-core.js` (já existia) | builders/parse/limites da Decisions API — fonte única |
| Página | `webapp/admin/` (2ª entrada do Vite) | login, formulário, progresso ao vivo, resultados, histórico |
| Persistência | Vercel KV / Upstash (REST puro, `webapp/api/_lib/kv.js`) | config + registos de run (últimas 30) |

Sem backend de busca novo: os dados são o **snapshot publicado** (`/data/meta.json` +
`/data/articles.json`, ~36 MB) lido do próprio deployment — a fonte de verdade continua a ser o
último `git push` (o export do `pre-push`). Sem corpos de artigo no payload (decisão do usuário).

## 2. Setup na Vercel (uma vez)

1. **Vercel KV / Upstash**: dashboard → *Storage* → *Marketplace* → **Upstash Redis** → criar e
   **associar ao projeto** (injeta `KV_REST_API_URL` + `KV_REST_API_TOKEN`). Sem KV, a página lê
   config por env mas não guarda nada (503 explicativo).
2. **Environment Variables** do projeto (Production):
   | Variável | Obrigatória | O quê |
   |---|---|---|
   | `OPENROUTER_API_KEY` | sim | chave do backend (Jev via `POST /api/alpha/decisions`) |
   | `ADMIN_USER` | sim | usuário do /admin |
   | `ADMIN_PASSWORD` | sim | senha do /admin |
   | `ADMIN_SESSION_SECRET` | sim | segredo do HMAC do cookie (qualquer string longa) |
   | `CRON_SECRET` | sim | protege o cron (`Authorization: Bearer …`) |
   | `WEBHOOK_SECRET` | recomendado | assina o payload (`X-NC-Signature`) |
   | `ANALYSIS_INPUT/ANALYSIS_FROM/ANALYSIS_TO/ANALYSIS_THRESHOLD/WEBHOOK_URL` | não | config fixa por env (modo sem KV) |
   | `NC_DATA_BASE_URL` | não | de onde ler o snapshot (default: produção do projeto) |
   | `NC_JEV_MODEL/NC_JEV_BATCH/NC_JEV_CONCURRENCY/NC_JEV_TIMEOUT_MS/NC_JEV_ATTEMPTS` | não | afinar o Jev (defaults `typesafe/jev-1.13`, 30, 6, 30 s, 4) |
3. **Deploy**: `git push` na `main` (o cron já vem no `vercel.json`; Hobby = 1×/dia, disparo em
   qualquer momento dentro da hora 03:00 UTC ≈ 00:00 BRT).
4. Abrir `https://<site>/admin/`, fazer login, preencher input + período + webhook, **Guardar**.

## 3. Análise JEV (o que o modelo decide)

- **Por notícia, 1 pergunta `noul` atómica**: *"Does article #n match the user's interest?
  User interest: «input»."* → probabilidade calibrada `p` (0..1).
- **Separada** = `p ≥ limiar` (default 0.5, configurável 0.05–0.95 na página). `band(p, th)` do
  jev-core (mesma regra de borda do eval offline).
- **Batches** (~30 artigos por request; `NC_JEV_BATCH`): state condensado `{articles:[{n, title,
  title_pt, summary}]}` + 1 pergunta por artigo + guarda `injection` POR request; a âncora
  `UNTRUSTED` (conteúdo web não confiável) vai em todas as questions. Lote sinalizado por injeção
  **não dispara** nada e fica contado (`injectionFlagged` no registo).
- **Orçamento** por batch via jev-core (`state + maior pergunta ≤ 32K × 0.9`); 429/5xx repetem com
  `Retry-After`; 400/401/402/403 são terminais (402 aborta a run com erro claro).
- **Custo**: só entrada (~US$ 0,042/M tokens; saída grátis). ~160 tokens/artigo ⇒ **~US$ 0,15 por
  run de 18 mil artigos** (a página mostra estimativa antes de executar e o custo real depois).

## 4. Contrato do webhook

`POST` com body = **JSON ARRAY PURO** (uma chamada por run, só quando há ≥1 notícia separada):

```json
[
  {
    "id": 3, "url": "https://…", "title": "…", "title_pt": "…",
    "date_iso": "2026-09-03", "kind": "news", "section": null,
    "source": { "id": 2, "name": "Beta" },
    "tags": { "domain": ["devops"] },
    "summary_pt": "…", "verify_status": "ok",
    "jev": { "p": 0.92, "decision": "yes", "model": "typesafe/jev-1.13-20260917", "injection_flag": false }
  }
]
```

Headers: `Content-Type: application/json` · `X-NC-Run-Id` · `X-NC-Trigger: manual|cron` ·
`X-NC-Generated-At` · `X-NC-Count` · `X-NC-Signature: sha256=<hex>` (HMAC-SHA256 do body com
`WEBHOOK_SECRET`, quando definido).

- **Verificação da assinatura** (receptor): `hmac_sha256_hex(body, WEBHOOK_SECRET)` == o que vem
  depois de `sha256=`.
- **Teste** (botão *Testar*): `POST` com `[]` + `X-NC-Test: 1` — distinga de entrega real pelo header.
- **Falhas**: 3 tentativas (2 s/5 s) em 5xx/429/rede; 4xx não repete. Se falhar, a run fica `done`
  com `dispatch.ok=false` e a página tem **Reenviar ao webhook**.
- **Sem correspondências** ⇒ nada é disparado (`dispatch.skipped: 'no-matches'` no registo).
- O receptor pode recusar qualquer payload; a URL precisa ser **pública** (há guarda anti-SSRF:
  localhost/redens privadas/link-local são bloqueadas).

## 5. Endpoints

| Método | Rota | Auth | O quê |
|---|---|---|---|
| POST | `/api/admin/login` | — | emite cookie de sessão (HMAC, 7 d, HttpOnly/Secure/SameSite=Strict) |
| POST | `/api/admin/logout` | — | limpa o cookie |
| GET | `/api/admin/session` | cookie | presenças (key/kv/config) + modelo Jev |
| GET/PUT | `/api/admin/config` | cookie | configuração (input/from/to/sourceIds/kind/threshold/webhookUrl) |
| POST | `/api/admin/scope` | cookie | nº de artigos no escopo + custo estimado |
| POST | `/api/admin/webhook-test` | cookie | ping `[]` + `X-NC-Test: 1` |
| GET/POST | `/api/admin/runs` | cookie | histórico · cria run e avança o 1º passo |
| GET | `/api/admin/runs/:id` | cookie | estado (matches truncados a 200) |
| POST | `/api/admin/runs/:id/step` | cookie | avança a run (~25 s de batches) |
| POST | `/api/admin/runs/:id/dispatch` | cookie | reenvia o array ao webhook |
| GET/POST | `/api/cron/nightly` | `Bearer CRON_SECRET` | busca completa da noite (retoma pendentes) |

Todas as respostas admin trazem `Cache-Control: no-store`; nenhum endpoint devolve segredos.

## 6. Ciclo de vida de uma run

`running` → (batches) → `done` + dispatch · ou `error` (Jev terminal: chave/créditos).
A run **manual** é conduzida pela página (`POST …/step` em loop até `done`); a **noturna** conduz-se
no próprio handler do cron (budget de 210 s). Se uma run ficar a meio (página fechada), fica
`running` com progresso: a página tem **Retomar** e o **próximo cron termina-a primeiro** (auto-reparo)
— só sem pendentes é que cria a busca completa da noite. Os batches são determinísticos (ordenação
estável data DESC, id ASC), então retomar não repaga nem perde artigos.

## 7. Verificação local

```bash
cd webapp
npm test                          # 148 testes (inclui admin-lib/admin-run offline)
npm run build                     # Vite: main + admin
node scripts/admin-smoke.mjs      # drive Playwright do /admin com API simulada (screenshots em scripts/out/)
```

Os testes do backend correm 100% offline: snapshot de fixture servido por HTTP local, KV emulado e
transporte falso roteado (Decisions × KV × webhook) — o mesmo shape do dublê
`test/helpers/jev-double.js`.

## 8. Segurança

- Cookie de sessão **assinado HMAC-SHA256** (exp dentro da assinatura), comparação em tempo
  constante; login com *throttle* de 400 ms.
- `CRON_SECRET` obrigatório no cron (sem ele, 503 — nunca corre aberto).
- Payload assinado (`X-NC-Signature`) quando `WEBHOOK_SECRET` existe.
- Guarda anti-SSRF básica no webhook; CORS público restrito a `/api/v1/*` (o corpus público);
  `/api/admin/*` e `/api/cron/*` com `no-store` + `X-Frame-Options: DENY`.
- A página `/admin` é estática (só casca): toda a proteção real está na API. Não expõe segredos.
