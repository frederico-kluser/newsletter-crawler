// Snapshot JSON estático do acervo p/ o webapp (`ncrawl export --format web`), em webapp/public/
// data — meta.json (totais/fontes/facetas/config da busca IA + contentsParts; ÚNICO com campo
// volátil, generatedAt), articles.json (campos de browse SEM content, id ASC) e contents.partN.json
// (map id→content de CADA parte; o cliente baixa só a parte que contém um id, ao abrir um preview
// ou rodar busca profunda). O contents ÚNICO (contents.json) passou de 100 MB no acervo cheio e o
// GitHub rejeita blobs > 100 MB (GH001) — por isso o mapa é FATIADO em partes determinísticas por
// id ASC, com peso acumulado de bytes até um alvo (EXPORT_WEB_PART_MB, default 85), e o arquivo
// antigo é SEMPRE removido do outDir (nunca pode sobrar p/ o deploy o commitá-lo de novo).
// Determinístico de propósito: toda ordenação vem do SQL, o stringify é estável e a estimativa de
// bytes jamais subestima — re-exportar sem mudança na base gera bytes idênticos em articles/partes
// (diffs de git legíveis).
//
// GUARD ANTI-ENCOLHIMENTO (mora AQUI, não só no deploy): o histórico do git é a BASE DE REGISTRO do
// acervo, e o snapshot tem QUATRO escritores — `ncrawl deploy`, o hook `.githooks/pre-push`,
// `ncrawl export --format web` (commands.js) e qualquer commit manual feito numa worktree. Um guard
// só no deploy/hook deixa os outros dois passarem, e o `export` escreve em ROOT/webapp/public/data
// independentemente do cwd. Por isso `exportWebSnapshot` CONSULTA a decisão (evaluateSnapshotChange,
// src/snapshot-guard.js) ANTES da primeira escrita: o snapshot inteiro é montado em MEMÓRIA e, se o
// veredito for BLOQUEAR, nenhum arquivo é tocado (bloquear DEPOIS de escrever deixaria os JSONs já
// esvaziados na árvore, prontos p/ o próximo `git add` — o dado se perderia pela porta dos fundos
// com o guard "funcionando"). Incidente que originou tudo: 2026-08-24, commit 7c24491, 0 artigos
// publicados por cima de 2866.
//
// ESCRITA (o guard aprovou): os arquivos vão para TEMPORÁRIOS no próprio outDir e só então são
// PROMOVIDOS por rename — partes, depois articles.json, e o meta.json POR ÚLTIMO. "Nenhum arquivo é
// tocado" vale para o caminho de bloqueio; aqui a garantia é outra e igualmente necessária: uma
// exceção no meio da escrita (disco cheio, arquivo virou diretório, permissão) deixaria a árvore
// meio-escrita e COMITÁVEL — e, pior, um meta.json novo (totals.articles ALTO) sobre um
// articles.json velho ENVENENA o próprio baseline do guard, que lê `totals.articles` como
// high-water. Com o meta por último, o baseline só avança depois que o corpo do snapshot já está
// no lugar; falhou antes disso, o baseline continua sendo o do snapshot antigo (o verdadeiro).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts } from './db.js';
import {
  MODELS, SEARCH_BATCH_SIZE, SEARCH_MAX_CHARS, SEARCH_WEB_MAX_ITEMS,
  SEARCH_MODE_A_CONFIRM, SEARCH_SOFT_CONFIRM, stageModel, translateModel,
  SEARCH_WEB_SOFT_CONCURRENCY, SEARCH_WEB_DEEP_CONCURRENCY,
  SEARCH_UI_CONCURRENCY_DEFAULT, SEARCH_UI_CONCURRENCY_CEILING,
  TTS_MODEL, TTS_VOICE, TTS_FORMAT, EXPORT_WEB_PART_MB,
} from './config.js';
import { getFacets, TOOL_CONTENT_TYPES } from './taxonomy.js';
import { redactSecrets } from './redact.js';
import { evaluateSnapshotChange, articlesFromMeta, SHRINK_OPT_IN, WIPE_OPT_IN } from './snapshot-guard.js';
import { log, warn } from './util.js';

