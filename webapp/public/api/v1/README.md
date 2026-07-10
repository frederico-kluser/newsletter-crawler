# API pública do acervo — `v1`

Um único arquivo JSON, **público e sem autenticação**, com todo o acervo de newsletters
(notícias, ferramentas/"techs" e releases) já processado: título original, **título e resumo em
PT-BR**, **tags** por faceta, fonte, data e um trecho de preview. Feito para qualquer site ou
serviço consumir — é um contrato **estável e versionado**.

## Endpoint

| Arquivo | URL | O que é |
| --- | --- | --- |
| `corpus.json` | `https://newsletter-crawler.vercel.app/api/v1/corpus.json` | O acervo completo (dados). |
| `schema.json` | `https://newsletter-crawler.vercel.app/api/v1/schema.json` | JSON Schema (2020-12) deste formato. |
| `README.md`  | `https://newsletter-crawler.vercel.app/api/v1/README.md` | Esta documentação. |

- **Método:** `GET`. **CORS:** liberado para qualquer origem (`Access-Control-Allow-Origin: *`) —
  dá para chamar direto do navegador em qualquer domínio.
- **Tamanho:** ~5 MB não comprimido (a Vercel serve com gzip/brotli, ~1 MB na rede). **Não** inclui
  o corpo completo dos artigos, só metadados + resumos + tags.
- **Atualização:** regenerado **a cada deploy** (todo push na `main` re-exporta o acervo). Veja
  `generatedAt` no topo do arquivo para saber a validade do snapshot.
- **Cache:** `s-maxage=3600` na CDN (invalidada automaticamente a cada novo deploy).

## Estabilidade

`v1` é **aditivo**: novos campos podem aparecer, mas os documentados aqui não são removidos nem
mudam de tipo. Qualquer mudança incompatível sai numa nova versão de caminho (`/api/v2/...`) — a
`v1` continua no ar. Programe defensivamente (ignore campos desconhecidos).

## Estrutura do `corpus.json`

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-10T12:00:00.000Z",   // ISO-8601; ÚNICO campo que muda entre exports iguais
  "documentation": "/api/v1/README.md",
  "schema": "/api/v1/schema.json",
  "totals": {
    "articles": 2910,                            // == articles.length
    "summaries": 2370,                           // quantos têm resumo PT-BR
    "classified": 2360,                          // quantos têm tags
    "byKind": { "news": 1800, "tool": 700, "release": 300, "unknown": 110 }
  },
  "dates": { "min": "2025-01-03", "max": "2026-07-09" },   // YYYY-MM-DD (menor/maior data do acervo)
  "sources": [ { "id": 1, "name": "Node Weekly", "count": 512 } ],   // fontes + nº de artigos
  "facets": [                                    // catálogo global de tags, por faceta
    { "name": "domain", "tags": [ { "tag": "nodejs", "count": 210 } ] }
  ],
  "articles": [ /* ver abaixo */ ]
}
```

### Campos de cada artigo (`articles[]`)

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `id` | number | Identificador estável do artigo. |
| `url` | string | URL original do artigo. |
| `sourceId` | number | Id da fonte (chaveia em `sources[]`). |
| `sourceName` | string \| null | Nome da fonte (ex.: `"Node Weekly"`). |
| `title` | string | Título original (idioma da fonte, normalmente inglês). |
| `titlePt` | string \| null | Título em PT-BR (`null` se ainda não resumido). |
| `summaryPt` | string \| null | **Resumo em PT-BR** (`null` se ainda não resumido). |
| `snippet` | string | Trecho de preview (~400 caracteres, sem HTML). |
| `kind` | string \| null | `"news"`, `"tool"` (techs/ferramentas), `"release"` ou `null`. |
| `section` | string \| null | Seção da newsletter de origem (ex.: `"Tools"`), quando houver. |
| `date` | string | Data de publicação `YYYY-MM-DD` (cai na data de coleta se a fonte não datar). |
| `verifyStatus` | string \| null | Controle de qualidade por IA: `"ok"`, `"suspect"`, `"junk"` ou `null`. |
| `tags` | object | Mapa `{ faceta: [tags] }`. `{}` se ainda não classificado. Ex.: `{ "domain": ["nodejs"], "content-type": ["tool-release"] }`. |

> **Filtrando qualidade:** o acervo é exportado **inteiro**. Para uma base "limpa", filtre por
> `verifyStatus === "ok"` (descarta `suspect`/`junk` marcados pela IA).
>
> **Campos podem ser `null`:** artigos recém-coletados ainda sem resumo/tags trazem `titlePt`,
> `summaryPt` = `null` e `tags` = `{}` — o campo está **sempre presente**, nunca some.
>
> **Corpo completo:** não vai nesta API (peso). Fica no snapshot interno do site em
> `/data/contents.json` (mapa `id → texto`), se você precisar do texto integral.

## Exemplos

### curl — quantos artigos e de quando

```bash
curl -s https://newsletter-crawler.vercel.app/api/v1/corpus.json \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.totals, d.dates)'
```

### JavaScript (browser ou Node ≥ 18) — últimas ferramentas com resumo

```js
const { articles } = await fetch(
  'https://newsletter-crawler.vercel.app/api/v1/corpus.json',
).then((r) => r.json());

const techs = articles
  .filter((a) => a.kind === 'tool' && a.verifyStatus === 'ok' && a.summaryPt)
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, 20)
  .map((a) => ({ titulo: a.titlePt, resumo: a.summaryPt, url: a.url, data: a.date }));

console.table(techs);
```

### Filtrar por tag (faceta `domain` = `nodejs`)

```js
const nodeArticles = articles.filter((a) => (a.tags.domain || []).includes('nodejs'));
```

### Filtrar por período

```js
const from = '2026-06-01', to = '2026-06-30';
const junho = articles.filter((a) => a.date >= from && a.date <= to); // datas são YYYY-MM-DD comparáveis como string
```

## Validação de schema

`schema.json` é um JSON Schema (draft 2020-12). Exemplo com [ajv](https://ajv.js.org/):

```js
import Ajv2020 from 'ajv/dist/2020.js';
const [schema, data] = await Promise.all([
  fetch('https://newsletter-crawler.vercel.app/api/v1/schema.json').then((r) => r.json()),
  fetch('https://newsletter-crawler.vercel.app/api/v1/corpus.json').then((r) => r.json()),
]);
const ok = new Ajv2020().validate(schema, data);
```
