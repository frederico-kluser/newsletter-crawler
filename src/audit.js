// AUDIT — modo debug de TUDO o que a coleta perde, pula e erra (`ncrawl audit`), sem LLM.
//
// O `ncrawl inspect` audita UMA run (o que aconteceu com cada issue dela); este módulo responde à
// pergunta maior — "o que estamos a perder/errar?" — em três eixos:
//   1. FONTES: cada newsletter cadastrada × semeada × coletada (as que nunca entram numa run, as
//      que estão mudas há semanas, as picos de data suspeitos);
//   2. DESCOBERTA × SALVAMENTO: cada link visto na listagem virou artigo, foi pulado por já
//      conhecido (o "estamos pulando as que já pegamos?"), caiu abaixo do piso, ou foi suprimido
//      por colisão de conteúdo (PERDA real — URL nova sem linha em articles);
//   3. ERROS: falhas de fetch classificadas (alvo morto × bloqueio × transitório), jobs falhados/
//      estourados, kept-blurb por motivo, pendências de fila e alvos que re-falham toda run.
//
// Camada PURO + camada de leitura: as regras de decisão (`classifyFetchError`, `dupBreakdown`,
// `detectDateSpikes`, `listingSkipTotals`, `sourceFlags`) são puras e testáveis sem DB/rede;
// `buildAuditReport` só lê (stmts) e `renderAudit` só formata. Nada escreve — o audit é 100% LEITURA.
import { loadSources } from './config.js';
import { stmts } from './db.js';
import { hostOf, normalizeUrl, parseDate } from './util.js';

// ---- regras puras (decisão) -------------------------------------------------

/**
 * Classifica uma mensagem de falha de fetch. `dead-target` = o alvo NÃO existe mais para a rede
 * (DNS não resolve, conexão recusada, rede inalcançável) — re-tentar no MESMO run é inútil e o
 * fallback para Playwright também (usa o mesmo resolver/socket); a próxima run ainda o tenta
 * (a política ENRICH_MAX_ATTEMPTS=0 desta máquina nunca aposenta itens).
 * `blocked` = anti-bot/403/página de desafio; `timeout` = lento demais; `http` = erro HTTP;
 * `other` = o resto (parse, abort, etc.).
 */
export function classifyFetchError(msg) {
  const m = String(msg || '');
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN|ECONNREFUSED|ERR_CONNECTION_REFUSED|ENETUNREACH|ERR_ADDRESS_UNREACHABLE/i.test(m)) {
    return 'dead-target';
  }
  if (/ERR_SSL_PROTOCOL_ERROR|EPROTO.*alert|CERT_|ERR_CERT/i.test(m)) return 'dead-target';
  if (/ERR_TIMED_OUT|ETIMEDOUT|timeout|deadline|JOB_TIMEOUT/i.test(m)) return 'timeout';
  if (/status code 40[13]|ERR_TUNNEL|captcha|cloudflare|challenge|blocked/i.test(m)) return 'blocked';
  if (/status code \d{3}/i.test(m)) return 'http';
  return 'other';
}

/**
 * Separa os `item|dup` em supressões CORRETAS (a URL já tem linha em articles — já pegámos)
 * de PERDAS por colisão de content_hash (URL nova suprimida porque o conteúdo já existia).
 * Linha esperada: { url, by, twin, known_url }. `by` só existe em eventos da curadoria nova;
 * o evento legado é resolvido pelo `known_url`.
 */
export function dupBreakdown(rows) {
  const out = { byUrl: 0, byHash: 0, legacy: 0, losses: [] };
  for (const r of rows || []) {
    const known = r.known_url === 1 || r.known_url === true;
    const by = r.by === 'url' || r.by === 'hash' ? r.by : known ? 'url' : null;
    if (by === 'url') out.byUrl++;
    else if (by === 'hash') {
      out.byHash++;
      out.losses.push({ url: r.url, twin: r.twin || null, issue: r.issue || null, runId: r.run_id ?? null });
    } else if (known) out.byUrl++;
    else {
      out.legacy++;
      out.losses.push({ url: r.url, twin: r.twin || null, issue: r.issue || null, runId: r.run_id ?? null });
    }
  }
  return out;
}

/**
 * Passe de listagem (evento archive/ok): links vistos = novos + abaixo do piso + PULADOS por já
 * conhecidos. É a prova do "estamos pulando as que já pegamos" — o pulado aqui NÃO é perda.
 */