// Média REAL de custo por chamada do estágio (>=3 amostras cobradas), senão null — o cliente cai
// nos seeds por tier. Mesma regra de estimateStageCallUsd (budget.js), mas aqui distinguimos a
// origem p/ OMITIR a chave quando só existiria o seed (o webapp tem os seeds hardcoded).
function costHint(stage) {
  try {
    const h = stmts.avgUsageByStage.get(stage);
    if (h && h.n >= 3 && h.avg > 0) return h.avg;
  } catch {
    /* base antiga sem llm_usage: sem hint */
  }
  return null;
}

// ---- contents em partes (map id→content fatiado; o arquivo único passou de 100 MB) ----

// Teto DURO de uma parte (MB). Um artigo isolado pode estourar o ALVO e vai sozinho numa parte,
// mas acima disto o export FALHA (fail-closed): uma parte com um único artigo gigante repetiria o
// bloqueio GH001 do GitHub (blobs > 100 MB rejeitados no push). Alvo default 85 deixa folga de 10.
const PART_HARD_CAP_MB = 95;

// Custo serializado de ` "key": <json>` numa parte (indent 1): indent+newline (2) + aspas do key
// (key.length+2) + ": " (2) + corpo JSON-escapeado + vírgula/fecha (1). O JSON.stringify escapeia
// aspas/controles/`\` (nunca encolhe), então a estimativa NUNCA subestima o byte final — a parte
// real fica sempre <= alvo quando o corte é por esta estimativa (a única exceção é um artigo
// isolado maior que o alvo: ele vai sozinho numa parte, ainda <= teto duro — acima do teto duro o
// export LANÇA erro, fail-closed, nunca uma parte > teto).
function entryBytes(key, body) {
  return 2 + key.length + 2 + 2 + Buffer.byteLength(JSON.stringify(body)) + 1;
}

function partTargetBytes(partMb) {
  const mb = Number(partMb);
  const safe = Number.isFinite(mb) && mb > 0 ? mb : EXPORT_WEB_PART_MB;
  return Math.floor(safe * 1024 * 1024);
}

// ---- proveniência do item (issue_url + blurb) e a regra anti-duplicação do snippet ----

// Por que o snapshot carrega estes dois campos: SEM eles um restore do acervo (repovoar o SQLite a
// partir do snapshot commitado) não consegue alimentar o 4º ramo do `stmts.isUrlKnown`
// (`articles.issue_url`) nem a parada determinística de paginação — e aí TODO restore é seguido de
// uma re-curadoria por IA de ~600 issues × 9 fontes, a fase MAIS CARA do pipeline. O `blurb` é a
// descrição do PRÓPRIO agregador (o que a curadoria cadastrou), então repô-lo devolve a ficha do
// item sem uma única chamada de LLM. Os dois vêm do próprio `stmts.webExportArticles` (db.js), numa
// query só: a versão anterior varria `listArticlesBySource` fonte a fonte e PERDIA justamente o
// artigo com `source_id` NULO — que é o que um restore produz quando a fonte não pôde ser remapeada.
// Os dois vão em articles.json (nunca nos contents.partN: as partes já beiram o teto de 100 MB do
// GitHub e estes campos são pequenos).
//
// SNIPPET × BLURB — o mesmo texto NUNCA viaja duas vezes. O snippet do SQL é
// `substr(coalesce(blurb, content), 1, 400)`: quando o artigo TEM blurb, o snippet é literalmente o
// prefixo dele (o blurb já nasce com whitespace normalizado, curate.js). Medido sobre os 13.758
// artigos do acervo publicado: mandar os dois punha o articles.json em 27,6 MiB (+12,5%); mandando
// um OU outro ele fica em 25,5 MiB (+3,9%) — 2,1 MiB de texto repetido a cada deploy. Então:
//   • artigo COM blurb  -> `blurb` completo (fonte da verdade) e `snippet: null`;
//   • artigo SEM blurb  -> `snippet` como sempre (derivado do content) e `blurb: null`.
// `snippet === null` significa exatamente "derive do blurb" e `blurb === null` significa "não há
// blurb" — sem ambiguidade p/ o restore, ao contrário de omitir o blurb quando ele empata com o
// snippet (aí `blurb: null` seria "não há" OU "é igual ao snippet", e o restore chutaria).
// Quem lê: webapp/src/lib/data.js (`hydrateSnippet`, a ÚNICA fronteira de dados do site) refaz o
// snippet pela MESMA regra antes de qualquer consumidor. Snapshot antigo (snippet preenchido) passa
// direto por lá — a mudança é retrocompatível na leitura.
const SNIPPET_CHARS = 400; // = o substr do webExportArticles (db.js)

