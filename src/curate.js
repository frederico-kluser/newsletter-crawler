// Curadoria por IA de uma issue/roundup de agregador: a página é convertida p/ markdown
// (Readability, já sem nav/rodapé), dividida em chunks processados por agentes Flash EM
// PARALELO, e cada ITEM curado ({url,title,kind,section,blurb}) é CADASTRADO já aqui — com o
// blurb do próprio agregador como conteúdo inicial. O fetch do alvo vira ENRIQUECIMENTO
// (needs_enrich=1): se o alvo for raso/bloqueado (ferramentas!), a informação não se perde.
import { db, stmts } from './db.js';
import {
  extractArticleAsync, htmlToMarkdown, pruneForLLM, extractPublishedDate, cpuParse, capHtml,
  linksInHtml,
} from './clean.js';
import { curateRoundupItems, curateLeftoverLinks } from './llm.js';
import { logEvent } from './events.js';
import { normalizeUrl, hostOf, parseDate, sha256, warn, debug } from './util.js';
import { CURATE_CHUNK_CHARS } from './config.js';

// Backstop DETERMINÍSTICO de patrocínio/vaga: o rótulo do LLM é clampado p/ 'news' quando
// desconhecido (fail-open p/ salvar), então marcas explícitas de anúncio pago forçam o kind
// aqui — um sponsor nunca vira "notícia" por deslize do modelo.
const SPONSOR_RE = /\bsponsor(?:ed|ship)?\b|\bpatrocin|\bpublieditorial\b/i;
const JOB_RE = /\bclassifieds?\b|\bhiring\b|\bvaga(s)?\b|\bjob board\b/i;
const SAVED_KINDS = new Set(['news', 'tool', 'release']);
// Âncoras genéricas que denunciam link SECUNDÁRIO (vive dentro do blurb de outro item).
const GENERIC_ANCHOR_RE =
  /^(demo\.?|release notes?\.?|changelog|docs?|documentation|more info\.?|info|here|link|website|homepage|github|announcement|blog|details)$/i;

/** Item recuperado pelo passe de cobertura só entra com blurb real e título não-genérico. */
export function isRealRecoveredItem(it) {
  const title = (it.title || '').trim();
  const blurb = (it.blurb || '').trim();
  if (GENERIC_ANCHOR_RE.test(title)) return false;
  return blurb.length >= 30 && title.length >= 6;
}