export function listingSkipTotals(rows) {
  const byListing = new Map();
  const total = { links: 0, novos: 0, abaixo: 0, known: 0, passes: 0 };
  for (const r of rows || []) {
    const links = Number(r.links) || 0;
    const novos = Number(r.novos) || 0;
    const abaixo = Number(r.abaixo) || 0;
    const known = Math.max(0, links - novos - abaixo);
    const key = r.url || '(sem url)';
    const cur = byListing.get(key) || { url: key, links: 0, novos: 0, abaixo: 0, known: 0, passes: 0 };
    cur.links += links;
    cur.novos += novos;
    cur.abaixo += abaixo;
    cur.known += known;
    cur.passes += 1;
    byListing.set(key, cur);
    total.links += links;
    total.novos += novos;
    total.abaixo += abaixo;
    total.known += known;
    total.passes += 1;
  }
  return { total, byListing: [...byListing.values()].sort((a, b) => b.links - a.links) };
}

/**
 * Picos de data por fonte: um dia com contagem desproporcional ao dia "normal" da fonte é a
 * assinatura clássica de data de CAPTURA no lugar da data real (medido: 4.417 artigos Golang
 * Weekly com published_at=2026-08-30 — o dia da captura bulk). `rows`: [{source_id, d, c}].
 */
export function detectDateSpikes(rows, { minCount = 50, ratio = 3 } = {}) {
  const bySource = new Map();
  for (const r of rows || []) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id).push(r);
  }
  const spikes = [];
  for (const [sourceId, list] of bySource) {
    const counts = list.map((r) => Number(r.c) || 0).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const threshold = Math.max(minCount, median * ratio);
    for (const r of list) {
      if ((Number(r.c) || 0) >= threshold && (Number(r.c) || 0) > median) {
        spikes.push({ sourceId, date: r.d, count: Number(r.c), median, threshold });
      }
    }
  }
  return spikes.sort((a, b) => b.count - a.count);
}

/**
 * Flags de saúde de UMA fonte — o diagnóstico por newsletter que o relatório mostra.
 * `row` = linha de auditSourceStats; `configEntry` = entrada do sources.json (ou undefined).
 */
export function sourceFlags(row, { configEntry = undefined, now = new Date(), silentDays = 7 } = {}) {
  const flags = [];
  if (!row.base_url) flags.push('SEM base_url (restaurada só pelo nome — nunca semeada)');
  if (!configEntry) flags.push('FORA do sources.json (não entra em nenhuma run)');
  else if (row.base_url && normalizeUrl(configEntry.url) !== normalizeUrl(row.base_url)) {
    flags.push(`URL divergente do sources.json (${configEntry.url})`);
  }
  if (!row.cursor_date) flags.push('sem cursor de captura');
  if (!row.articles) flags.push('ZERO artigos');
  if (row.last_date) {
    const last = parseDate(row.last_date);
    const days = last ? Math.floor((now - last) / 86400000) : null;
    if (days != null && days > silentDays) flags.push(`muda há ${days} dias (último item ${row.last_date})`);
  }
  if (row.needs_enrich > 0) flags.push(`${row.needs_enrich} item(ns) só-blurb a enriquecer`);
  if (row.thin > 0) flags.push(`${row.thin} item(ns) com corpo fino (<200 chars)`);
  return flags;
}

// ---- leitura (DB) + formatação ----------------------------------------------

function pct(n, total) {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '—';
}