// Teto por blurb. Um blurb é um parágrafo do agregador (mediana ~250 chars no acervo real), mas
// nada no schema o limita: um item patológico entraria inteiro no articles.json, que é COMMITADO.
// 4000 chars = ~10× o snippet e ~16× a mediana; acima disso o excedente não acrescenta ficha, só
// bytes ao arquivo que precisa caber no limite de 100 MB do GitHub. Truncar aqui é seguro: o corpo
// completo do item continua em contents.partN.json (o blurb vira o content quando o alvo não
// enriquece, curate.js) — quem trunca é a FICHA, não o acervo.
const BLURB_MAX_CHARS = 4000;

/**
 * Snippet derivado do blurb — a MESMA regra do SQL + normalização. Exportado de propósito mesmo
 * sem chamador em src/: é o CONTRATO da derivação, contra o qual o leitor do site
 * (webapp/src/lib/data.js `hydrateSnippet`) e os testes conferem. Mudou aqui, muda lá.
 */
export function snippetFromBlurb(blurb) {
  return String(blurb || '').slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
}

// Blurb do banco -> o que vai no snapshot: null quando não há (string vazia = não há), truncado no
// teto. A truncagem é contada pelo chamador p/ virar UM aviso (nunca um warn por artigo).
function capBlurb(raw, stats) {
  const s = raw == null ? '' : String(raw);
  if (!s) return null;
  if (s.length <= BLURB_MAX_CHARS) return s;
  stats.truncated += 1;
  return s.slice(0, BLURB_MAX_CHARS);
}

