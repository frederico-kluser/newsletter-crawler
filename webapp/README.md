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

**Histórico de buscas (no navegador):** toda busca IA concluída é **salva automaticamente** no
`localStorage` (`src/lib/history.js`, sem backend). Ao focar o campo aparecem as **buscas recentes**,
e o ícone de histórico na barra abre o **painel** com todas: **abrir** re-hidrata os resultados
**congelados** do snapshot (consulta, custo real, cards) **sem gastar IA de novo**; **rodar de novo**
re-executa com o mesmo escopo (passando pela confirmação de custo); dá p/ **apagar** um item ou
**limpar tudo**. Auto-save sem limite; só poda os mais antigos se o `localStorage` recusar por quota.

> Faz parte do repositório `newsletter-crawler`. O CLI continua sendo a fonte da verdade: ele
> coleta/classifica os artigos e **gera o snapshot** que este site serve.

## Idiomas (PT/EN) e tutorial

A interface é **bilíngue**: detecta o idioma do navegador (português → **PT**; **qualquer outro
idioma → EN**) e deixa trocar a qualquer hora pelo seletor **PT | EN** na barra do topo (a escolha
fica salva no navegador). O **conteúdo do acervo** (títulos originais + resumos/tags em PT-BR)
**não** é traduzido — só a casca da interface.

Na **1ª visita** abre um **tutorial** em etapas (estilo "Welcome" do iOS) explicando o app; o botão
de ajuda (**?**) na barra do topo reabre quando quiser. Toda string da UI vive em `src/strings.js`
(`DICTS` com os dois idiomas) e o `npm test` garante que PT e EN tenham exatamente as mesmas chaves.

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
npm test           # testes das libs puras (filtros, busca, custo, pool, i18n)
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

Com o projeto Vercel conectado ao repo (caminho 2 acima), o fluxo é automático:

1. Rode um crawl no CLI como de costume (ele já resume + classifica; ou `ncrawl finish` p/ terminar pendentes).
2. `git push` na main. O hook versionado `.githooks/pre-push` (instalado por `npm install` do repo
   raiz) re-exporta o snapshot do banco local e, se houver dado novo, commita `webapp/public/data`
   e **interrompe o push** — repita o `git push` e a Vercel publica sozinha.

O hook é fail-open: sem banco local ele não bloqueia nem commita nada (e nunca auto-commita um
snapshot com MENOS artigos que o publicado — proteção contra máquina sem o banco). Manualmente,
o equivalente segue sendo `ncrawl export --format web && git add webapp/public/data && git commit && git push`.

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
- `src/i18n.jsx` + `src/strings.js` — i18n bilíngue PT/EN (Context próprio `useStrings`, sem lib;
  toda string nos dois idiomas, paridade coberta por `test/i18n.test.js`); detecção do idioma do
  navegador em `src/lib/locale.js` (espelhada no pré-paint do `index.html`).
  `src/components/Tutorial.jsx` — tutorial de introdução (auto na 1ª visita + botão de ajuda `?`).
- `src/motion/` — vocabulário único de springs do Motion.
- Animações respeitam `prefers-reduced-motion`; só `transform`/`opacity`/`filter` são animados.