/** Relatório estruturado (dado puro p/ a UI/testes); nada é impresso aqui. */
export function buildAuditReport({ runId = null, source = null, now = new Date() } = {}) {
  const cfg = loadSources();
  const cfgByKey = new Map();
  for (const s of cfg) {
    cfgByKey.set(normalizeUrl(s.url) || s.url, s);
    if (s.name) cfgByKey.set(String(s.name).toLowerCase(), s);
  }
  const configEntryFor = (row) =>
    cfgByKey.get(normalizeUrl(row.base_url) || row.base_url || '') ||
    cfgByKey.get(String(row.name || '').toLowerCase());

  const match = (row) =>
    !source ||
    `${row.name || row.source_name || ''} ${row.base_url || ''}`.toLowerCase().includes(String(source).toLowerCase());

  const sourceStats = stmts.auditSourceStats.all().filter(match);
  const sourceIds = new Set(sourceStats.map((r) => r.id));
  const months = stmts.auditMonthCounts.all();
  const weeks = stmts.auditWeekCounts.all();
  const dateCounts = stmts.auditDateCounts.all().filter((r) => sourceIds.has(r.source_id));

  const sources = sourceStats.map((row) => {
    const configEntry = configEntryFor(row);
    return {
      id: row.id,
      name: row.name || '(sem nome)',
      baseUrl: row.base_url || null,
      type: row.type,
      cursor: row.cursor_date || null,
      seeded: Boolean(configEntry),
      articles: row.articles,
      lastDate: row.last_date || null,
      needsEnrich: row.needs_enrich,
      noVerify: row.no_verify,
      noSummary: row.no_summary,
      noDate: row.no_date,
      thin: row.thin,
      months: months.filter((m) => m.source_id === row.id).map(({ ym, c }) => ({ ym, c })),
      weeks: weeks.filter((w) => w.source_id === row.id).map(({ wk, c }) => ({ wk, c })),
      flags: sourceFlags(row, { configEntry, now }),
    };
  });

  // Descoberta × salvamento (todas as runs ou a pedida).
  const reasons = stmts.auditEventsByReason.all({ runId });
  const pick = (stage, status) =>
    reasons.filter((r) => r.stage === stage && r.status === status).map((r) => ({ reason: r.reason || '(sem motivo)', n: r.n, events: r.events }));

  const dupRows = stmts.auditDupEvents.all({ runId });
  const dup = dupBreakdown(dupRows);
  const skips = listingSkipTotals(stmts.auditArchivePasses.all({ runId }));

  const fetchFails = stmts.auditFetchFails.all({ runId }).map((r) => {
    let detail = {};
    try {
      detail = JSON.parse(r.detail || '{}');
    } catch {
      detail = {};
    }
    return {
      url: r.url,
      runId: r.run_id,
      at: r.created_at,
      error: String(detail.error || '').split('\n')[0],
      class: classifyFetchError(detail.error),
    };
  });
  const fetchByClass = {};
  const fetchByUrl = new Map();
  for (const f of fetchFails) {
    fetchByClass[f.class] = (fetchByClass[f.class] || 0) + 1;
    const host = hostOf(f.url) || f.url;
    const cur = fetchByUrl.get(f.url) || { url: f.url, host, count: 0, classes: {}, lastError: '' };
    cur.count++;
    cur.classes[f.class] = (cur.classes[f.class] || 0) + 1;
    cur.lastError = f.error;
    fetchByUrl.set(f.url, cur);
  }
  const deadTargets = [...fetchByUrl.values()]
    .filter((u) => u.classes['dead-target'])
    .sort((a, b) => b.count - a.count);

  const frontierFailed = stmts.auditFrontierFailed.all().filter((r) => match(r));
  const blurbPending = stmts.auditBlurbPending.all({ lim: 200 }).filter((r) => match(r));

  const spikes = detectDateSpikes(dateCounts).map((s) => ({
    ...s,
    source: sourceStats.find((r) => r.id === s.sourceId)?.name || `#${s.sourceId}`,
  })).filter((s) => match({ name: s.source, base_url: '' }));

  return {
    generatedAt: now.toISOString(),
    runId,
    sources,
    drift: {
      notSeeded: sources.filter((s) => !s.seeded).map((s) => s.name),
      notInDb: cfg.filter((c) => !sourceStats.some((r) => normalizeUrl(r.base_url) === normalizeUrl(c.url))).map((c) => c.name || c.url),
    },
    discovery: {
      saved: pick('item', 'saved'),
      dup,
      skipped: pick('item', 'skipped'),
      belowSince: pick('curate', 'skip').filter((r) => r.reason === 'below-since'),
      listingSkips: skips,
    },
    errors: {
      fetchByClass,
      fetchFails: fetchFails.length,
      fetchByUrl: [...fetchByUrl.values()].sort((a, b) => b.count - a.count),
      deadTargets,
      jobTimeouts: pick('job', 'timeout'),
      articleSkips: pick('article', 'skip'),
      keptBlurb: pick('enrich', 'kept-blurb'),
      cleanRejects: pick('clean', 'reject'),
      roundupFails: reasons.filter((r) => r.stage === 'roundup' && r.status === 'fail'),
    },
    queue: {
      jobs: stmts.auditJobsByKindState.all(),
      failed: frontierFailed,
      blurbPending,
    },
    anomalies: {
      dateSpikes: spikes,
      hashLosses: dup.losses,
    },
  };
}

/**
 * Formata o relatório em linhas (`log` imprime). `verbose` lista URLs individuais (perdas,
 * alvos mortos, pendências, picos); sem ele só agregados — cabe num terminal normal.
 */