/** Monta os objetos do snapshot (puro sobre stmts; o writer fica em exportWebSnapshot). */
export function buildWebSnapshot({ partMb } = {}) {
  // meta: espelho do apiMeta do web.js (fontes/facetas/datas/custo) + a config da busca IA,
  // p/ o webapp acompanhar mudanças de config/models.json com um re-export (sem deploy de código).
  const tagRows = stmts.webMetaTags.all();
  const grouped = new Map();
  for (const r of tagRows) {
    if (!grouped.has(r.facet)) grouped.set(r.facet, []);
    grouped.get(r.facet).push({ tag: r.tag, count: r.c });
  }
  // Ordem canônica da taxonomia; fail-open p/ a ordem do banco (como no web.js — o export
  // não pode cair por taxonomy.json ausente).
  let order = [...grouped.keys()];
  try {
    const canonical = getFacets().map((f) => f.name);
    order = [...canonical.filter((n) => grouped.has(n)), ...order.filter((n) => !canonical.includes(n))];
  } catch {
    /* mantém a ordem do banco */
  }
  const dates = stmts.webMetaDates.get();
  const usage = stmts.sumUsageTotal.get();
  const hints = { searchBatch: costHint('searchBatch'), searchRelevance: costHint('searchRelevance'), searchSpec: costHint('searchSpec') };
  const costHints = Object.fromEntries(Object.entries(hints).filter(([, v]) => v != null));

  const meta = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totals: {
      articles: stmts.countArticles.get().c,
      summaries: stmts.countSummaries.get().c,
      classified: stmts.countClassifications.get().c,
    },
    cost: { totalUsd: usage.usd, totalCalls: usage.n },
    sources: stmts.webMetaSources.all().map((s) => ({ id: s.id, name: s.name || s.base_url, count: s.c })),
    facets: order.map((name) => ({ name, tags: grouped.get(name) })),
    dates: { min: dates.min_d, max: dates.max_d },
    toolContentTypes: [...TOOL_CONTENT_TYPES],
    search: {
      batchSize: SEARCH_BATCH_SIZE,
      maxChars: SEARCH_MAX_CHARS,
      maxItems: SEARCH_WEB_MAX_ITEMS,
      deepConfirm: SEARCH_MODE_A_CONFIRM,
      softConfirm: SEARCH_SOFT_CONFIRM,
      models: {
        searchBatch: stageModel('searchBatch'),
        searchRelevance: stageModel('searchRelevance'),
        searchSpec: stageModel('searchSpec'), // entendimento da consulta (busca precisão-primeiro)
        // MODELS.pro guarda o slug OpenRouter; o export reflete o que o runtime usa de fato
        // (translateModel é identidade no openrouter, direto na DeepSeek).
        fallback: { model: translateModel(MODELS.pro) },
      },
      concurrency: { soft: SEARCH_WEB_SOFT_CONCURRENCY, deep: SEARCH_WEB_DEEP_CONCURRENCY },
      uiConcurrency: { default: SEARCH_UI_CONCURRENCY_DEFAULT, ceiling: SEARCH_UI_CONCURRENCY_CEILING },
      costHints,
    },
    // Play de áudio (TTS): modelo/voz que o webapp usa ao narrar summary_pt direto do browser
    // (BYOK). Re-export troca a voz sem deploy de código; o webapp tem fallback próprio.
    audio: { model: TTS_MODEL, voice: TTS_VOICE, format: TTS_FORMAT },
  };

  // Tags de todos os artigos numa query só, agrupadas no shape {faceta:[tags]} (= tagsOf do web.js).
  const tagsByArticle = new Map();
  for (const r of stmts.webExportTags.all()) {
    let m = tagsByArticle.get(r.article_id);
    if (!m) tagsByArticle.set(r.article_id, (m = {}));
    (m[r.facet] ||= []).push(r.tag);
  }
  const blurbStats = { truncated: 0 };
  const articles = stmts.webExportArticles.all().map((a) => {
    // Fonte da verdade do preview: o blurb quando existe (o snippet do SQL é o prefixo DELE, e o
    // par snippet+blurb mandaria o mesmo texto duas vezes — ver a regra acima).
    const blurb = capBlurb(a.blurb, blurbStats);
    return {
      ...a,
      // o substr do SQL não normaliza whitespace; espelha o snippet() da busca (search.js)
      title: redactSecrets(a.title),
      snippet: blurb ? null : redactSecrets(String(a.snippet || '').replace(/\s+/g, ' ').trim()),
      // Campos PRESENTES com null quando não há (mesma regra do title_pt) — o consumidor do restore
      // lê `row.issue_url`/`row.blurb` direto. O blurb sai CRU (sem normalizar whitespace): é o
      // corpo da ficha, não um preview. A redação de segredos vale p/ os DOIS: o issue_url também
      // viaja no arquivo commitado e o Push Protection do GitHub rejeitaria o push inteiro por um
      // token numa querystring (ele é metadado de proveniência, não o link renderizado do card —
      // esse é o `url`, que segue intocado p/ o webapp continuar abrindo o artigo).
      issue_url: redactSecrets(a.issue_url ?? null),
      blurb: redactSecrets(blurb),
      tags: tagsByArticle.get(a.id) || {},
    };
  });
  if (blurbStats.truncated) {
    warn(
      `export web: ${blurbStats.truncated} blurb(s) truncado(s) em ${BLURB_MAX_CHARS} chars no ` +
        `articles.json (o texto completo do item segue em contents.partN.json).`,
    );
  }

  // ---- contents em PARTES: particiona por id ASC acumulando o peso estimado de bytes ----
  // Cada parte vira contents.partN.json com o map id→content daquele corte e o meta ganha
  // contentsParts [{file, from, to}] p/ o cliente localizar a parte de um id (sem baixar tudo).
  // Determinístico: a ordem vem do ORDER BY id do stmts e o peso só depende dos bytes dos corpos.
  const targetBytes = partTargetBytes(partMb);
  const hardCapBytes = PART_HARD_CAP_MB * 1024 * 1024;
  const contentsParts = [];
  let cur = null;
  for (const r of stmts.webExportContents.all()) {
    const key = String(r.id);
    // Corpos passam pela redação de segredos: um artigo pode carregar um token no texto e o GitHub
    // Push Protection rejeitaria o push do snapshot inteiro (ver src/redact.js).
    const body = redactSecrets(r.content);
    const cost = entryBytes(key, body);
    // Fail-closed: um artigo isolado acima do TETO DURO vira uma parte > 100 MB e o GitHub
    // rejeitaria o push (GH001) — o export não pode produzir isso nem com aviso, lança erro.
    if (cost > hardCapBytes) {
      throw new Error(
        `export web: artigo ${r.id} tem ~${(cost / 1024 / 1024).toFixed(1)} MB sozinho — ` +
          `acima do teto duro de ${PART_HARD_CAP_MB} MB por parte; o GitHub rejeitaria o push (GH001).`,
      );
    }
    // Fecha a parte atual quando a próxima entrada estouraria o alvo (a parte já tem >= 1 entrada;
    // um artigo isolado entre o alvo e o teto duro vai sozinho — excede o alvo mas fica <= teto).
    if (cur && cur.bytes + cost > targetBytes) cur = null;
    if (!cur) {
      cur = { file: `contents.part${contentsParts.length}.json`, from: r.id, to: r.id, map: {}, bytes: 2 };
      contentsParts.push(cur);
    }
    cur.map[key] = body;
    cur.bytes += cost;
    if (r.id < cur.from) cur.from = r.id;
    if (r.id > cur.to) cur.to = r.id;
  }

  // o cliente localiza a parte de um id por from..to, sem baixar as outras.
  meta.contentsParts = contentsParts.map(({ file, from, to }) => ({ file, from, to }));

  return { meta, articles, contentsParts };
}

