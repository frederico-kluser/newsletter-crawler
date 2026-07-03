# Acervo — buscador web estático · v1.0.0

Buscador do acervo de newsletters de tecnologia. É um app **estático** (Vite + React + Motion)
que lê um **snapshot JSON commitado** (`public/data/`) — **sem backend nenhum**.

Dois modos de busca:
- **Por texto/filtros (padrão, sem chave):** digitar filtra o acervo **localmente** no navegador
  (busca textual acento-insensível sobre título/resumo/tags), combinada com os filtros de fonte,
  período, 9 facetas de tags e verificação. Instantâneo, sem custo, sem rede.
- **Por IA (opcional, semântica):** o botão **IA** roda uma busca inteligente (OpenRouter) usando
  a chave do próprio usuário (BYOK), guardada só no navegador. Sem chave, o botão pede a chave —
  mas a busca por texto continua funcionando normalmente.

> Faz parte do repositório `newsletter-crawler`. O CLI continua sendo a fonte da verdade: ele
> coleta/classifica os artigos e **gera o snapshot** que este site serve.

## Pré-requisito: gerar os dados

O site lê `webapp/public/data/{meta,articles,contents}.json`. Gere/atualize com o CLI (na raiz
do repo) e **commite** o resultado:

```bash
ncrawl export --format web        # ou: node src/index.js export --format web
git add webapp/public/data && git commit -m "chore(webapp): atualiza snapshot do acervo"
```

O export é idempotente: sem mudança na base, `articles.json`/`contents.json` saem byte-idênticos
(só `meta.json` muda, no campo `generatedAt`) — o diff do git fica limpo.

## Rodar localmente

```bash
cd webapp
npm install
npm run dev        # http://localhost:5173
npm run build      # gera dist/ (produção)
npm run preview    # serve o dist/ localmente
npm test           # testes das libs puras (filtros, busca, custo, pool)
npm run screenshots # (opcional) fotos desktop/mobile via Playwright do repo raiz
```

## Deploy na Vercel (sem backend)

O app é 100% estático — não há função serverless nem variável de ambiente. Escolha um caminho:

### 1. CLI da Vercel (mais rápido)
```bash
cd webapp
npx vercel          # 1ª vez: login + "link" do projeto
npx vercel --prod   # publica em produção
```

### 2. Import do GitHub (deploy automático a cada push)
No dashboard da Vercel → **Add New… → Project** → importe este repositório e configure:
- **Root Directory:** `webapp`
- **Framework Preset:** Vite (detectado automaticamente)
- Build/Output: padrão (`npm run build` → `dist/`)

Cada `git push` que altere `webapp/` (inclusive o snapshot de dados) dispara um novo deploy.

### 3. Drag-and-drop (sem git)
```bash
cd webapp && npm run build
```
Arraste a pasta `webapp/dist/` em [vercel.com/new](https://vercel.com/new).

Não é preciso `vercel.json`: é uma SPA de rota única, sem rewrites nem funções. A Vercel serve
os `/data/*.json` já comprimidos (gzip/brotli) — o snapshot completo fica em ~0,7 MB na rede.

## Atualizar o acervo depois de publicado

1. Rode um crawl/summarize/classify no CLI como de costume.
2. `ncrawl export --format web` (regenera o snapshot).
3. `git add webapp/public/data && git commit && git push`.

No caminho **2** (GitHub), o push já redeploya. Nos caminhos 1/3, rode o deploy de novo.

## Privacidade da busca por IA

- A busca por texto/filtros é **100% local** — não sai do seu navegador.
- A chave da OpenRouter fica **só no seu navegador** (`localStorage`), nunca é enviada a nenhum
  servidor nosso; gerencie-a pelo botão de chave (🔑) na barra do topo. As chamadas de IA vão
  **direto do seu navegador para a OpenRouter**.
- Dica: crie uma chave **dedicada com limite de crédito** em
  [openrouter.ai/keys](https://openrouter.ai/keys).
- Antes de rodar, o app mostra o escopo, o número de chamadas e o **custo estimado**; a busca
  profunda sempre pede confirmação. O custo **real** aparece no fim.

## Como funciona (resumo técnico)

- `src/lib/` — núcleo puro e testável (sem React): `data` (carrega o snapshot), `filters`
  (reproduz o `WEB_WHERE` do CLI — facetas AND-de-OR, kind com release, verificação, período),
  `search`/`openrouter`/`cost` (busca IA portada de `src/search.js`/`src/llm.js`), `taxonomy`,
  `format`, `pool`, `storage`.
- `src/components/` + `src/hooks/` — a UI (sidebar/drawer de filtros, grid animado, sheet de
  preview, busca IA) e o estado (`useReducer` de filtros + `useAiSearch`).
- `src/motion/` — vocabulário único de springs do Motion.
- Animações respeitam `prefers-reduced-motion`; só `transform`/`opacity`/`filter` são animados.