export function renderAudit(rep, { verbose = false, maxLines = 25 } = {}) {
  const L = [];
  const line = (s = '') => L.push(s);
  line(`— audit (modo debug) — escopo: ${rep.runId ? `run #${rep.runId}` : 'todas as runs'} · gerado ${rep.generatedAt}`);
  line();

  line(`FONTES (${rep.sources.length})`);
  for (const s of rep.sources) {
    line(
      `  ${s.name.padEnd(20)} ${String(s.articles).padStart(6)} artigos · último ${s.lastDate || '—'}` +
        ` · cursor ${s.cursor || '—'} · ${s.type}${s.seeded ? '' : ' · NÃO SEMENTADA'}`,
    );
    for (const f of s.flags) line(`      ⚠ ${f}`);
    if (verbose) {
      const tail = s.months.slice(-6).map((m) => `${m.ym}=${m.c}`).join(' ');
      if (tail) line(`      meses: ${tail}`);
    }
  }
  if (rep.drift.notSeeded.length) {
    line(`  ⚠ sem entrada no sources.json (NUNCA entram numa run): ${rep.drift.notSeeded.join(', ')}`);
    line('    → corrija com: npm run add -- <url> --name "..." --type index|listing');
  }
  if (rep.drift.notInDb.length) line(`  ⚠ no sources.json mas sem linha no banco: ${rep.drift.notInDb.join(', ')}`);
  line();

  const d = rep.discovery;
  const sk = d.listingSkips.total;
  line(`DESCOBERTA × SALVAMENTO${rep.runId ? ` (run #${rep.runId})` : ''}`);
  line(`  listagens: ${sk.passes} passe(s) · ${sk.links} links vistos · ${sk.novos} novos · ${sk.abaixo} abaixo do piso · ${sk.known} pulados (já capturados)`);
  line(`  itens salvos: ${d.saved.reduce((n, r) => n + r.n, 0)}`);
  const dupTotal = d.dup.byUrl + d.dup.byHash + d.dup.legacy;
  line(`  suprimidos (dup): ${dupTotal} — pulados corretamente (já capturados): ${d.dup.byUrl} · conteúdo repetido (perda): ${d.dup.byHash + d.dup.legacy}`);
  if (d.dup.losses.length) {
    line(`  ⚠ PERDIDOS por colisão de content_hash (URL nova sem artigo): ${d.dup.losses.length}`);
    if (verbose) for (const l of d.dup.losses.slice(0, maxLines)) line(`      ${l.url}${l.twin ? ` (conteúdo igual a ${l.twin})` : ''}`);
    else line('      (use --verbose p/ listar as URLs)');
  }
  for (const s of d.skipped) line(`  fora do cadastro (${s.reason}): ${s.n} item(ns) em ${s.events} evento(s)`);
  for (const s of d.belowSince) line(`  curadoria abaixo do piso: ${s.n}`);
  line();

  const e = rep.errors;
  line('ERROS');
  line(`  falhas de fetch: ${e.fetchFails} — ${Object.entries(e.fetchByClass).map(([k, n]) => `${k}=${n}`).join(' · ') || '—'}`);
  if (e.deadTargets.length) {
    line(`  ⚠ alvos MORTOS (não existem mais para a rede — re-tentados toda run): ${e.deadTargets.length}`);
    for (const t of e.deadTargets.slice(0, verbose ? maxLines : 8)) {
      line(`      ${t.host} — ${t.count} falha(s): ${t.lastError.slice(0, 80)}`);
      if (verbose) line(`        ${t.url}`);
    }
  }
  for (const s of e.jobTimeouts) line(`  jobs estourados (deadline): ${s.n}`);
  for (const s of e.articleSkips) line(`  artigo pulado (${s.reason}): ${s.n}`);
  for (const s of e.keptBlurb) line(`  mantido com blurb (${s.reason}): ${s.n}`);
  for (const s of e.cleanRejects) line(`  limpeza IA rejeitada (${s.reason}): ${s.n}`);
  line();

  line('FILA E PENDÊNCIAS');
  line(`  frontier: ${rep.queue.jobs.map((j) => `${j.kind}/${j.state}=${j.c}`).join(' · ')}`);
  if (rep.queue.failed.length) {
    line(`  ⚠ jobs FAILED (abandonados após retries): ${rep.queue.failed.length}`);
    for (const f of rep.queue.failed.slice(0, verbose ? maxLines : 8)) line(`      [${f.kind}] ${f.url}`);
  }
  if (rep.queue.blurbPending.length) {
    line(`  só-blurb a enriquecer (needs_enrich): ${rep.queue.blurbPending.length} exibido(s)`);
    if (verbose) for (const b of rep.queue.blurbPending.slice(0, maxLines)) line(`      ${b.source_name || '—'} · ${b.title || b.url}`);
  }
  line();

  line('ANOMALIAS DE DADO');
  if (rep.anomalies.dateSpikes.length) {
    line(`  ⚠ picos de data (provável data de captura no lugar da data real): ${rep.anomalies.dateSpikes.length}`);
    for (const s of rep.anomalies.dateSpikes.slice(0, verbose ? maxLines : 10)) {
      line(`      ${s.source} ${s.date}: ${s.count} itens (mediana/dia=${s.median}, limiar=${s.threshold})`);
    }
    line('      → reatribuição: node scripts/reattribute-dates.mjs [--dry-run] (por issue) · --target-dates [--date D] (data do alvo; resíduo = alvos mortos/páginas sem data)');
  } else {
    line('  nenhum pico de data suspeito.');
  }
  if (!rep.anomalies.hashLosses.length && !rep.anomalies.dateSpikes.length) line('  nenhuma anomalia relevante.');
  line();
  line('dica: --run N restringe a uma run · --source <nome> a uma fonte · --verbose lista as URLs.');
  return L;
}