// ---- guard anti-encolhimento: baseline HIGH-WATER + a decisão pura ----

/**
 * Bloqueio do guard. `.verdict` é o objeto de evaluateSnapshotChange (counts/reason/risk/message),
 * `.hint` é a saída acionável (o opt-in exato, copiável p/ a linha de comando). O `.message` junta
 * os dois DE PROPÓSITO: `ncrawl export --format web` e o `.githooks/pre-push` não formatam erro —
 * o que aparece p/ o usuário ali é o stack cru, e sem a hint embutida ele ficaria sem saída. Quem
 * formata (o deploy) usa `.verdict.message` + `.hint` e não duplica nada.
 */
export class SnapshotShrinkError extends Error {
  constructor(verdict) {
    super(verdict.hint ? `${verdict.message}\n${verdict.hint}` : verdict.message);
    this.name = 'SnapshotShrinkError';
    this.hint = verdict.hint || null;
    this.verdict = verdict;
  }
}

// Quantos commits do meta.json varrer p/ achar o MAIOR acervo já publicado. O `-n` do rev-list conta
// commits QUE TOCAM o pathspec, então a janela é medida em DEPLOYS de dado, não em commits do repo.
// Por que 1000 e não 40: a janela é a memória do ratchet. Com 40, um wipe não detectado seguido de
// 40 commits de dado no tamanho reduzido faz o high-water ESQUECER o acervo original — e 40 commits
// de dado é ~2 meses no ritmo real deste repo (48 commits tocaram o meta.json em toda a sua vida).
// 1000 cobre ~3 anos no mesmo ritmo e custa quase nada: o histórico INTEIRO de hoje são 2,4 MB
// lidos em 13 ms. A leitura é fatiada em lotes (HIGH_WATER_BATCH) p/ o pico de memória não crescer
// com a janela, e quando a janela CORTA o histórico o guard avisa alto — janela finita que passa
// despercebida é como o ratchet volta. Override: EXPORT_HIGH_WATER_COMMITS.
const HIGH_WATER_COMMITS = Math.max(1, Number(process.env.EXPORT_HIGH_WATER_COMMITS) || 1000);
const HIGH_WATER_BATCH = 250; // revs por spawn de cat-file (pico ≈ lote × tamanho do meta.json)
const GIT_MAX_BUFFER = 128 * 1024 * 1024;

// Primeiro ancestral que EXISTE de `dir` — `git -C` num diretório inexistente falha, e o outDir
// pode ter sido apagado (`rm -rf webapp/public/data`) justamente no caso que o guard tem de pegar.
function existingAncestor(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i += 1) {
    try {
      if (existsSync(cur)) return cur;
    } catch {
      return null;
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: GIT_MAX_BUFFER,
    ...opts,
  });
}