/** Divide o markdown em chunks de até `max` chars SEM cortar um item (quebra em linha vazia). */
export function chunkMarkdown(md, max = CURATE_CHUNK_CHARS) {
  const text = String(md || '').trim();
  if (text.length <= max) return text ? [text] : [];
  const blocks = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const b of blocks) {
    const candidate = cur ? `${cur}\n\n${b}` : b;
    if (candidate.length > max && cur) {
      chunks.push(cur);
      cur = b.length > max ? b.slice(0, max) : b; // bloco patológico maior que o chunk: trunca
    } else {
      cur = candidate.length > max ? candidate.slice(0, max) : candidate;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Palavras que denunciam um RÓTULO DE SEÇÃO de newsletter (linha curta, com/sem emoji/negrito).
const SECTION_WORDS =
  /\b(in brief|code (?:&|and) tools|tools|releases?|news|elsewhere|classifieds?|jobs?|community|quick (?:bytes|hits|links)|in other news|from (?:our )?sponsor|opinion|tutorials?|articles?)\b/i;

/** O título de seção desta linha (heading markdown / negrito / rótulo curto conhecido) ou null. */
export function sectionTitleOf(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 60) return null;
  // Linha com URL/link markdown é um ITEM, nunca um rótulo de seção — sem este guard, um
  // heading de item ("## [Deno 2.9](url)") virava "seção" e fatiava o item p/ fora do contexto.
  if (/https?:|\]\(/i.test(s)) return null;
  let m = s.match(/^#{1,6}\s+(.+?)\s*#*$/); // heading ATX (## Code & Tools)
  if (m) return m[1].replace(/\*\*/g, '').trim();
  m = s.match(/^\*\*(.{2,48}?):?\*\*$/); // linha só com negrito (**IN BRIEF:**)
  if (m) return m[1].trim();
  // "🛠 Code & Tools" solto: tira markdown, emoji/símbolo à esquerda e ':' à direita.
  const stripped = s
    .replace(/[*_>#`]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[:\s]+$/, '')
    .trim();
  // Terminou como frase ([.!?]) é prosa ("More news next week."), não rótulo de seção.
  if (/[.!?…]$/.test(stripped)) return null;
  if (stripped.length >= 2 && stripped.length <= 40 && SECTION_WORDS.test(stripped)) {
    return stripped;
  }
  return null;
}

/**
 * Divide a edição SEMPRE por SEÇÃO (News/Tools/Releases/IN BRIEF…), 1 fatia por seção — assim
 * há paralelismo intra-edição mesmo em issue pequena, e cada agente recebe um hint do tipo de
 * conteúdo. O conteúdo ANTES da 1ª seção (destaques do topo, sem heading) é uma fatia "intro".
 * Sem seções detectáveis (< 2), cai p/ chunk por tamanho. Seção maior que o teto é sub-chunkada.
 * Retorna [{section, text}]. MAX_SECTIONS evita um flood patológico de micro-agentes.
 */
const MAX_SECTIONS = 12;
export function splitIntoSections(md, { maxChars = CURATE_CHUNK_CHARS } = {}) {
  const text = String(md || '').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const title = sectionTitleOf(lines[i]);
    if (title) marks.push({ idx: i, title });
  }
  if (marks.length < 2 || marks.length > MAX_SECTIONS) {
    return chunkMarkdown(text, maxChars).map((c) => ({ section: null, text: c }));
  }
  const out = [];
  const push = (section, body) => {
    const b = body.trim();
    if (b.length < 20) return;
    if (b.length > maxChars) for (const c of chunkMarkdown(b, maxChars)) out.push({ section, text: c });
    else out.push({ section, text: b });
  };
  if (marks[0].idx > 0) push(null, lines.slice(0, marks[0].idx).join('\n')); // intro (destaques)
  for (let m = 0; m < marks.length; m++) {
    const end = m + 1 < marks.length ? marks[m + 1].idx : lines.length;
    push(marks[m].title, lines.slice(marks[m].idx, end).join('\n'));
  }
  return out.length ? out : chunkMarkdown(text, maxChars).map((c) => ({ section: null, text: c }));
}

/**
 * Consolida a saída dos chunks: normaliza/absolutiza URLs, descarta links internos do próprio
 * agregador (nav/self), aplica o backstop de sponsor/job e deduplica por URL canônica.
 * Puro/testável. Retorna { items, skipped, issueDateRaw }.
 */
export function consolidateItems(results, { baseUrl }) {
  const host = hostOf(baseUrl);
  const seen = new Map();
  const skipped = { sponsor: 0, job: 0, other: 0, internal: 0, invalid: 0 };
  let issueDateRaw = null;

  for (const r of results) {
    if (!issueDateRaw && parseDate(r?.issue_date)) issueDateRaw = String(r.issue_date).trim();
    for (const it of r?.items || []) {
      const abs = normalizeUrl(it.url, baseUrl);
      if (!abs || !/^https?:/i.test(abs)) {
        skipped.invalid++;
        continue;
      }
      if (hostOf(abs) === host) {
        skipped.internal++; // link interno da própria newsletter (nav, edição anterior…)
        continue;
      }
      let kind = it.kind;
      const hay = `${it.title || ''} ${it.section || ''} ${it.blurb || ''}`;
      if (SPONSOR_RE.test(hay)) kind = 'sponsor';
      else if (kind !== 'job' && JOB_RE.test(it.section || '')) kind = 'job';
      if (!SAVED_KINDS.has(kind)) {
        skipped[kind] = (skipped[kind] || 0) + 1;
        continue;
      }
      if (!seen.has(abs)) {
        seen.set(abs, {
          url: abs,
          title: String(it.title || '').replace(/\s+/g, ' ').trim(),
          kind,
          section: it.section ? String(it.section).replace(/\s+/g, ' ').trim() : null,
          blurb: it.blurb ? String(it.blurb).replace(/\s+/g, ' ').trim() : null,
        });
      }
    }
  }
  return { items: [...seen.values()], skipped, issueDateRaw };
}

/**
 * Curadoria completa de uma issue: chunks -> agentes paralelos -> consolidação -> cadastro +
 * enfileiramento do enriquecimento. Retorna um resumo, {belowFloor:true} quando a issue é
 * anterior ao piso --since, ou null p/ o chamador cair no fluxo antigo (página sem corpo).
 */
export async function curateRoundup({ html, url, source, runId = null, depth = 0, sinceDate = null }) {
  const ev = { runId, sourceId: source?.id ?? null, url };
  const capped = capHtml(html);
  const art = await extractArticleAsync(capped, url); // JSDOM no pool de workers
  const md = art?.content
    ? htmlToMarkdown(art.content)
    : await cpuParse(() => pruneForLLM(capped));
  if (!md || md.trim().length < 200) return null; // sem corpo curável: fluxo antigo decide

  // Por SEÇÃO em PARALELO: 1 agente por seção (News/Tools/Releases/…) — mais paralelismo intra-
  // edição e um hint especializado por agente. A lane llm do governador admite quantos couberem.
  const sections = splitIntoSections(md);
  const settled = await Promise.allSettled(
    sections.map((sec, i) =>
      curateRoundupItems({
        markdown: sec.text,
        baseUrl: url,
        section: sec.section,
        part: sections.length > 1 ? `${i + 1}/${sections.length}` : null,
      }),
    ),
  );
  const results = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(s.value);
    else if (s.reason?.code === 'BUDGET_EXCEEDED') throw s.reason; // job volta a pending
    else warn(`curadoria: seção falhou (${url}): ${s.reason?.message}`);
  }
  if (!results.length) return null; // todas as seções falharam: fluxo antigo

  const { items, skipped, issueDateRaw } = consolidateItems(results, { baseUrl: url });

  // Cobertura determinística (recall do curador não é garantido): links externos do CORPO que
  // nenhum item emitido cobriu viram um passe extra — um agente decide o que é item real que
  // FALTOU vs link secundário/patrocínio. Pega omissões como itens "do meio" pulados pelo LLM.
  const emitted = new Set();
  for (const r of results) {
    for (const it of r?.items || []) {
      const abs = normalizeUrl(it.url, url);
      if (abs) emitted.add(abs);
    }
  }
  // IMPORTANTE: o diff usa o HTML BRUTO da página, não o corpo do Readability — o Readability
  // às vezes DESCARTA blocos reais vizinhos de anúncio (observado ao vivo: 3 destaques da
  // issue sumiam do corpo e, por isso, nem apareciam como leftovers). Links de rodapé/social
  // externos que entram aqui são classificados como secundários pelo agente + pós-filtro.
  const leftovers = [];
  {
    const host = hostOf(url);
    const seenBody = new Set();
    const bodyLinks = await cpuParse(() => linksInHtml(capped, url)); // cheerio: cede o loop
    for (const l of bodyLinks) {
      const abs = normalizeUrl(l.url, url);
      if (!abs || !/^https?:/i.test(abs) || hostOf(abs) === host) continue;
      if (seenBody.has(abs) || emitted.has(abs)) continue;
      seenBody.add(abs);
      leftovers.push({ url: abs, anchor: (l.title || '').trim() });
    }
  }
  let recovered = 0;
  const coverage = { recoveredUrls: [], filteredUrls: [], otherUrls: [] };
  if (leftovers.length && leftovers.length <= 40) {
    try {
      // Contexto do passe = HTML PODADO da página INTEIRA (não o corpo Readability): os blocos
      // que o Readability descartou — exatamente os dos itens omitidos — precisam estar visíveis,
      // senão o agente conclui "secundário" por não achar o bloco do link.
      const pageContext = await cpuParse(() => pruneForLLM(capped));
      const extra = await curateLeftoverLinks({
        pageContext: pageContext.slice(0, CURATE_CHUNK_CHARS), baseUrl: url, leftovers,
      });
      const cons2 = consolidateItems([{ issue_date: null, items: extra.items }], { baseUrl: url });
      const realUrls = new Set(cons2.items.map((i) => i.url));
      for (const l of leftovers) if (!realUrls.has(l.url)) coverage.otherUrls.push(l.url);
      for (const it of cons2.items) {
        // Régua determinística do passe de cobertura: item REAL recuperado tem o comentário do
        // agregador (blurb) e título próprio — âncora genérica ("Demo.", "Release notes") ou
        // sem blurb é link secundário promovido indevidamente pelo agente -> fora.
        if (!isRealRecoveredItem(it)) {
          skipped.other = (skipped.other || 0) + 1;
          coverage.filteredUrls.push(it.url);
          continue;
        }
        if (!items.some((x) => x.url === it.url)) {
          items.push(it);
          recovered++;
          coverage.recoveredUrls.push(it.url);
        }
      }
      for (const [k, n] of Object.entries(cons2.skipped)) {
        if (k !== 'internal' && k !== 'invalid') skipped[k] = (skipped[k] || 0) + n;
      }
    } catch (e) {
      if (e?.code === 'BUDGET_EXCEEDED') throw e;
      warn(`passe de cobertura falhou (${url}): ${e.message} — seguindo com os itens do 1º passe`);
    }
  }
  // Trace auditável do funil de cobertura: QUAIS urls ficaram de fora e o veredito de cada um
  // (recuperado | filtrado pela régua | secundário) — sem isso uma omissão é indiagnosticável.
  logEvent({
    ...ev, stage: 'curate', status: 'coverage',
    detail: {
      bodyLinks: emitted.size + leftovers.length,
      leftovers: leftovers.map((l) => l.url),
      recovered: coverage.recoveredUrls,
      filtered: coverage.filteredUrls,
      secondary: coverage.otherUrls,
    },
  });

  // Data da issue: curadoria -> metadados da página. É a âncora temporal dos itens (um item
  // curado pertence à SEMANA da issue, mesmo que o alvo tenha data própria mais antiga).
  const issueDate = issueDateRaw || extractPublishedDate(capped);
  const d = parseDate(issueDate);
  if (sinceDate && d && d < sinceDate) {
    logEvent({ ...ev, stage: 'curate', status: 'skip', detail: { reason: 'below-since', issueDate } });
    return { belowFloor: true, issueDate };
  }

  const byKind = { news: 0, tool: 0, release: 0 };
  let saved = 0;
  let dup = 0;
  let enqueued = 0;
  // Escritas em LOTE: cadastro de todos os itens + enfileiramentos numa ÚNICA transação (o loop
  // é síncrono; better-sqlite3 exige transação síncrona). Corta o fsync por item. logEvent aqui
  // só empilha no buffer (não escreve), então é seguro dentro da transação.
  const applyItems = db.transaction(() => {
    for (const it of items) {
      // Conteúdo inicial = título + blurb DO AGREGADOR (fica como registro definitivo se o alvo
      // for raso/bloqueado). Título no hash: releases recorrentes repetem o blurb entre semanas.
      const content = it.blurb ? `${it.title} — ${it.blurb}` : it.title;
      const res = stmts.insertArticle.run({
        source_id: source?.id ?? null,
        url: it.url,
        title: it.title,
        content,
        content_hash: sha256(content),
        published_at: issueDate || null,
        run_id: runId,
        kind: it.kind,
        issue_url: url,
        section: it.section,
        blurb: it.blurb,
        content_source: 'aggregator',
        cleaned: 0,
        needs_enrich: 1,
      });
      if (res.changes > 0) {
        saved++;
        byKind[it.kind] = (byKind[it.kind] || 0) + 1;
        logEvent({
          ...ev, url: it.url,
          stage: 'item', status: 'saved',
          detail: { kind: it.kind, section: it.section, title: it.title, issue: url },
        });
      } else {
        dup++;
        logEvent({ ...ev, url: it.url, stage: 'item', status: 'dup', detail: { issue: url } });
        // Registro antigo ainda sem corpo (run anterior falhou)? Re-ativa o job de enriquecimento.
        const prev = stmts.getArticleFullByUrl.get(it.url);
        if (prev?.needs_enrich) stmts.requeueUrl.run(it.url);
        else continue; // já completo: nem re-enfileira
      }
      if (stmts.enqueue.run(it.url, 'article', url, source?.id ?? null, depth + 1).changes > 0) enqueued++;
    }
  });
  applyItems();
  for (const [k, n] of Object.entries(skipped)) {
    if (n > 0) logEvent({ ...ev, stage: 'item', status: 'skipped', detail: { kind: k, count: n, issue: url } });
  }

  const summary = {
    itemsTotal: items.length, saved, dup, enqueued, byKind, skipped, recovered,
    sections: sections.length, sectionNames: sections.map((s) => s.section).filter(Boolean),
    issueDate: issueDate || null,
  };
  logEvent({ ...ev, stage: 'curate', status: 'ok', detail: summary });
  debug(`curadoria ${url}: ${JSON.stringify(summary)}`);
  return summary;
}