// Maior `totals.articles` entre os blobs devolvidos por `git cat-file --batch`. O formato é
// "<oid> <tipo> <tamanho>\n<corpo>\n" por objeto (ou "<nome> missing\n", que só pulamos).
function maxArticlesInBatch(buf) {
  let best = null;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = buf.toString('utf8', i, nl);
    i = nl + 1;
    const m = /^\S+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "missing"/"ambiguous": sem corpo p/ pular, segue p/ a próxima linha
    const size = Number(m[2]);
    const body = m[1] === 'blob' ? buf.toString('utf8', i, i + size) : null;
    i += size + 1; // + o \n que fecha o objeto
    const n = body == null ? null : articlesFromMeta(body);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best;
}

/**
 * MAIOR total de artigos já commitado no `meta.json` de `outDir`, olhando TODAS as refs
 * (`git rev-list --all`), não só o HEAD. Null = não deu p/ ler (fora de repo, sem commits, git
 * ausente) — o chamador trata como baseline DESCONHECIDO, e o evaluateSnapshotChange já é
 * fail-safe com isso.
 *
 * Por que high-water e não HEAD: comparar só com o HEAD é um RATCHET — assim que um snapshot menor
 * entra em HEAD (foi o que 7c24491 fez com 2866 → 0), o guard passa a aceitar qualquer coisa >=
 * aquilo, p/ sempre. O maior total já publicado em QUALQUER ref é o que o acervo realmente foi.
 *
 * Fora de repo (ou outDir fora dele) é SILÊNCIO de propósito — é o caso normal de `--out /tmp/...`
 * e dos testes. Qualquer OUTRA falha de leitura (git fora do PATH, cat-file quebrado, buffer
 * estourado) AVISA ALTO: o baseline vira desconhecido e, sem `head` nem `live`, um export de 0
 * artigos passaria como "primeiro snapshot" sem ninguém notar que o guard ficou cego.
 */
export function publishedHighWater(outDir, { commits = HIGH_WATER_COMMITS } = {}) {
  let top;
  try {
    const start = existingAncestor(outDir);
    if (!start) return null;
    top = git(start, ['rev-parse', '--show-toplevel']).trim();
    if (!top) return null;
  } catch (e) {
    // `rev-parse` fora de um repo sai 128 (esperado); `git` ausente do PATH sai ENOENT (não é).
    if (e?.code === 'ENOENT') {
      warn(`guard do snapshot CEGO: git não está no PATH — o baseline do acervo publicado ficou DESCONHECIDO (${outDir}).`);
    }
    return null;
  }
  try {
    // pathspec relativo à RAIZ do repo (todos os comandos rodam com cwd = top)
    const rel = path.relative(top, path.join(path.resolve(outDir), 'meta.json')).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return null; // outDir fora do repo: nada a comparar
    const todos = git(top, ['rev-list', '--all', '--', rel])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!todos.length) return null;
    const revs = todos.slice(0, commits);
    if (todos.length > revs.length) {
      warn(
        `guard do snapshot: o meta.json tem ${todos.length} commits e a janela do high-water olha ` +
          `os ${revs.length} mais recentes — um acervo MAIOR publicado antes disso não entra no ` +
          `baseline (aumente EXPORT_HIGH_WATER_COMMITS).`,
      );
    }
    let best = null;
    for (let i = 0; i < revs.length; i += HIGH_WATER_BATCH) {
      const lote = revs.slice(i, i + HIGH_WATER_BATCH);
      const batch = execFileSync('git', ['-C', top, 'cat-file', '--batch'], {
        input: `${lote.map((r) => `${r}:${rel}`).join('\n')}\n`,
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const n = maxArticlesInBatch(batch);
      if (n != null && (best == null || n > best)) best = n;
    }
    return best;
  } catch (e) {
    // fail-open na LEITURA (baseline desconhecido), fail-safe na DECISÃO — mas nunca em silêncio.
    warn(`guard do snapshot CEGO: não deu p/ ler o high-water do git (${e?.message || e}) — baseline DESCONHECIDO.`);
    return null;
  }
}

// Total do meta.json que está NO DISCO agora (o arquivo prestes a ser sobrescrito). Entra no
// baseline junto do high-water do git: um export legítimo ainda não commitado também é acervo.
function localMetaArticles(outDir) {
  try {
    return articlesFromMeta(readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function maxKnown(...values) {
  const known = values.filter((v) => v != null);
  return known.length ? Math.max(...known) : null;
}

/**
 * Decide se `novo` artigos podem sobrescrever o snapshot de `outDir`. LANÇA SnapshotShrinkError
 * quando o guard bloqueia — chame ANTES de qualquer escrita.
 *
 * @param {object} o
 * @param {string} o.outDir       destino do snapshot (de onde saem os baselines)
 * @param {number} o.novo         total de artigos do snapshot recém-montado
 * @param {number|null} [o.live]  total servido pelo site no ar (o chamador é quem tem a rede)
 * @param {boolean|string} [o.allowShrink] opt-in: true = encolher; 'wipe' = perda catastrófica
 * @returns {object} o veredito (allow) — `.override` = true quando só passou pelo opt-in
 */
export function assertSnapshotAllowed({ outDir, novo, live = null, allowShrink = false }) {
  const head = maxKnown(publishedHighWater(outDir), localMetaArticles(outDir));
  const verdict = evaluateSnapshotChange({ novo, head, live, allowShrink });
  if (!verdict.ok) throw new SnapshotShrinkError(verdict);
  // Único caminho que perde acervo DE PROPÓSITO: berra, com o número que vai sumir.
  if (verdict.override) {
    const optIn = verdict.reason === 'override-wipe' ? WIPE_OPT_IN : SHRINK_OPT_IN;
    warn(`GUARD DO SNAPSHOT IGNORADO (${optIn}) — ${verdict.message}`);
  }
  // Única concessão fail-open do guard (nada publicado com que comparar). Publicar um snapshot
  // VAZIO por aqui é indistinguível do 1º export legítimo — e é o que sai quando o git não pôde ser
  // lido E o outDir sumiu E não veio `live`. Passa, mas nunca calado.
  if (verdict.reason === 'no-baseline' && verdict.counts.novo === 0) {
    warn(`export web: snapshot VAZIO (0 artigos) publicado SEM baseline p/ comparar — ${verdict.message}`);
  }
  return verdict;
}

// ---- teto do articles.json + escrita atômica ----

// Teto DURO do articles.json (MB), irmão do PART_HARD_CAP_MB das partes de contents: o GitHub
// rejeita blobs > 100 MB (GH001) e este arquivo é COMMITADO a cada deploy. As partes têm um alvo
// que as fatia sozinhas; o articles.json é UM arquivo só — ele não se fatia, então o único guard
// possível é fail-closed: acima do teto o export FALHA com a saída acionável, em vez de produzir um
// push que o GitHub recusa (ou, pior, um snapshot que ninguém consegue mais publicar). Referência
// do acervo real: 13.758 artigos ≈ 26 MB, ~1,9 KB/artigo — o teto dá folga p/ ~48 mil artigos.
const ARTICLES_HARD_CAP_MB = 95;

function assertArticlesFileFits(json, n) {
  const size = Buffer.byteLength(json || '');
  const cap = ARTICLES_HARD_CAP_MB * 1024 * 1024;
  if (size <= cap) return;
  throw new Error(
    `export web: articles.json ficou com ${(size / 1024 / 1024).toFixed(1)} MB (${n} artigos) — ` +
      `acima do teto duro de ${ARTICLES_HARD_CAP_MB} MB; o GitHub rejeitaria o push (GH001, blob > 100 MB). ` +
      `Saídas: FATIE o articles.json em partes (mesmo padrão de contents.partN.json + meta.contentsParts) ` +
      `ou reduza os campos por artigo — nenhum dos dois pode ser feito em tempo de export.`,
  );
}

// Escreve cada arquivo num temporário do PRÓPRIO outDir e só então promove por rename (atômico no
// mesmo filesystem). Promove na ORDEM recebida — o chamador põe o meta.json por último. Falhou no
// meio: os temporários são removidos e a exceção sobe; a árvore fica com o snapshot anterior nos
// arquivos ainda não promovidos e, principalmente, com o meta.json ANTIGO (baseline íntegro).
function writeAtomically(outDir, rendered) {
  const temps = rendered.map(([name]) => [
    path.join(outDir, `.${name}.tmp-${process.pid}`),
    path.join(outDir, name),
  ]);
  let promovidos = 0;
  try {
    rendered.forEach(([, json], i) => writeFileSync(temps[i][0], json));
    for (; promovidos < temps.length; promovidos += 1) {
      renameSync(temps[promovidos][0], temps[promovidos][1]);
    }
  } finally {
    // Todo temporário AINDA NÃO promovido some — inclusive o que acabou de falhar: nada de lixo
    // `.articles.json.tmp-123` no dir que o deploy commita.
    for (const [tmp] of temps.slice(promovidos)) rmSync(tmp, { force: true });
  }
}

/**
 * Escreve meta/articles.json/contents.partN.json em `outDir`. Retorna { articles, bytes, parts,
 * guard }. Passa pelo guard anti-encolhimento ANTES de escrever qualquer byte: bloqueado, LANÇA
 * SnapshotShrinkError (`.message`/`.hint`/`.verdict`) e o `outDir` fica INTACTO.
 *
 * @param {object} o
 * @param {string} o.outDir
 * @param {number} [o.partMb]     alvo de bytes por contents.partN.json
 * @param {boolean|string} [o.allowShrink] opt-in explícito p/ publicar um snapshot MENOR
 *                                         (`--allow-shrink`; 'wipe' p/ a perda catastrófica)
 * @param {number|null} [o.live]  artigos servidos pelo site no ar, quando o chamador souber
 */
export function exportWebSnapshot({ outDir, partMb, allowShrink = false, live = null } = {}) {
  // O snapshot inteiro nasce em MEMÓRIA: o guard decide antes da 1ª escrita (bloquear depois
  // deixaria os JSONs já esvaziados na árvore — ver o cabeçalho do módulo).
  const { meta, articles, contentsParts } = buildWebSnapshot({ partMb });
  const guard = assertSnapshotAllowed({ outDir, novo: meta.totals.articles, live, allowShrink });
  mkdirSync(outDir, { recursive: true });
  // Indent de 1: um campo por linha (diff de git legível); o gzip/brotli do deploy anula o custo.
  // ORDEM DA PROMOÇÃO: partes → articles.json → meta.json POR ÚLTIMO (ver o cabeçalho: o meta é o
  // baseline do guard; promovê-lo antes do corpo envenenaria o high-water numa escrita interrompida).
  const files = [
    ...contentsParts.map((p) => [p.file, p.map]),
    ['articles.json', articles],
    ['meta.json', meta],
  ];
  const rendered = files.map(([name, data]) => [name, JSON.stringify(data, null, 1) + '\n']);
  const bytes = rendered.reduce((n, [, json]) => n + Buffer.byteLength(json), 0);
  assertArticlesFileFits(rendered.find(([name]) => name === 'articles.json')?.[1], articles.length);
  writeAtomically(outDir, rendered);
  // O contents.json ÚNICO (90-100+ MB no acervo cheio) NUNCA pode sobrar: se o export o
  // regenerasse, o hook/deploy o commitariam e o GitHub rejeitaria o push (GH001, > 100 MB).
  // Remove qualquer resíduo (inclusive o rastreado: o diff vira remoção e sai do repo no commit).
  // Depois da promoção: um export que falhou no meio não pode ter apagado nada de quebra.
  rmSync(path.join(outDir, 'contents.json'), { force: true });
  const parts = contentsParts.map(({ file, from, to }) => ({ file, from, to }));
  const contentsLabel = parts.length
    ? `contents.part0.json${parts.length > 1 ? `…part${parts.length - 1}.json` : ''}`
    : 'contents (0 partes)';
  log(
    `export web: ${articles.length} artigos → ${outDir} ` +
      `(meta/articles.json/${contentsLabel}, ${(bytes / 1024 / 1024).toFixed(2)} MB brutos)`,
  );
  return { articles: articles.length, bytes, parts, guard };
}
