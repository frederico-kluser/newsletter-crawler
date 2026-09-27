// Persistência SQLite (better-sqlite3): schema + prepared statements.
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DB_PATH, EMBED_DIM } from './config.js';
import { parseDate, hostOf, normalizeUrl, sha256, warn } from './util.js';

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Dois processos `ncrawl` podem compartilhar este DB (ex.: crawl + search em terminais
// diferentes). Sem busy_timeout, o segundo escritor falharia na hora com SQLITE_BUSY.
db.pragma('busy_timeout = 5000');

// sqlite-vec (metade DENSA da busca híbrida): carrega a extensão vetorial nesta conexão. Fail-open
// — se não carregar (plataforma sem binário), VEC_OK=false e a busca cai p/ só-léxica (FTS).
export let VEC_OK = false;
try {
  loadVec(db);
  VEC_OK = true;
} catch (e) {
  warn(`sqlite-vec indisponível (${e.message}); busca densa desligada — segue só a léxica (FTS).`);
}

// published_at é string CRUA do scrape (nem sempre ISO — ex.: "June 18, 2026"), e o date() do
// SQLite só entende ISO (senão NULL). iso_date normaliza via o MESMO parseDate do crawler p/
// YYYY-MM-DD, permitindo ordenar e filtrar período em SQL; inparseável -> NULL (cai no fallback).
db.function('iso_date', { deterministic: true }, (s) => {
  const d = parseDate(s);
  return d ? d.toISOString().slice(0, 10) : null;
});

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT,
  base_url TEXT UNIQUE,
  type TEXT DEFAULT 'listing',
  max_index_pages INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  url TEXT UNIQUE,
  html_hash TEXT,
  status TEXT,
  pagination_depth INTEGER DEFAULT 0,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  url TEXT UNIQUE,
  title TEXT,
  content TEXT,
  content_hash TEXT,
  published_at TEXT,
  extracted_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS selectors (
  id INTEGER PRIMARY KEY,
  template_sig TEXT UNIQUE,
  link_selector TEXT,
  link_attribute TEXT,
  content_selector TEXT,
  next_selector TEXT,
  model_used TEXT,
  confidence REAL,
  last_validated TEXT
);

CREATE TABLE IF NOT EXISTS frontier (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE,
  kind TEXT,
  state TEXT DEFAULT 'pending',
  retries INTEGER DEFAULT 0,
  discovered_from TEXT,
  source_id INTEGER,
  depth INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_frontier_state ON frontier(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  command TEXT,
  args TEXT,
  budget_usd REAL,
  new_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS classifications (
  article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  domain_confidence REAL,
  taxonomy_version TEXT,
  model_used TEXT,
  status TEXT DEFAULT 'done',
  classified_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  facet TEXT NOT NULL,
  tag TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (article_id, facet, tag)
);
CREATE INDEX IF NOT EXISTS idx_article_tags_facet_tag ON article_tags(facet, tag);

CREATE TABLE IF NOT EXISTS classification_uncovered (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  facet TEXT,
  term TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  stage TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_run ON llm_usage(run_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  source_id INTEGER,
  url TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_url ON events(url);

CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  origin TEXT,
  query TEXT NOT NULL,
  mode TEXT,
  scope_json TEXT,
  stats_json TEXT,
  hits_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Chave/valor do PRÓPRIO banco (não é acervo: fica fora do DATA_TABLES do backup e do hasAnyData).
-- Hoje guarda só o piso "legado" da migração Jev (jev_floor_run_id — ver LEGACY_FLOOR_KEY).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Log central das DECISÕES do Jev: 1 linha por PERGUNTA decidida (não por chamada — o custo por
-- chamada fica no llm_usage). É o insumo da recalibração offline dos limiares (eval/jev) e do
-- 'inspect --decisions'. Escrito SÓ por events.logDecision, em lote, na MESMA transação do flush
-- dos events. Com JEV_TRACE=min (default) entram os desfechos não-aceitos + uma AMOSTRA
-- determinística dos aceitos; sample_rate guarda a taxa com que a linha entrou (1 = sempre
-- registrada; 0.05 = aceito amostrado) p/ o inspect estimar o total sem mentir: SUM(1/sample_rate).
-- value/fb_value: texto cru quando a resposta é string (choice), JSON nos demais (noul/score/listas).
CREATE TABLE IF NOT EXISTS jev_decisions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  stage TEXT NOT NULL,
  subject TEXT,
  url TEXT,
  qid TEXT NOT NULL,
  value TEXT,
  p REAL,
  certainty REAL,
  threshold REAL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accept', 'fallback', 'default', 'error', 'shadow')),
  reason TEXT,
  fb_value TEXT,
  agree INTEGER,
  model TEXT,
  sample_rate REAL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jev_decisions_run_stage ON jev_decisions(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_jev_decisions_stage_qid ON jev_decisions(stage, qid);
`);

// Migração leve p/ DBs criados antes das colunas multinível (CREATE TABLE IF NOT EXISTS
// não adiciona colunas a tabelas já existentes). Idempotente: só adiciona o que falta.
function ensureColumn(table, column, ddl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('frontier', 'depth', 'depth INTEGER DEFAULT 0');
// Data do item NO MOMENTO do enfileiramento, herdada do PAR da listagem datada (ex.:
// <span class="issue-date">) — a âncora temporal AUTORITATIVA do roundup p/ o piso --since
// e a curadoria (P1 da captura 2026-08-14: 13/15 artigos com a data do ALVO por falta dela).
ensureColumn('frontier', 'discovered_date', 'discovered_date TEXT');
ensureColumn('sources', 'type', "type TEXT DEFAULT 'listing'");
ensureColumn('sources', 'max_index_pages', 'max_index_pages INTEGER');
// Cursor de captura POR FONTE: data do item mais novo já capturado dela. O crawl usa como piso
// (em vez do --since global) e só AVANÇA, após listagem bem-sucedida. `purge` zera (recaptura do
// zero não pode ser pulada pelo cursor). Ver src/cursor.js.
ensureColumn('sources', 'cursor_date', 'cursor_date TEXT');
// Resumo PT-BR p/ leitura (o `content` segue original, p/ busca/tags). Ambos nullable.
ensureColumn('articles', 'title_pt', 'title_pt TEXT');
ensureColumn('articles', 'summary_pt', 'summary_pt TEXT');
// Marca d'água do delta: a execução (run) que DESCOBRIU o artigo. Linhas antigas ficam NULL.
ensureColumn('articles', 'run_id', 'run_id INTEGER');
// Colunas adicionais da tabela runs (unificada: paralel + robot-bypass). DBs antigos podem
// ter só o schema original de um dos branches; ensureColumn garante que todas existam.
ensureColumn('runs', 'command', 'command TEXT');
ensureColumn('runs', 'args', 'args TEXT');
ensureColumn('runs', 'budget_usd', 'budget_usd REAL');
ensureColumn('runs', 'status', "status TEXT DEFAULT 'running'");
ensureColumn('runs', 'new_count', 'new_count INTEGER DEFAULT 0');
// Pipeline de qualidade (curadoria de agregador + limpeza IA + verificação pós-cadastro):
// - kind: news|tool|release (item curado; NULL em linhas antigas/avulsas)
// - issue_url/section/blurb: proveniência e a descrição do PRÓPRIO agregador sobre o item
// - content_source: 'aggregator' (só o blurb) | 'target' (corpo extraído do alvo)
// - needs_enrich: 1 = cadastrado na curadoria, aguardando o corpo do alvo
// - cleaned: 1 = conteúdo passou pela limpeza por IA antes de salvar
// - verify_status/notes: veredito da verificação pós-cadastro (ok|suspect|junk)
ensureColumn('articles', 'kind', 'kind TEXT');
ensureColumn('articles', 'issue_url', 'issue_url TEXT');
ensureColumn('articles', 'section', 'section TEXT');
ensureColumn('articles', 'blurb', 'blurb TEXT');
ensureColumn('articles', 'content_source', 'content_source TEXT');
ensureColumn('articles', 'needs_enrich', 'needs_enrich INTEGER DEFAULT 0');
ensureColumn('articles', 'cleaned', 'cleaned INTEGER DEFAULT 0');
ensureColumn('articles', 'verify_status', 'verify_status TEXT');
ensureColumn('articles', 'verify_notes', 'verify_notes TEXT');
// - enrich_attempts: nº de RODADAS de crawl em que o alvo falhou p/ enriquecer (bump no início
//   do crawl seguinte). Teto ENRICH_MAX_ATTEMPTS: o item para de ser re-enfileirado e fica com
//   o blurb do agregador (fail-open) — alvos mortos (domínio NXDOMAIN, PDF sem handler) não
//   re-falham a run inteira a cada execução.
ensureColumn('articles', 'enrich_attempts', 'enrich_attempts INTEGER DEFAULT 0');
// Seletor de DATA da listagem derivado por IA lendo a página real (CSS e/ou regex), por
// template de weekly — usado pelo piso --since quando o layout não expõe <time datetime>.
ensureColumn('selectors', 'date_selector', 'date_selector TEXT');
ensureColumn('selectors', 'date_attribute', 'date_attribute TEXT');
ensureColumn('selectors', 'date_regex', 'date_regex TEXT');
// Ledger por MOTOR (migração Jev): o mesmo llm_usage passa a separar Jev × chat (Gemini/fallback).
// - engine: 'jev' | 'chat' (NULL em linhas antigas — quem lê deduz pelo model, ver usageByStageEngine)
// - decisions: nº de perguntas decididas pela chamada (Jev) ou resolvidas pelo fallback (chat)
// - fallback_reason: NULL = chamada primária; texto = chamada de fallback e o porquê
//   (low-confidence, escape-option, jev-error, injection, circuit-open…)
// - latency_ms: duração da chamada (p95 do Jev no smoke/inspect)
// - requested_model: o slug PEDIDO (o `model` guarda o RESOLVIDO: 'typesafe/jev-1.13' pede,
//   'typesafe/jev-1.13-20260917' responde) — estimateStageCallUsd filtra por ele sem ambiguidade
//   de prefixo ('gemini-3.8-flash' × 'gemini-3.8-flash-lite')
ensureColumn('llm_usage', 'engine', 'engine TEXT');
ensureColumn('llm_usage', 'decisions', 'decisions INTEGER');
ensureColumn('llm_usage', 'fallback_reason', 'fallback_reason TEXT');
ensureColumn('llm_usage', 'latency_ms', 'latency_ms INTEGER');
ensureColumn('llm_usage', 'requested_model', 'requested_model TEXT');

// Dedup de conteúdo à prova de concorrência: promove idx_articles_hash a UNIQUE em DBs
// antigos (CREATE UNIQUE ... IF NOT EXISTS não converte um índice já existente). Só age se
// for não-único; se houver hashes duplicados pré-existentes, mantém o índice não-único.
{
  const ix = db.prepare(`SELECT "unique" AS u FROM pragma_index_list('articles') WHERE name = 'idx_articles_hash'`).get();
  if (ix && ix.u === 0) {
    try {
      db.exec('DROP INDEX idx_articles_hash; CREATE UNIQUE INDEX idx_articles_hash ON articles(content_hash);');
    } catch {
      db.exec('CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);');
    }
  }
}

// WHERE compartilhado do buscador web (`ncrawl web`): filtros combináveis via params ANULÁVEIS
// (NULL = filtro desligado), p/ manter UM prepared statement em vez de SQL dinâmico.
// Busca por TEXTO saiu daqui de propósito: toda busca com consulta é IA (POST /api/search);
// este WHERE atende só o BROWSE (lista sem consulta) e seus filtros.
// - @facets: objeto JSON {faceta:[tags]} — OR dentro da faceta, AND entre facetas: json_each no
//   objeto dá (key=faceta, value=array); "NOT EXISTS(faceta sem tag casando)" = todas casam.
// - @kind: 'news'|'tool'|'release' — release é match EXATO da coluna; news/tool mantêm a semântica
//   de isToolByTags (taxonomy.js): ferramenta = tag da faceta framework-library-tool OU
//   content-type ∈ @toolTypes (JSON, de TOOL_CONTENT_TYPES); release segue contando como tool.
//   A igualdade booleana `(@kind='tool') = (...)` cobre os dois lados (news = NÃO-ferramenta).
const WEB_WHERE = `
  WHERE (@sourceId IS NULL OR a.source_id = @sourceId)
    AND (@from IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) >= @from)
    AND (@to IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) <= @to)
    AND (@facets IS NULL OR NOT EXISTS (
          SELECT 1 FROM json_each(@facets) f
          WHERE NOT EXISTS (
            SELECT 1 FROM article_tags at
             WHERE at.article_id = a.id AND at.facet = f.key
               AND at.tag IN (SELECT value FROM json_each(f.value))
          )
        ))
    AND (@kind IS NULL OR CASE
          WHEN @kind = 'release' THEN a.kind = 'release'
          ELSE (@kind = 'tool') = (CASE
            WHEN a.kind IN ('tool', 'release') THEN 1
            WHEN a.kind = 'news' THEN 0
            ELSE EXISTS (
              SELECT 1 FROM article_tags tk
               WHERE tk.article_id = a.id
                 AND (tk.facet = 'framework-library-tool'
                      OR (tk.facet = 'content-type'
                          AND tk.tag IN (SELECT value FROM json_each(@toolTypes))))
            ) END)
          END)
    AND (@verify IS NULL OR a.verify_status = @verify)`;

// Escopo da busca IA da web (soft e hard): fontes (array JSON de ids via json_each) + período
// (mesma cláusula de data do WEB_WHERE: iso_date(published_at) com fallback em extracted_at).
const SEARCH_SCOPE_WHERE = `
  WHERE (@sources IS NULL OR a.source_id IN (SELECT value FROM json_each(@sources)))
    AND (@from IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) >= @from)
    AND (@to IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) <= @to)`;

// Índice do delta por execução (run_id vem via ensureColumn, então não existe no CREATE base).
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_run ON articles(run_id)');
// Piso legado: pendências por era (countPendingByEra) e as varreduras NULL-only filtram por
// verify_status/summary_pt + run_id. Índices ESTREITOS respondem sem ler a linha (as colunas vêm
// depois do `content`, e ler a linha atravessa o overflow do corpo). O de resumo é PARCIAL: só as
// linhas sem resumo entram (centenas, não 15 mil).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_articles_verify_run ON articles(verify_status, run_id);
  CREATE INDEX IF NOT EXISTS idx_articles_nosummary_run ON articles(run_id) WHERE summary_pt IS NULL;
`);

// ---- FTS5/BM25 sobre articles: metade LÉXICA da busca híbrida (gerador de candidatos) ----
// Tabela external-content (content='articles'): guarda SÓ o índice invertido, lê o texto por
// rowid=id. Triggers mantêm sincronizado em insert/update/delete (o comando 'delete' passa os
// valores ANTIGOS p/ o FTS localizar e decrementar a entrada certa). Indexa title/title_pt/
// content/summary_pt; porter+unicode61 (stemming EN + tokenização robusta sem diacríticos).
// Backfill ÚNICO via 'rebuild' quando a tabela é criada numa base que já tem artigos (o reset/
// purge fazem DELETE FROM articles, então as triggers de delete já mantêm o índice coerente).
{
  const ftsExisted =
    db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'articles_fts'`).get()
      .c > 0;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      title, title_pt, content, summary_pt,
      content = 'articles', content_rowid = 'id',
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, title, title_pt, content, summary_pt)
        VALUES (new.id, new.title, new.title_pt, new.content, new.summary_pt);
    END;
    CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, title_pt, content, summary_pt)
        VALUES ('delete', old.id, old.title, old.title_pt, old.content, old.summary_pt);
    END;
    CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, title_pt, content, summary_pt)
        VALUES ('delete', old.id, old.title, old.title_pt, old.content, old.summary_pt);
      INSERT INTO articles_fts(rowid, title, title_pt, content, summary_pt)
        VALUES (new.id, new.title, new.title_pt, new.content, new.summary_pt);
    END;
  `);
  if (!ftsExisted) db.exec(`INSERT INTO articles_fts(articles_fts) VALUES ('rebuild')`);
}

// ---- busca vetorial DENSA (sqlite-vec): tabela de embeddings + limpeza no delete ----
// rowid = articles.id; o embedding é preenchido em JS (o modelo não roda em trigger SQL) — ver
// src/embed.js (backfill/sweep). O trigger só LIMPA no delete (barato e seguro; insert/update do
// vetor ficam no fluxo JS). distance_metric=cosine (o bge é normalizado).
if (VEC_OK) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_vec USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine);
    CREATE TRIGGER IF NOT EXISTS articles_vec_ad AFTER DELETE ON articles BEGIN
      DELETE FROM articles_vec WHERE rowid = old.id;
    END;
  `);
}

// ---- piso "legado" (migração Jev, decisão 8: NÃO reprocessar o acervo que já existe) ----
// As varreduras PAGAS (verify / classify / summarize / reclean, inclusive o --force) só enxergam
// artigos DESTA era: run_id carimbado por uma run >= settings.jev_floor_run_id. O piso nasce no
// boot como MAX(runs.id)+1 (INSERT OR IGNORE: fixado UMA vez) — então as runs anteriores à
// migração e o acervo restaurado do git (15.502 linhas, todas com run_id NULL) ficam de fora por
// construção. `run_id IS NOT NULL` vem ANTES do >= de propósito: mesmo com @floor errado/ausente
// o NULL nunca entra. A ÚNICA porta de entrada é @includeLegacy = 1 (`finish|reclean
// --include-legacy --yes`, que mostra contagem e custo antes). Um predicado só, em TODA varredura.
export const LEGACY_FLOOR_KEY = 'jev_floor_run_id';
const jevEraSql = (col) => `(${col} IS NOT NULL AND ${col} >= @floor)`;
const legacyFloorSql = (col) => `(@includeLegacy = 1 OR ${jevEraSql(col)})`;
const LEGACY_FLOOR = legacyFloorSql('run_id');

// Varredura com piso: o wrapper preenche @floor (settings) e normaliza @includeLegacy p/ 0/1
// (better-sqlite3 não binda boolean) e @lim (LIMIT -1 = sem limite). Aceita SÓ objeto: a
// assinatura antiga `.all(lim)` LANÇA em vez de rodar sem piso por engano — e um chamador que
// esquece o includeLegacy cai no seguro (legado fora). `floor` explícito só em teste.
function sweepStmt(sql) {
  const st = db.prepare(sql);
  return {
    all: (params) => {
      if (params == null || typeof params !== 'object') {
        throw new TypeError('varredura com piso legado: passe { lim, includeLegacy, runId } (objeto), não um número');
      }
      return st.all({
        ...params,
        lim: Number.isFinite(params.lim) ? params.lim : -1,
        floor: Number.isInteger(params.floor) ? params.floor : getLegacyFloor(),
        includeLegacy: params.includeLegacy ? 1 : 0,
        // Escopo por run (stmts *ForRun): `run_id = @runId` com runId ausente vira NULL — que
        // nunca casa (run_id = NULL é sempre falso), então esquecer o runId NÃO varre o global
        // por engano. Chaves extras são ignoradas pelo better-sqlite3 nos stmts sem @runId.
        runId: Number.isInteger(params.runId) ? params.runId : null,
      });
    },
  };
}

// Pendências por ERA (status + confirmação do --include-legacy): "desta era" = o que as
// varreduras processam por padrão (MESMO predicado jevEraSql do LEGACY_FLOOR); "legado" = total
// menos desta era. Uma subconsulta por contagem DE PROPÓSITO: cada uma casa com um índice estreito
// (idx_articles_verify_run / idx_articles_nosummary_run / idx_articles_run) e responde sem tocar
// na linha — o SUM(CASE…) numa passada lia colunas DEPOIS do `content` e atravessava as páginas de
// overflow do corpo (~55 ms em 15,5 mil artigos; o getStatus roda a cada 1 s na TUI). Assim: ~2 ms.
const JEV_ERA = jevEraSql('run_id');
const NOT_CLASSIFIED = 'NOT EXISTS (SELECT 1 FROM classifications c WHERE c.article_id = a.id)';
const countPendingByEraStmt = db.prepare(
  `SELECT (SELECT COUNT(*) FROM articles) AS total,
          (SELECT COUNT(*) FROM articles WHERE ${JEV_ERA}) AS jev_articles,
          (SELECT COUNT(*) FROM articles WHERE summary_pt IS NULL) AS no_summary,
          (SELECT COUNT(*) FROM articles WHERE summary_pt IS NULL AND ${JEV_ERA}) AS jev_summary,
          (SELECT COUNT(*) FROM articles WHERE verify_status IS NULL) AS no_verify,
          (SELECT COUNT(*) FROM articles WHERE verify_status IS NULL AND ${JEV_ERA}) AS jev_verify,
          (SELECT COUNT(*) FROM articles WHERE verify_status = 'suspect') AS suspect,
          (SELECT COUNT(*) FROM articles WHERE verify_status = 'suspect' AND ${JEV_ERA}) AS jev_suspect,
          (SELECT COUNT(*) FROM articles a WHERE ${NOT_CLASSIFIED}) AS no_classify,
          (SELECT COUNT(*) FROM articles a WHERE ${NOT_CLASSIFIED} AND ${jevEraSql('a.run_id')}) AS jev_classify`,
);

// UPDATE real do enriquecimento (ver stmts.enrichArticle logo abaixo, que é o wrapper com o
// default de @run_id). Fica fora do literal porque o objeto não pode referenciar a si mesmo.
const enrichArticleUpdate = db.prepare(
  `UPDATE articles SET title = @title, content = @content, content_hash = @content_hash,
      published_at = @published_at, content_source = @content_source, cleaned = @cleaned,
      run_id = coalesce(@run_id, run_id), needs_enrich = 0
    WHERE id = @id`,
);

export const stmts = {
  // sources
  upsertSource: db.prepare(
    `INSERT INTO sources (name, base_url, type, max_index_pages)
     VALUES (@name, @base_url, @type, @max_index_pages)
     ON CONFLICT(base_url) DO UPDATE SET
       name = excluded.name, type = excluded.type, max_index_pages = excluded.max_index_pages
     RETURNING *`,
  ),
  getSourceById: db.prepare(`SELECT * FROM sources WHERE id = ?`),
  listSources: db.prepare(`SELECT * FROM sources ORDER BY id`),
  // Cursor por fonte: data do item mais novo JÁ capturado (só artigos datados contam; item sem
  // published_at não pode "envelhecer" o cursor nem adiantá-lo errado). O teto em `date('now')`
  // ignora DATA FUTURA de scrape errado em vez de deixar a fonte sem piso para sempre (o cursor
  // nunca avançaria e o derivado devolveria a data-bomba toda run).
  maxPublishedForSource: db.prepare(
    `SELECT MAX(iso_date(published_date)) AS d FROM (
        SELECT published_at AS published_date FROM articles
         WHERE source_id = ? AND published_at IS NOT NULL
       )
      WHERE iso_date(published_date) IS NOT NULL AND iso_date(published_date) <= date('now')`,
  ),
  // Teto do piso: trabalho INACABADO da fonte (pending/in_progress) não pode ser ultrapassado pelo
  // cursor — senão um backlog deixado por uma captura parcial (`--max-articles`, budget, Ctrl+C,
  // deadline) fica abaixo do piso, é marcado `done` no skip e some para sempre (enqueue é
  // INSERT OR IGNORE e o isUrlKnown conta frontier em qualquer estado). O seed da LISTAGEM
  // (kind='listing') fica fora: ele é re-enfileirado em toda run e não tem data.
  oldestUnfinishedForSource: db.prepare(
    `SELECT MIN(iso_date(discovered_date)) AS d,
            SUM(CASE WHEN iso_date(discovered_date) IS NULL THEN 1 ELSE 0 END) AS undated
       FROM frontier
      WHERE source_id = ? AND state IN ('pending','in_progress') AND kind <> 'listing'`,
  ),
  // Avanço SÓ (nunca retrocede): o piso de uma fonte nunca volta no tempo por causa de uma run.
  advanceSourceCursor: db.prepare(
    `UPDATE sources SET cursor_date = @date
      WHERE id = @id AND (cursor_date IS NULL OR cursor_date < @date)`,
  ),
  resetSourceCursor: db.prepare(`UPDATE sources SET cursor_date = NULL WHERE id = ?`),
  resetAllSourceCursors: db.prepare(`UPDATE sources SET cursor_date = NULL`),

  // pages
  upsertPage: db.prepare(
    `INSERT INTO pages (source_id, url, html_hash, status, pagination_depth, fetched_at)
     VALUES (@source_id, @url, @html_hash, @status, @pagination_depth, datetime('now'))
     ON CONFLICT(url) DO UPDATE SET
       html_hash = excluded.html_hash, status = excluded.status,
       pagination_depth = excluded.pagination_depth, fetched_at = datetime('now')`,
  ),

  // articles (o INSERT único cobre o fluxo avulso E o item curado — needs_enrich distingue)
  insertArticle: db.prepare(
    `INSERT OR IGNORE INTO articles
       (source_id, url, title, content, content_hash, published_at, run_id,
        kind, issue_url, section, blurb, content_source, cleaned, needs_enrich)
     VALUES (@source_id, @url, @title, @content, @content_hash, @published_at, @run_id,
        @kind, @issue_url, @section, @blurb, @content_source, @cleaned, @needs_enrich)`,
  ),
  getArticleByHash: db.prepare(`SELECT id FROM articles WHERE content_hash = ?`),
  getArticleByUrl: db.prepare(`SELECT id FROM articles WHERE url = ?`),
  // Fallback de data: a issue é a âncora temporal do item — se outro artigo da MESMA issue_url
  // já tem data, ela vale para o irmão sem data (a issue inteira foi publicada no mesmo dia).
  getIssueDate: db.prepare(`
    SELECT published_at FROM articles
    WHERE issue_url = ? AND published_at IS NOT NULL
    LIMIT 1
  `),
  // Backfill por issue (data descoberta DEPOIS — listagem datada/backfill): corrige os irmãos
  // ainda SEM data ou com data divergente; a issue é a âncora temporal de TODOS os seus itens.
  // NULL != 'x' é NULL (não casa), por isso o braço explícito de NULL.
  updateArticleDatesByIssue: db.prepare(
    `UPDATE articles SET published_at = @date
      WHERE issue_url = @url AND (published_at IS NULL OR published_at != @date)`,
  ),
  // URL conhecida em QUALQUER conteúdo já capturado (articles/pages/frontier) — base da
  // parada determinística de paginação: não depende do estado da frontier, que pode ter sido
  // limpa e transformar todo link em "novo" de novo.
  // A semântica é "JÁ CONHEÇO esta URL, não preciso descobri-la de novo na listagem", então os
  // QUATRO estados da frontier contam, não só 'done':
  //   pending/in_progress = já está NA FILA desta run (será reivindicado por claimNext*);
  //   failed              = esgotou MAX_RETRIES, foi abandonado de propósito.
  // Nada se perde ao pular o enfileiramento deles: `enqueue` é INSERT OR IGNORE, ou seja, para
  // uma URL que já tem linha na frontier (em QUALQUER estado) o enfileiramento já era no-op.
  // O QUE MUDA, exatamente: uma página cujos links já foram DESCOBERTOS (frontier pending/failed)
  // mas ainda não viraram `articles` passa a contar como território conhecido, e a paginação para
  // ANTES de enfileirar — antes do upsertPage e do dateSeen/floorHit dessa página. Isto ANTECIPA
  // uma parada que já existia: `crawlArchive` também para com `added === 0` (crawl.js), só que
  // uma página depois e após o trabalho acima. Não é a diferença entre parar e caminhar o
  // arquivo inteiro.
  // A lista é explícita (e não "existe linha na frontier") p/ um estado NOVO no futuro não
  // entrar aqui por acidente.
  isUrlKnown: db.prepare(`
    SELECT 1 FROM articles WHERE url = ?
    UNION ALL
    SELECT 1 FROM pages WHERE url = ?
    UNION ALL
    SELECT 1 FROM frontier WHERE url = ? AND state IN ('done', 'failed', 'pending', 'in_progress')
    UNION ALL
    SELECT 1 FROM articles WHERE issue_url = ?
    LIMIT 1
  `),
  getArticleFullByUrl: db.prepare(`SELECT * FROM articles WHERE url = ?`),
  // Enriquecimento de item curado: preenche o corpo vindo do ALVO sem tocar kind/blurb/section.
  // Marca d'água do delta no ENRIQUECIMENTO: um item cadastrado só com o blurb na run N e que
  // ganhou o corpo na run N+1 continuava com run_id = N e sumia do escopo "apenas o novo"
  // (`listRunArticlesForSearch`/`articlesByTagsForRun`, ancorados em maxArticleRunId). Passe
  // `run_id` p/ carimbar a run corrente; sem o campo (chamadores antigos) o valor é preservado
  // via coalesce, então a mudança é retrocompatível.
  // O wrapper existe porque better-sqlite3 exige TODO parâmetro nomeado presente no objeto
  // (`RangeError: Missing named parameter`): sem o default, `stmts.enrichArticle.run({...})`
  // sem run_id quebraria na hora.
  enrichArticle: { run: (params) => enrichArticleUpdate.run({ run_id: null, ...params }) },
  finishEnrich: db.prepare(`UPDATE articles SET needs_enrich = 0 WHERE id = ?`),
  // verificação pós-cadastro (veredito por artigo) + varredura idempotente (NULL-only)
  setVerify: db.prepare(
    `UPDATE articles SET verify_status = @verify_status, verify_notes = @verify_notes WHERE id = @id`,
  ),
  // Varreduras com PISO LEGADO (sweepStmt): `.all({ lim, includeLegacy })` — ver LEGACY_FLOOR.
  listArticlesToVerify: sweepStmt(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles
      WHERE verify_status IS NULL AND ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  // verify --force / finish --force (re-verifica TODOS desta era; o legado só com includeLegacy).
  listArticlesForReverifySweep: sweepStmt(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles
      WHERE ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  // Escopo por RUN (sweep pós-crawl): só as fichas DESTA run — o backlog de runs anteriores fica
  // para o `finish` explícito. Sem isso, uma run de data coberta drena a dívida global (medido em
  // docs/reprocesso-IA-audit-2026-09-11.md). Mesmo piso legado das varreduras (sweepStmt:
  // `.all({ lim, includeLegacy, runId })`) — a regra "UM predicado em TODA varredura paga" vale
  // aqui também; a run corrente sempre passa o piso (run_id >= floor).
  listArticlesToVerifyForRun: sweepStmt(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles
      WHERE verify_status IS NULL AND run_id = @runId AND ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  // reextract (src/reextract.js): candidatos LEVES — id/url/run_id, SEM o corpo — com o MESMO piso
  // legado das varreduras (re-clean + re-verify pagos sobre o acervo antigo só com
  // --include-legacy --yes). O filtro --url e o --limit rodam em JS sobre esta lista e só as fichas
  // escolhidas têm o corpo lido (getArticleForReextract): antes a lista trazia o conteúdo do
  // acervo INTEIRO p/ usar 20 fichas. A contagem do portão do --include-legacy usa a mesma lista,
  // então o número exibido é exatamente o que roda.
  listReextractCandidates: sweepStmt(
    `SELECT id, url, run_id FROM articles
      WHERE content_source = 'target' AND ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  getArticleForReextract: db.prepare(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles WHERE id = ?`,
  ),
  // reclean: só os vereditos 'suspect' (utilizáveis, mas com problemas) p/ um passe de limpeza forte.
  // Com piso: os 4.517 suspect do acervo restaurado só entram com --include-legacy --yes.
  listSuspectArticles: sweepStmt(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles
      WHERE verify_status = 'suspect' AND ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  // reclean: atualiza SÓ o conteúdo limpo (passe Pro) + hash + marca cleaned; não toca em kind/blurb.
  setContentCleaned: db.prepare(
    `UPDATE articles SET content = @content, content_hash = @content_hash, cleaned = 1 WHERE id = @id`,
  ),
  listArticlesBySource: db.prepare(`SELECT * FROM articles WHERE source_id = ? ORDER BY id`),
  // delta: só os artigos descobertos numa execução (run) específica.
  listArticlesForRunBySource: db.prepare(
    `SELECT * FROM articles WHERE source_id = ? AND run_id = ? ORDER BY id`,
  ),

  // resumos PT-BR (title_pt/summary_pt; LIMIT -1 = sem limite, como em classify). Com piso legado.
  setSummary: db.prepare(`UPDATE articles SET title_pt = @title_pt, summary_pt = @summary_pt WHERE id = @id`),
  listArticlesNeedingSummary: sweepStmt(
    `SELECT id, url, title, content FROM articles
      WHERE summary_pt IS NULL AND ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  listArticlesNeedingSummaryForRun: sweepStmt(
    `SELECT id, url, title, content FROM articles
      WHERE summary_pt IS NULL AND run_id = @runId AND ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  listArticlesForResummarize: sweepStmt(
    `SELECT id, url, title, content FROM articles WHERE ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  countSummaries: db.prepare(`SELECT COUNT(*) c FROM articles WHERE summary_pt IS NOT NULL`),

  // busca: varredura completa (modo A) e retrieval por conjunto de tags (modo B, via json_each).
  // Todos trazem fonte + data ISO (join por PK, custo ~zero) p/ a lista/preview da TUI.
  listAllArticlesForSearch: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content,
            s.name AS source_name,
            coalesce(iso_date(a.published_at), date(a.extracted_at)) AS date_iso
       FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      ORDER BY a.id LIMIT ?`,
  ),
  // delta: varredura (modo A) restrita a uma execução (run).
  listRunArticlesForSearch: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content,
            s.name AS source_name,
            coalesce(iso_date(a.published_at), date(a.extracted_at)) AS date_iso
       FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.run_id = ? ORDER BY a.id LIMIT ?`,
  ),
  articlesByTags: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content,
            s.name AS source_name,
            coalesce(iso_date(a.published_at), date(a.extracted_at)) AS date_iso,
            COUNT(DISTINCT at.tag) AS matches
       FROM article_tags at
       JOIN articles a ON a.id = at.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE at.tag IN (SELECT value FROM json_each(@tags))
      GROUP BY a.id
      ORDER BY matches DESC
      LIMIT @limit`,
  ),
  // delta: retrieval por tags (modo B) restrito a uma execução (run).
  articlesByTagsForRun: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content,
            s.name AS source_name,
            coalesce(iso_date(a.published_at), date(a.extracted_at)) AS date_iso,
            COUNT(DISTINCT at.tag) AS matches
       FROM article_tags at
       JOIN articles a ON a.id = at.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE at.tag IN (SELECT value FROM json_each(@tags))
        AND a.run_id = @runId
      GROUP BY a.id
      ORDER BY matches DESC
      LIMIT @limit`,
  ),

  // recuperação LÉXICA (FTS5/BM25): top-N ids por relevância, escopo opcional (fontes/período).
  // Metade léxica da busca híbrida — candidatos p/ o LLM/reranker julgar só o top-K, não o acervo
  // inteiro. bm25() é NEGATIVO (mais relevante = mais negativo) -> ORDER BY ASC; os pesos por
  // coluna priorizam título (title, title_pt, content, summary_pt).
  searchFts: db.prepare(
    `SELECT a.id, bm25(articles_fts, 10.0, 8.0, 1.0, 3.0) AS score
       FROM articles_fts
       JOIN articles a ON a.id = articles_fts.rowid
      WHERE articles_fts MATCH @q
        AND (@sources IS NULL OR a.source_id IN (SELECT value FROM json_each(@sources)))
        AND (@from IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) >= @from)
        AND (@to IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) <= @to)
      ORDER BY score
      LIMIT @limit`,
  ),

  // busca IA da web (soft/hard): contagem do escopo (guard de custo) + candidatos filtrados
  webSearchScopeCount: db.prepare(`SELECT COUNT(*) c FROM articles a ${SEARCH_SCOPE_WHERE}`),
  // hard (por artigo): content inteiro (judgeRelevance corta em SEARCH_MAX_CHARS)
  webSearchCandidates: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content
       FROM articles a ${SEARCH_SCOPE_WHERE}
      ORDER BY a.id`,
  ),
  // soft (lote): entrada mínima por artigo — summary_pt, senão blurb, senão a cabeça do content
  webSearchCandidatesLite: db.prepare(
    `SELECT a.id, a.title, a.title_pt, a.summary_pt, a.blurb,
            substr(coalesce(a.content, ''), 1, 400) AS content_head
       FROM articles a ${SEARCH_SCOPE_WHERE}
      ORDER BY a.id`,
  ),

  // buscador web (ncrawl web): página filtrada + count com o MESMO WHERE (params anuláveis)
  webSearchArticles: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.published_at, a.extracted_at,
            a.source_id, s.name AS source_name, a.kind, a.section, a.verify_status, a.verify_notes,
            substr(coalesce(a.blurb, a.content, ''), 1, 280) AS snippet
       FROM articles a
       LEFT JOIN sources s ON s.id = a.source_id
     ${WEB_WHERE}
      ORDER BY coalesce(iso_date(a.published_at), date(a.extracted_at)) DESC, a.id DESC
      LIMIT @limit OFFSET @offset`,
  ),
  webCountArticles: db.prepare(`SELECT COUNT(*) c FROM articles a ${WEB_WHERE}`),
  webGetArticle: db.prepare(
    `SELECT a.*, s.name AS source_name
       FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.id = ?`,
  ),
  // resultados da busca IA: re-select por ids (a ordem de relevância é restaurada em JS via Map)
  webArticlesByIds: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.published_at, a.extracted_at,
            a.source_id, s.name AS source_name, a.kind, a.section, a.verify_status, a.verify_notes,
            substr(coalesce(a.blurb, a.content, ''), 1, 280) AS snippet
       FROM articles a
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.id IN (SELECT value FROM json_each(@ids))`,
  ),
  webMetaSources: db.prepare(
    `SELECT s.id, s.name, s.base_url, COUNT(a.id) AS c
       FROM sources s LEFT JOIN articles a ON a.source_id = s.id
      GROUP BY s.id
      ORDER BY c DESC, s.name`,
  ),
  webMetaTags: db.prepare(
    `SELECT facet, tag, COUNT(*) AS c FROM article_tags GROUP BY facet, tag ORDER BY facet, c DESC, tag`,
  ),
  webMetaDates: db.prepare(
    `SELECT min(coalesce(iso_date(published_at), date(extracted_at))) AS min_d,
            max(coalesce(iso_date(published_at), date(extracted_at))) AS max_d
       FROM articles`,
  ),

  // snapshot estático do webapp (`ncrawl export --format web`): acervo COMPLETO, ordenado por id
  // ASC (determinístico — diff de git append-only). date_iso é pré-computado aqui (o cliente
  // nunca porta parseDate; filtro de período no browser vira comparação de string YYYY-MM-DD) e
  // o snippet usa 400 chars (paridade com o content_head(400) da busca soft; o card corta visual).
  // issue_url + blurb viajam AQUI (e não numa varredura por fonte, como já foi): um artigo com
  // source_id NULO — exatamente o que um restore do snapshot produz quando a fonte não pôde ser
  // remapeada — não aparece em nenhum `listArticlesBySource` e sairia SEM a proveniência que o
  // ciclo restore→re-export existe para preservar. Uma query só, todo artigo, sem exceção.
  webExportArticles: db.prepare(
    `SELECT a.id, a.source_id, a.url, a.title, a.title_pt, a.summary_pt,
            substr(coalesce(a.blurb, a.content, ''), 1, 400) AS snippet,
            a.issue_url, a.blurb,
            coalesce(iso_date(a.published_at), date(a.extracted_at)) AS date_iso,
            a.kind, a.section, a.verify_status, a.verify_notes
       FROM articles a
      ORDER BY a.id`,
  ),
  webExportContents: db.prepare(
    `SELECT id, coalesce(content, '') AS content FROM articles ORDER BY id`,
  ),
  // tags de TODOS os artigos numa query só (agrupadas em JS) — não 1 getTagsForArticle por artigo
  webExportTags: db.prepare(
    `SELECT article_id, facet, tag FROM article_tags ORDER BY article_id, facet, rank`,
  ),

  // selectors (CSS de links/conteúdo/next + o par CSS+regex de DATA, tudo por template_sig)
  getSelector: db.prepare(`SELECT * FROM selectors WHERE template_sig = ?`),
  putSelector: db.prepare(
    `INSERT INTO selectors
       (template_sig, link_selector, link_attribute, content_selector, next_selector,
        date_selector, date_attribute, date_regex, model_used, confidence, last_validated)
     VALUES
       (@template_sig, @link_selector, @link_attribute, @content_selector, @next_selector,
        @date_selector, @date_attribute, @date_regex, @model_used, @confidence, datetime('now'))
     ON CONFLICT(template_sig) DO UPDATE SET
       link_selector   = excluded.link_selector,
       link_attribute  = excluded.link_attribute,
       content_selector= excluded.content_selector,
       next_selector   = excluded.next_selector,
       date_selector   = excluded.date_selector,
       date_attribute  = excluded.date_attribute,
       date_regex      = excluded.date_regex,
       model_used      = excluded.model_used,
       confidence      = excluded.confidence,
       last_validated  = datetime('now')`,
  ),

  // frontier (6º parâmetro: discovered_date — data do par da listagem, âncora do roundup)
  enqueue: db.prepare(
    `INSERT OR IGNORE INTO frontier (url, kind, discovered_from, source_id, depth, discovered_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  // retries ASC: um job devolvido a 'pending' por falha só volta DEPOIS dos jobs frescos —
  // sem isso o FIFO puro reivindica a falha de novo em segundos (hot-loop num host quebrado).
  claimNext: db.prepare(
    `UPDATE frontier SET state = 'in_progress'
     WHERE id = (SELECT id FROM frontier WHERE state = 'pending' ORDER BY retries ASC, id ASC LIMIT 1)
     RETURNING *`,
  ),
  // Claims SEPARADOS por pool: artigos (fetch/render — contam na capacity de fetch+render) vs
  // curadoria (listing/roundup — fase de LLM longa, pool próprio p/ não travar o fetch dos artigos).
  // Juntos são EXAUSTIVOS (article | não-article), então nenhum job pendente fica órfão.
  claimNextArticle: db.prepare(
    `UPDATE frontier SET state = 'in_progress'
     WHERE id = (SELECT id FROM frontier WHERE state = 'pending' AND kind = 'article'
                  ORDER BY retries ASC, id ASC LIMIT 1)
     RETURNING *`,
  ),
  claimNextCurate: db.prepare(
    `UPDATE frontier SET state = 'in_progress'
     WHERE id = (SELECT id FROM frontier WHERE state = 'pending' AND (kind IS NULL OR kind != 'article')
                  ORDER BY retries ASC, id ASC LIMIT 1)
     RETURNING *`,
  ),
  finish: db.prepare(`UPDATE frontier SET state = ? WHERE url = ?`),
  bumpRetry: db.prepare(`UPDATE frontier SET retries = retries + 1, state = 'pending' WHERE url = ?`),
  getRetries: db.prepare(`SELECT retries FROM frontier WHERE url = ?`),
  resetInProgress: db.prepare(`UPDATE frontier SET state = 'pending' WHERE state = 'in_progress'`),
  // Re-crawl incremental: re-ativa o seed de listagem de UMA fonte (done/failed -> pending) p/
  // re-visitar a listagem e descobrir só o que é novo. Só 'listing' (seeds); roundup/article ficam.
  refreshListing: db.prepare(
    `UPDATE frontier SET state = 'pending', retries = 0
      WHERE url = ? AND kind = 'listing' AND state IN ('done', 'failed')`,
  ),
  // Item curado ainda needs_enrich cujo job já terminou (run anterior): re-ativa p/ tentar de novo.
  requeueUrl: db.prepare(
    `UPDATE frontier SET state = 'pending', retries = 0
      WHERE url = ? AND state IN ('done', 'failed')`,
  ),
  // "Enriquecer depois": no início do crawl, re-ativa os jobs de artigos que ficaram só com o
  // blurb (needs_enrich=1) — inclui os cortados por deadline no run anterior. Escopo por fonte.
  // Teto por alvo: quem falhou ENRICH_MAX_ATTEMPTS rodadas seguidas para de ser re-enfileirado
  // (bump conta a rodada FALHADA do run anterior; o requeue só re-ativa quem ainda tem tentativa).
  // 'done' conta tanto quanto 'failed': o ramo de TIMEOUT do job grava frontier 'done' (o item
  // fica com o blurb e re-enfileira depois — commands.js), e requeueNeedsEnrichForSource re-ativa
  // done E failed zerando retries. Contando só 'failed', um alvo que SEMPRE estoura o deadline
  // era re-enfileirado para sempre com enrich_attempts congelado em 0 — o teto nunca chegava.
  // needs_enrich = 1 + job TERMINADO é, por construção, uma RODADA FALHADA: todo desfecho que
  // decide manter o blurb de propósito (robots/pdf/raso/bloqueado/dup) passa por finishEnrich e
  // zera needs_enrich; sucesso idem (enrichArticle). BUDGET_EXCEEDED devolve a 'pending' e um
  // processo morto vira 'in_progress' -> resetInProgress o devolve a 'pending' ANTES daqui —
  // nenhum dos dois conta tentativa.
  bumpFailedEnrichAttempts: db.prepare(
    `UPDATE articles SET enrich_attempts = enrich_attempts + 1
      WHERE needs_enrich = 1 AND source_id = ?
        AND url IN (SELECT url FROM frontier
                     WHERE kind = 'article' AND state IN ('done', 'failed'))`,
  ),
  requeueNeedsEnrichForSource: db.prepare(
    `UPDATE frontier SET state = 'pending', retries = 0
      WHERE kind = 'article' AND state IN ('done', 'failed')
        AND url IN (SELECT url FROM articles
                     WHERE needs_enrich = 1 AND source_id = ? AND enrich_attempts < ?)`,
  ),
  // Mesmo escopo do bump (done E failed): quem está no teto num job já terminado é exatamente
  // quem PAROU de ser re-enfileirado e ficou com o blurb — é isso que a linha de log reporta.
  countEnrichAtCapForSource: db.prepare(
    `SELECT COUNT(*) AS c FROM articles
      WHERE needs_enrich = 1 AND source_id = ? AND enrich_attempts >= ?
        AND url IN (SELECT url FROM frontier
                     WHERE kind = 'article' AND state IN ('done', 'failed'))`,
  ),

  // events (trace por item: cada estágio grava o que fez/decidiu; `ncrawl inspect` lê daqui)
  insertEvent: db.prepare(
    `INSERT INTO events (run_id, source_id, url, stage, status, detail)
     VALUES (@run_id, @source_id, @url, @stage, @status, @detail)`,
  ),
  listEventsForRun: db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id`),
  listEventsForUrl: db.prepare(`SELECT * FROM events WHERE url LIKE ? ORDER BY id LIMIT ?`),
  countEventsByStage: db.prepare(
    `SELECT stage, status, COUNT(*) c FROM events WHERE run_id = ?
      GROUP BY stage, status ORDER BY stage, status`,
  ),

  // jev_decisions (log central das decisões do Jev; escrito em lote por events.logDecision)
  insertJevDecision: db.prepare(
    `INSERT INTO jev_decisions (run_id, stage, subject, url, qid, value, p, certainty, threshold,
                                outcome, reason, fb_value, agree, model, sample_rate)
     VALUES (@run_id, @stage, @subject, @url, @qid, @value, @p, @certainty, @threshold,
             @outcome, @reason, @fb_value, @agree, @model, @sample_rate)`,
  ),
  // Listagem/exportação (inspect --decisions, recalibração offline): filtros ANULÁVEIS (NULL =
  // desligado) p/ um prepared statement só; @lim = -1 devolve tudo (LIMIT -1 do SQLite).
  listJevDecisions: db.prepare(
    `SELECT * FROM jev_decisions
      WHERE (@runId IS NULL OR run_id = @runId)
        AND (@stage IS NULL OR stage = @stage)
        AND (@qid IS NULL OR qid = @qid)
        AND (@outcome IS NULL OR outcome = @outcome)
      ORDER BY id LIMIT @lim`,
  ),
  // Contagem por (estágio, desfecho) de uma run. `n` = linhas gravadas; `est` = total ESTIMADO
  // (com JEV_TRACE=min os aceitos entram por amostra: cada linha vale 1/sample_rate decisões).
  countJevDecisionsByStageOutcome: db.prepare(
    `SELECT stage, outcome, COUNT(*) n,
            CAST(ROUND(SUM(1.0 / CASE WHEN sample_rate > 0 THEN sample_rate ELSE 1 END)) AS INTEGER) est,
            AVG(certainty) avg_certainty
       FROM jev_decisions WHERE run_id = ?
      GROUP BY stage, outcome ORDER BY stage, outcome`,
  ),
  // Motivos dos desfechos NÃO-aceitos (fallback/default/error/shadow) de uma run.
  countJevDecisionReasonsForRun: db.prepare(
    `SELECT stage, outcome, COALESCE(reason, '') reason, COUNT(*) n
       FROM jev_decisions WHERE run_id = ? AND outcome <> 'accept'
      GROUP BY stage, outcome, reason ORDER BY n DESC, stage, outcome`,
  ),
  // Os fallbacks de MENOR certeza de uma run (onde o limiar está mordendo) — inspect.
  listJevLowestCertaintyForRun: db.prepare(
    `SELECT * FROM jev_decisions
      WHERE run_id = @runId AND outcome <> 'accept'
      ORDER BY certainty IS NULL, certainty ASC, id LIMIT @lim`,
  ),

  // inspect (auditoria de uma run: artigos com veredito + agrupamento por issue de origem)
  getRunById: db.prepare(
    `SELECT r.*,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = r.id) spent_usd
       FROM runs r WHERE r.id = ?`,
  ),
  listArticlesForRunInspect: db.prepare(
    `SELECT id, url, title, kind, section, issue_url, content_source, cleaned, needs_enrich,
            verify_status, verify_notes, published_at, length(coalesce(content,'')) AS content_len
       FROM articles WHERE run_id = ?
      ORDER BY coalesce(issue_url, ''), CASE coalesce(kind,'news')
        WHEN 'news' THEN 0 WHEN 'tool' THEN 1 WHEN 'release' THEN 2 ELSE 3 END, id`,
  ),
  countArticlesByKindForRun: db.prepare(
    `SELECT coalesce(kind, '(sem kind)') kind, COUNT(*) c FROM articles WHERE run_id = ?
      GROUP BY 1 ORDER BY c DESC`,
  ),
  countVerifyForRun: db.prepare(
    `SELECT coalesce(verify_status, '(pendente)') s, COUNT(*) c FROM articles WHERE run_id = ?
      GROUP BY 1 ORDER BY c DESC`,
  ),
  listArticlesLikeUrl: db.prepare(
    `SELECT id, url, title, kind, verify_status, verify_notes, content_source, needs_enrich
       FROM articles WHERE url LIKE ? ORDER BY id LIMIT 20`,
  ),

  // purge por fonte (protocolo "apague e refaça" reprodutível; a fonte continua cadastrada)
  countArticlesBySource: db.prepare(`SELECT COUNT(*) c FROM articles WHERE source_id = ?`),
  deleteArticlesBySource: db.prepare(`DELETE FROM articles WHERE source_id = ?`),
  deletePagesBySource: db.prepare(`DELETE FROM pages WHERE source_id = ?`),
  deleteFrontierBySource: db.prepare(`DELETE FROM frontier WHERE source_id = ?`),
  deleteEventsBySource: db.prepare(`DELETE FROM events WHERE source_id = ?`),
  deleteSelectorsLike: db.prepare(`DELETE FROM selectors WHERE template_sig LIKE ?`),

  // "há QUALQUER dado aqui?" numa pergunta só (EXISTS = O(1) por tabela; COUNT varreria tudo).
  // Serve a UM propósito: o guard de backup das operações destrutivas precisa distinguir o
  // `createBackup() === null` LEGÍTIMO ("banco vazio, não havia o que copiar" — pode seguir) da
  // FALHA de backup (disco cheio/permissão — ABORTA a destruição). A lista de tabelas é a MESMA
  // do DATA_TABLES do src/backup.js: "0 artigos" não é "0 dados" (selectors, llm_usage e
  // jev_decisions saíram de chamadas de IA que custaram dinheiro).
  hasAnyData: db.prepare(
    `SELECT (EXISTS(SELECT 1 FROM articles)
          OR EXISTS(SELECT 1 FROM sources)
          OR EXISTS(SELECT 1 FROM pages)
          OR EXISTS(SELECT 1 FROM selectors)
          OR EXISTS(SELECT 1 FROM frontier)
          OR EXISTS(SELECT 1 FROM runs)
          OR EXISTS(SELECT 1 FROM classifications)
          OR EXISTS(SELECT 1 FROM article_tags)
          OR EXISTS(SELECT 1 FROM classification_uncovered)
          OR EXISTS(SELECT 1 FROM llm_usage)
          OR EXISTS(SELECT 1 FROM events)
          OR EXISTS(SELECT 1 FROM searches)
          OR EXISTS(SELECT 1 FROM jev_decisions)) AS x`,
  ),

  // remoção COMPLETA de uma fonte (descadastra de vez, além do purge): ids dos artigos p/ decidir
  // quais buscas ficaram órfãs; a linha `sources` em si (apagada por ÚLTIMO — FK dos articles).
  listSourceArticleIds: db.prepare(`SELECT id FROM articles WHERE source_id = ?`),
  deleteSourceById: db.prepare(`DELETE FROM sources WHERE id = ?`),

  // runs / marca d'água por execução (delta de "novo desde a última execução")
  startDeltaRun: db.prepare(`INSERT INTO runs (started_at) VALUES (datetime('now')) RETURNING id`),
  finishDeltaRun: db.prepare(`UPDATE runs SET finished_at = datetime('now'), new_count = ? WHERE id = ?`),
  getLatestRunId: db.prepare(`SELECT MAX(id) AS id FROM runs`),
  // âncora do ESCOPO da busca: a última run que DESCOBRIU artigos (search/verify/web-search
  // também abrem runs, mas nunca setam articles.run_id — MAX(runs.id) zeraria o delta).
  maxArticleRunId: db.prepare(`SELECT MAX(run_id) AS id FROM articles`),
  // inspect: a última run DE CRAWL (um verify/classify avulso também abre run, mas sem artigos)
  getLatestCrawlRunId: db.prepare(`SELECT MAX(id) AS id FROM runs WHERE command = 'crawl'`),
  countArticlesByRun: db.prepare(`SELECT COUNT(*) c FROM articles WHERE run_id = ?`),

  // stats
  countFrontierByState: db.prepare(`SELECT state, COUNT(*) c FROM frontier GROUP BY state`),
  countSources: db.prepare(`SELECT COUNT(*) c FROM sources`),
  countPages: db.prepare(`SELECT COUNT(*) c FROM pages`),
  countArticles: db.prepare(`SELECT COUNT(*) c FROM articles`),
  countSelectors: db.prepare(`SELECT COUNT(*) c FROM selectors`),

  // classifications (pós-processamento: 1 linha/artigo + índice normalizado + uncovered)
  upsertClassification: db.prepare(
    `INSERT INTO classifications
       (article_id, result_json, domain_confidence, taxonomy_version, model_used, status)
     VALUES (@article_id, @result_json, @domain_confidence, @taxonomy_version, @model_used, @status)
     ON CONFLICT(article_id) DO UPDATE SET
       result_json       = excluded.result_json,
       domain_confidence = excluded.domain_confidence,
       taxonomy_version  = excluded.taxonomy_version,
       model_used        = excluded.model_used,
       status            = excluded.status,
       classified_at     = datetime('now')`,
  ),
  deleteTagsForArticle: db.prepare(`DELETE FROM article_tags WHERE article_id = ?`),
  insertTag: db.prepare(
    `INSERT OR IGNORE INTO article_tags (article_id, facet, tag, rank)
     VALUES (@article_id, @facet, @tag, @rank)`,
  ),
  deleteUncoveredForArticle: db.prepare(`DELETE FROM classification_uncovered WHERE article_id = ?`),
  insertUncovered: db.prepare(
    `INSERT INTO classification_uncovered (article_id, facet, term) VALUES (@article_id, @facet, @term)`,
  ),
  getClassification: db.prepare(`SELECT * FROM classifications WHERE article_id = ?`),
  getTagsForArticle: db.prepare(
    `SELECT facet, tag, rank FROM article_tags WHERE article_id = ? ORDER BY facet, rank`,
  ),
  // kind determinístico pós-classificação (kindFromTags em classify.js): só preenche onde
  // NÃO há curadoria (kind NULL — itens de fontes listing/avulsos). O WHERE protege o kind
  // curado dos roundups de fontes index: a curadoria é a autoridade, nunca é sobrescrita.
  setKindIfNull: db.prepare(`UPDATE articles SET kind = @kind WHERE id = @id AND kind IS NULL`),
  // Com piso legado (sweepStmt): os ~250 restaurados sem classificação só entram com includeLegacy.
  listArticlesNeedingClassification: sweepStmt(
    `SELECT a.id, a.url, a.title, a.content
       FROM articles a
       LEFT JOIN classifications c ON c.article_id = a.id
      WHERE c.article_id IS NULL AND ${legacyFloorSql('a.run_id')}
      ORDER BY a.id
      LIMIT @lim`,
  ),
  listArticlesNeedingClassificationForRun: sweepStmt(
    `SELECT a.id, a.url, a.title, a.content
       FROM articles a
       LEFT JOIN classifications c ON c.article_id = a.id
      WHERE c.article_id IS NULL AND a.run_id = @runId AND ${legacyFloorSql('a.run_id')}
      ORDER BY a.id
      LIMIT @lim`,
  ),
  listArticlesForReclassify: sweepStmt(
    `SELECT id, url, title, content FROM articles WHERE ${LEGACY_FLOOR} ORDER BY id LIMIT @lim`,
  ),
  countClassifications: db.prepare(`SELECT COUNT(*) c FROM classifications`),
  topUncovered: db.prepare(
    `SELECT term, COUNT(*) c FROM classification_uncovered GROUP BY term ORDER BY c DESC LIMIT ?`,
  ),

  // runs / llm_usage (ledger de custo: 1 linha por run + 1 linha por chamada LLM cobrada)
  insertRun: db.prepare(
    `INSERT INTO runs (command, args, budget_usd) VALUES (@command, @args, @budget_usd) RETURNING id`,
  ),
  finishRun: db.prepare(
    `UPDATE runs SET status = @status, finished_at = datetime('now') WHERE id = @id`,
  ),
  insertLlmUsage: db.prepare(
    `INSERT INTO llm_usage (run_id, stage, model, prompt_tokens, completion_tokens, cost_usd,
                            engine, decisions, fallback_reason, latency_ms, requested_model)
     VALUES (@run_id, @stage, @model, @prompt_tokens, @completion_tokens, @cost_usd,
             @engine, @decisions, @fallback_reason, @latency_ms, @requested_model)`,
  ),
  sumUsageForRun: db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) usd, COUNT(*) n FROM llm_usage WHERE run_id = ?`,
  ),
  sumUsageTotal: db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) usd, COUNT(*) n FROM llm_usage`),
  // média REAL do custo por chamada de um estágio (estimativa exibida ANTES de rodar uma busca)
  avgUsageByStage: db.prepare(
    `SELECT COALESCE(AVG(cost_usd), 0) avg, COUNT(*) n FROM llm_usage WHERE stage = ? AND cost_usd > 0`,
  ),
  // Mesma média, mas SÓ do modelo pedido (@model NULL = todos): quando um estágio troca de modelo
  // (deepseek → Gemini, chat → Jev), a média do modelo antigo mentiria na estimativa. Casa pelo
  // slug PEDIDO (requested_model) ou, em linhas antigas sem ele, pelo resolvido.
  avgUsageByStageModel: db.prepare(
    `SELECT COALESCE(AVG(cost_usd), 0) avg, COUNT(*) n FROM llm_usage
      WHERE stage = @stage AND cost_usd > 0
        AND (@model IS NULL OR requested_model = @model OR model = @model)`,
  ),
  // Custo por (estágio, motor) de uma run — "custo por motor" do inspect/extrato. Linha antiga sem
  // engine é deduzida pelo slug (typesafe/* = jev), a mesma regra do engineOf do budget.js.
  usageByStageEngine: db.prepare(
    `SELECT stage,
            COALESCE(engine, CASE WHEN model LIKE 'typesafe/%' THEN 'jev' ELSE 'chat' END) engine,
            COUNT(*) n,
            COALESCE(SUM(decisions), 0) decisions,
            COALESCE(SUM(cost_usd), 0) usd,
            SUM(CASE WHEN fallback_reason IS NOT NULL THEN 1 ELSE 0 END) fallback_calls,
            COALESCE(SUM(CASE WHEN fallback_reason IS NOT NULL THEN cost_usd END), 0) fallback_usd,
            AVG(latency_ms) avg_latency_ms,
            MAX(latency_ms) max_latency_ms
       FROM llm_usage WHERE run_id = ?
      GROUP BY 1, 2 ORDER BY usd DESC`,
  ),
  // Acumulado all-time por motor (status/extrato).
  sumUsageByEngine: db.prepare(
    `SELECT COALESCE(engine, CASE WHEN model LIKE 'typesafe/%' THEN 'jev' ELSE 'chat' END) engine,
            COUNT(*) n, COALESCE(SUM(decisions), 0) decisions, COALESCE(SUM(cost_usd), 0) usd
       FROM llm_usage GROUP BY 1 ORDER BY usd DESC`,
  ),
  usageByStage: db.prepare(
    `SELECT stage, COUNT(*) n, COALESCE(SUM(cost_usd), 0) usd
       FROM llm_usage WHERE run_id = ? GROUP BY stage ORDER BY usd DESC`,
  ),
  listRuns: db.prepare(
    `SELECT r.id, r.command, r.budget_usd, r.status, r.started_at, r.finished_at,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = r.id) spent_usd
       FROM runs r ORDER BY r.id DESC LIMIT ?`,
  ),
  getLastRun: db.prepare(
    `SELECT r.id, r.command, r.budget_usd, r.status, r.started_at, r.finished_at,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = r.id) spent_usd
       FROM runs r ORDER BY r.id DESC LIMIT 1`,
  ),

  // Histórico de buscas IA (CLI/TUI/web local): o resultado CONGELADO vive em hits_json como
  // ids+vereditos (leve); título/resumo são RE-HIDRATADOS do acervo na leitura — id que sumiu
  // (purge) é contado como ausente, nunca quebra. O custo real vem de llm_usage via run_id
  // (1 run por busca: runWithLimits no CLI/TUI, withSearchRun na web), não de um campo salvo.
  insertSearch: db.prepare(
    `INSERT INTO searches (run_id, origin, query, mode, scope_json, stats_json, hits_json)
     VALUES (@run_id, @origin, @query, @mode, @scope_json, @stats_json, @hits_json)`,
  ),
  listSearches: db.prepare(
    `SELECT s.id, s.created_at, s.origin, s.query, s.mode, s.scope_json, s.stats_json,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = s.run_id) spent_usd
       FROM searches s ORDER BY s.id DESC`,
  ),
  getSearch: db.prepare(
    `SELECT s.*,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = s.run_id) spent_usd
       FROM searches s WHERE s.id = ?`,
  ),
  deleteSearch: db.prepare(`DELETE FROM searches WHERE id = ?`),
  clearSearches: db.prepare(`DELETE FROM searches`),
  // só id+hits p/ decidir, ao remover uma fonte, quais buscas ficaram 100% órfãs dela (best-effort)
  listSearchHits: db.prepare(`SELECT id, hits_json FROM searches`),
  // Re-hidratação p/ a TUI/CLI: as MESMAS colunas do toItem da busca (search.js), por ids.
  searchArticlesByIds: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt,
            substr(coalesce(a.content, ''), 1, 400) AS content,
            s.name AS source_name,
            coalesce(iso_date(a.published_at), date(a.extracted_at)) AS date_iso
       FROM articles a
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.id IN (SELECT value FROM json_each(@ids))`,
  ),
  // ---- restore (repovoamento a partir de um snapshot exportado; ver as funções no fim) ----
  // Artigo COMPLETO do snapshot: mesmas colunas do insertArticle + as que o snapshot carrega
  // (title_pt/summary_pt/verify_*). INSERT OR IGNORE: respeita url UNIQUE e content_hash UNIQUE,
  // então re-rodar o restore sobre o mesmo snapshot não duplica nem estoura constraint.
  restoreArticle: db.prepare(
    `INSERT OR IGNORE INTO articles
       (source_id, url, title, title_pt, summary_pt, content, content_hash, published_at, run_id,
        kind, issue_url, section, blurb, content_source, cleaned, needs_enrich,
        verify_status, verify_notes)
     VALUES (@source_id, @url, @title, @title_pt, @summary_pt, @content, @content_hash,
        @published_at, @run_id, @kind, @issue_url, @section, @blurb, @content_source,
        @cleaned, @needs_enrich, @verify_status, @verify_notes)`,
  ),
  // MESMA linha, com o id que o chamador ESCOLHEU (`local_id`, ver restoreArticle — nunca o
  // `id` cru do snapshot). `articles.id` é `INTEGER PRIMARY KEY` (alias
  // de rowid, SEM AUTOINCREMENT), então um id explícito é legal e o próximo id implícito passa a
  // ser max(id)+1 — repor os ids do snapshot não "gasta" nem embaralha a numeração futura.
  // Por que preservar o id: ele é o identificador que o site no ar serve, que a API pública v1
  // promete como estável e que o histórico de buscas re-hidrata (searches.hits_json). Um restore
  // que renumerasse tudo transformaria todo hit salvo em "artigo sumido".
  restoreArticleWithId: db.prepare(
    `INSERT OR IGNORE INTO articles
       (id, source_id, url, title, title_pt, summary_pt, content, content_hash, published_at,
        run_id, kind, issue_url, section, blurb, content_source, cleaned, needs_enrich,
        verify_status, verify_notes)
     VALUES (@id, @source_id, @url, @title, @title_pt, @summary_pt, @content, @content_hash,
        @published_at, @run_id, @kind, @issue_url, @section, @blurb, @content_source,
        @cleaned, @needs_enrich, @verify_status, @verify_notes)`,
  ),
  // Pré-checagem do `local_id` (ver restoreArticle): `INSERT OR IGNORE` engoliria a colisão de
  // PK em silêncio e o chamador acharia que foi dedup por URL.
  getArticleUrlById: db.prepare(`SELECT id, url FROM articles WHERE id = ?`),
  // Piso para alocar ids NOVOS às URLs que só existem em snapshots antigos (ids de snapshot
  // antigo NÃO podem ser reusados: cada wipe reiniciou o rowid em 1 e eles colidem).
  maxArticleId: db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM articles`),
  // O snapshot expõe a fonte só pelo NOME (meta.sources = {id, name, count}; base_url não é
  // exportada), e os ids dele são de OUTRA base — o remapeamento é por nome/base_url.
  getSourceByName: db.prepare(`SELECT * FROM sources WHERE name = ?`),
  getSourceByBaseUrl: db.prepare(`SELECT * FROM sources WHERE base_url = ?`),
  insertSourceByName: db.prepare(
    `INSERT INTO sources (name, base_url, type, max_index_pages)
     VALUES (@name, @base_url, @type, NULL) RETURNING *`,
  ),
  // Só COMPLETA um cadastro que ainda não tinha base_url; nunca sobrescreve a fonte viva.
  fillSourceBaseUrl: db.prepare(
    `UPDATE sources SET base_url = @base_url WHERE id = @id AND base_url IS NULL`,
  ),
  // Marca a URL restaurada como resolvida na frontier — SÓ quando o job foi ABANDONADO
  // ('failed': esgotou MAX_RETRIES). 'pending' e 'in_progress' são TRABALHO VIVO (enfileirado
  // agora / reivindicado agora) e restore NUNCA rebaixa trabalho vivo: derrubar um 'pending'
  // para 'done' cancelaria o enriquecimento que ainda ia rodar E, como 'done'+needs_enrich=1
  // significa RODADA FALHADA (ver bumpFailedEnrichAttempts), cobraria uma das 3 tentativas de um
  // job que nunca rodou. 'done' já é o estado-alvo (o UPDATE não casa; nada a re-escrever).
  // failed -> done é neutro no fluxo de enriquecimento: bumpFailedEnrichAttempts,
  // requeueNeedsEnrichForSource e countEnrichAtCapForSource tratam 'done' e 'failed' igual.
  markFrontierDone: db.prepare(
    `UPDATE frontier SET state = 'done' WHERE url = ? AND state = 'failed'`,
  ),
  // URL restaurada que NÃO tem linha na frontier: nasce direto em 'done' (o conteúdo já está em
  // articles, não há o que buscar). INSERT OR IGNORE => se a linha existir, isto é no-op e quem
  // decide é o markFrontierDone acima.
  insertFrontierDone: db.prepare(
    `INSERT OR IGNORE INTO frontier (url, kind, discovered_from, source_id, depth, discovered_date, state)
     VALUES (?, ?, NULL, ?, 0, NULL, 'done')`,
  ),
  // Página de listagem/issue restaurada: INSERT OR IGNORE (e NÃO o upsertPage) p/ não zerar o
  // html_hash/status de uma página que o crawler já visitou de verdade.
  insertPageIfMissing: db.prepare(
    `INSERT OR IGNORE INTO pages (source_id, url, html_hash, status, pagination_depth, fetched_at)
     VALUES (@source_id, @url, NULL, @status, 0, datetime('now'))`,
  ),
  countArticleTags: db.prepare(`SELECT COUNT(*) c FROM article_tags`),
  countFrontier: db.prepare(`SELECT COUNT(*) c FROM frontier`),

  // settings (chave/valor do banco). value é TEXT: quem lê converte (ver getLegacyFloor).
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ),
  deleteSetting: db.prepare(`DELETE FROM settings WHERE key = ?`),
  // Piso legado = a PRÓXIMA run (MAX(runs.id)+1; 1 numa base sem runs). OR IGNORE: fixado uma vez
  // e nunca "anda" sozinho — senão cada boot empurraria as runs desta era p/ o legado.
  seedLegacyFloor: db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) SELECT ?, COALESCE(MAX(id), 0) + 1 FROM runs`,
  ),
  // pendências por era (status + confirmação do --include-legacy). Use countPendingByEra().
  countPendingByEra: {
    get: (params = {}) =>
      countPendingByEraStmt.get({ floor: Number.isInteger(params.floor) ? params.floor : getLegacyFloor() }),
  },
};

// Boot: semeia o piso legado se ainda não existe. Checa antes p/ não abrir transação de escrita
// a cada processo (o INSERT OR IGNORE sozinho já seria idempotente, mas pega o lock de escrita).
if (!stmts.getSetting.get(LEGACY_FLOOR_KEY)) stmts.seedLegacyFloor.run(LEGACY_FLOOR_KEY);

/**
 * Piso legado vigente (menor run_id que as varreduras processam por padrão). Linha ausente ou
 * ilegível: re-semeia pela MESMA regra do boot (MAX(runs.id)+1 — o lado seguro: na dúvida, o que
 * já existe é legado) e relê; se nem assim, 1. Em qualquer caso o SQL barra run_id NULL.
 */
export function getLegacyFloor() {
  const read = () => {
    const n = Number(stmts.getSetting.get(LEGACY_FLOOR_KEY)?.value);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const v = read();
  if (v != null) return v;
  try {
    stmts.deleteSetting.run(LEGACY_FLOOR_KEY); // valor corrompido não bloqueia o OR IGNORE
    stmts.seedLegacyFloor.run(LEGACY_FLOOR_KEY);
  } catch (e) {
    warn(`piso legado: não consegui re-semear (${e.message}) — usando 1 (run_id NULL segue fora)`);
  }
  return read() ?? 1;
}

/** true = a linha é do acervo LEGADO (run_id NULL ou anterior ao piso): fora do pós-processamento pago. */
export function isLegacyRow(row, floor = getLegacyFloor()) {
  const id = row?.run_id;
  return id == null || !(Number(id) >= floor);
}

/**
 * Pendências de pós-processamento por era, prontas p/ exibir: `jev` = o que as varreduras
 * processam por padrão; `legacy` = o que o piso deixa de fora (só entra com --include-legacy).
 * Retorna { floor, total, summaries, jev: {articles, verify, summary, classify, suspect}, legacy: {…} }.
 */
export function countPendingByEra() {
  const floor = getLegacyFloor();
  const r = stmts.countPendingByEra.get({ floor });
  return {
    floor,
    total: r.total,
    summaries: r.total - r.no_summary,
    jev: {
      articles: r.jev_articles,
      verify: r.jev_verify,
      summary: r.jev_summary,
      classify: r.jev_classify,
      suspect: r.jev_suspect,
    },
    legacy: {
      articles: r.total - r.jev_articles,
      verify: r.no_verify - r.jev_verify,
      summary: r.no_summary - r.jev_summary,
      classify: r.no_classify - r.jev_classify,
      suspect: r.suspect - r.jev_suspect,
    },
  };
}

// Statements da busca vetorial: só quando o sqlite-vec carregou (senão referenciariam uma tabela
// inexistente). rowid = articles.id (BigInt no bind — o vec0 exige inteiro); embedding = BLOB float32.
if (VEC_OK) {
  Object.assign(stmts, {
    insertVec: db.prepare(`INSERT INTO articles_vec(rowid, embedding) VALUES (?, ?)`),
    deleteVec: db.prepare(`DELETE FROM articles_vec WHERE rowid = ?`),
    knnVec: db.prepare(
      `SELECT rowid AS id, distance FROM articles_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    ),
    countVec: db.prepare(`SELECT COUNT(*) AS c FROM articles_vec`),
    articlesMissingVec: db.prepare(
      `SELECT a.id, a.title, a.title_pt, a.summary_pt,
              substr(coalesce(a.content, ''), 1, 2000) AS content_head
         FROM articles a
        WHERE a.id NOT IN (SELECT rowid FROM articles_vec)
        ORDER BY a.id LIMIT ?`,
    ),
  });
}

// Limpeza total (slate limpo). Ordem filho->pai porque foreign_keys=ON. VACUUM fora da
// transação p/ recuperar espaço do arquivo/WAL. Opera no DB de DB_PATH (respeita o override).
// BACKUP: nada aqui precisa mudar p/ o `reset` salvar a base antes de apagar — wipeAll é uma
// função exportada SEM argumentos e o chamador (commands.js) roda o backup ANTES de invocá-la.
// O material do backup também já está exposto: `db` (better-sqlite3 tem db.backup(destino)) e
// DB_PATH (config.js). Ver src/backup.js.
export function wipeAll() {
  const tables = [
    'searches',
    'article_tags',
    'classification_uncovered',
    'classifications',
    'articles',
    'pages',
    'selectors',
    'frontier',
    'events',
    'jev_decisions',
    'llm_usage',
    'runs',
    'sources',
  ];
  const tx = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    // Piso legado: com `runs` zerada o rowid RECOMEÇA em 1 (sem AUTOINCREMENT). Um piso antigo
    // (ex.: 51) jogaria as runs 1..50 do recomeço no "legado" e as varreduras parariam de
    // processar o que é novo. Re-semeia na base vazia (=> 1); `settings` em si não é acervo.
    stmts.deleteSetting.run(LEGACY_FLOOR_KEY);
    stmts.seedLegacyFloor.run(LEGACY_FLOOR_KEY);
  });
  tx();
  db.exec('VACUUM');
}

/**
 * PURGE dos dados de UMA fonte — a fonte CONTINUA cadastrada (é o que difere do removeSource).
 * Apaga articles (+ cascatas de FK/trigger p/ classifications/article_tags/
 * classification_uncovered/FTS/vec), pages, frontier, events e, com `selectors:true`, o cache de
 * seletores do host.
 * TUDO numa transação: eram quatro `.run()` SOLTOS no commands.js e uma falha no meio (disco
 * cheio, SQLITE_BUSY, FK) deixava a fonte pela METADE — artigos apagados e frontier intacta, por
 * exemplo, que é o pior estado possível ("apague e refaça" deixa de ser reprodutível). O
 * `removeSource` logo abaixo já era transacional; o purge agora tem a mesma garantia.
 * Retorna as contagens apagadas, ou null se a fonte não existe. Um erro no meio faz ROLLBACK e
 * PROPAGA (nada foi apagado) — quem chama decide o que dizer ao usuário.
 */
export function purgeSource(sourceId, { selectors = false } = {}) {
  const src = stmts.getSourceById.get(sourceId);
  if (!src) return null;
  // selectors são por HOST (template_sig "host:…"): resolvido FORA da transação (leitura pura).
  const host = selectors ? hostOf(src.base_url) : null;
  const counts = {};
  const tx = db.transaction(() => {
    counts.articles = stmts.deleteArticlesBySource.run(sourceId).changes;
    counts.pages = stmts.deletePagesBySource.run(sourceId).changes;
    counts.frontier = stmts.deleteFrontierBySource.run(sourceId).changes;
    counts.events = stmts.deleteEventsBySource.run(sourceId).changes;
    if (selectors) counts.selectors = host ? stmts.deleteSelectorsLike.run(`${host}:%`).changes : 0;
    // Cursor ZERADO na mesma transação: a fonte segue cadastrada (purge não descadastra) e a
    // recaptura do zero NÃO pode ser pulada pelo piso da captura anterior.
    stmts.resetSourceCursor.run(sourceId);
  });
  tx();
  return counts;
}

/**
 * Remoção COMPLETA de UMA fonte (descadastra de vez, o que o purge NÃO faz). Numa transação:
 * apaga os DADOS (articles + cascatas de FK/trigger p/ classifications/article_tags/
 * classification_uncovered/FTS/vec; pages, frontier, events), limpa o histórico de buscas
 * "ligado" (best-effort: buscas cujos hits são TODOS artigos desta fonte — uma busca multi-fonte
 * sobrevive e seus hits sumidos já são tratados como "missing"), derruba os selectors do host SÓ
 * se nenhuma OUTRA fonte usa o host (podem ser compartilhados), e por fim a linha `sources`
 * (por último — articles/pages têm FK p/ sources). NÃO mexe no sources.json (o chamador faz isso).
 * Retorna { source, counts } ou null se a fonte não existe.
 */
export function removeSource(sourceId) {
  const src = stmts.getSourceById.get(sourceId);
  if (!src) return null;

  // Buscas 100% desta fonte: decididas ANTES de apagar os artigos (depois os ids somem).
  const articleIds = new Set(stmts.listSourceArticleIds.all(sourceId).map((r) => r.id));
  const searchIdsToDelete = [];
  if (articleIds.size) {
    for (const row of stmts.listSearchHits.all()) {
      let hits;
      try {
        hits = JSON.parse(row.hits_json || '[]');
      } catch {
        hits = [];
      }
      if (Array.isArray(hits) && hits.length && hits.every((h) => articleIds.has(h?.id))) {
        searchIdsToDelete.push(row.id);
      }
    }
  }

  // selectors são por HOST (template_sig "host:…") e podem ser compartilhados por outra fonte.
  const host = hostOf(src.base_url);
  const shared =
    host && stmts.listSources.all().some((s) => s.id !== sourceId && hostOf(s.base_url) === host);

  const counts = {};
  const tx = db.transaction(() => {
    counts.articles = stmts.deleteArticlesBySource.run(sourceId).changes;
    counts.pages = stmts.deletePagesBySource.run(sourceId).changes;
    counts.frontier = stmts.deleteFrontierBySource.run(sourceId).changes;
    counts.events = stmts.deleteEventsBySource.run(sourceId).changes;
    counts.searches = 0;
    for (const id of searchIdsToDelete) counts.searches += stmts.deleteSearch.run(id).changes;
    counts.selectors = !shared && host ? stmts.deleteSelectorsLike.run(`${host}:%`).changes : 0;
    counts.sources = stmts.deleteSourceById.run(sourceId).changes;
  });
  tx();
  return { source: src, counts };
}


// ---- restore: repovoamento do SQLite a partir de um snapshot exportado ----
// A BASE DE REGISTRO passou a ser o snapshot versionado em git (webapp/public/data): um `reset`
// acidental não pode mais significar "recomeçar do zero". Além das linhas de `articles`, o
// restore repõe a frontier (markUrlDone) e as `pages` das issues (restorePage) — para o acervo
// voltar a casar em `isUrlKnown`, a parada determinística de paginação.
//
// O QUE ISSO **NÃO** É. O `isUrlKnown` já não era a única defesa contra re-caminhar o arquivo:
// `crawlArchive` para com `added === 0` (crawl.js) assim que uma página não rende link novo, e
// `enqueue` é INSERT OR IGNORE. O ganho do restore é ANTECIPAR essa parada (antes do upsertPage
// e do dateSeen/floorHit) e sobreviver a uma frontier apagada — não é a diferença entre "para" e
// "caminha 600 issues".
//
// `issue_url` NO SNAPSHOT: o CÓDIGO está completo desde 7ab2080 — `stmts.webExportArticles`
// seleciona `a.issue_url, a.blurb`, `src/export-web.js` os grava em articles.json,
// `src/export-api.js` os publica como `issueUrl`/`blurb` na API v1, e `src/restore.js` alimenta
// com eles o `restorePage` (mapa issue_url -> source_id) e o 4º ramo do `isUrlKnown`.
// O QUE FALTA É DADO, NÃO CÓDIGO: o `webapp/public/data/articles.json` COMMITADO hoje foi gerado
// pelo exportador ANTIGO (`grep -c '"issue_url"'` = 0 em 13.758 artigos), e os `issue_url`
// históricos morreram junto com o banco antigo. Efeito MEDIDO numa restauração real: pós-restore
// o `isUrlKnown` reconhece 100% das 15.502 URLs de ARTIGO e 0 de 747 URLs de ISSUE — a 1ª coleta
// re-percorre e re-cura por IA ~745 issues (a fase mais cara). MITIGAÇÃO da 1ª coleta pós-restore:
// rode com `--since <data recente>` (o piso de data para a paginação do índice antes de descer no
// arquivo antigo) e/ou `--max-pages 1`. O buraco se fecha sozinho: todo export novo já carrega
// `issue_url`, então cada crawl+deploy devolve a proveniência das issues ao snapshot.
//
// Todas as funções são IDEMPOTENTES (INSERT OR IGNORE em toda escrita) e nenhuma sobrescreve
// dado vivo: restore repõe o que falta, não substitui o que já existe — a única escrita sobre
// linha PRÉ-EXISTENTE é `markUrlDone` promovendo frontier 'failed' -> 'done' (ver a função).

// Um `source_id` que não existe em `sources` violaria a FK e derrubaria o restore no meio
// (`OR IGNORE` não cobre FK em SQLite). Pré-checagem determinística: null/ausente é legal (a FK
// aceita NULL), id desconhecido é recusado ANTES do INSERT.
function sourceExists(sourceId) {
  if (sourceId === null || sourceId === undefined) return true;
  return Boolean(stmts.getSourceById.get(sourceId));
}

/**
 * Insere UM artigo completo vindo do snapshot. `row` traz os campos exportados por
 * `webExportArticles` (title/title_pt/summary_pt/date_iso/kind/section/verify_status/
 * verify_notes) mais `content` (texto puro, do map id->content de contents.json) e o
 * `source_id` JÁ REMAPEADO p/ o id local (ver restoreSourceByName — os ids do snapshot são de
 * outra base e não podem ser confiados).
 * `date_iso` -> `published_at` (o snapshot já resolveu o coalesce published_at/extracted_at, e
 * gravar em published_at preserva a data efetiva do card). `content_source = 'restore'`,
 * `needs_enrich = 0` (o corpo já veio), `cleaned = 1` (foi limpo antes de ser exportado).
 * O content_hash é o MESMO sha256(content) que crawl.js/curate.js gravam — é o que faz a dedup
 * por conteúdo do próximo crawl reconhecer o material restaurado. Conteúdo VAZIO grava hash NULL
 * (sha256('') é constante e colidiria no índice UNIQUE entre todos os artigos sem corpo).
 *
 * CONTRATO DO source_id (a linha é PULADA, nunca lançada): `articles.source_id` tem FK para
 * `sources` e `OR IGNORE` NÃO cobre violação de FK em SQLite — um id inexistente lançava
 * SQLITE_CONSTRAINT_FOREIGNKEY e derrubava o restore no MEIO, deixando a base pela metade (o
 * pior desfecho possível num comando de recuperação). Agora um `source_id` que não existe em
 * `sources` é detectado ANTES do INSERT (SELECT determinístico, mesmo veredito a cada chamada) e
 * a linha é ignorada com `reason: 'bad-source'`; o chamador soma e reporta, o operador corrige o
 * mapeamento e re-roda (restore é idempotente, então a 2ª passada preenche o que faltou).
 * `source_id` null/ausente é LEGAL (a FK aceita NULL) e insere normalmente — artigo sem fonte
 * atribuída, que é o que o snapshot produz quando a fonte não pôde ser remapeada.
 *
 * `local_id` (opcional, ADITIVO — omitir mantém o comportamento antigo de deixar o SQLite
 * numerar): o id que o CHAMADOR decidiu usar nesta base. NÃO é o `row.id` do snapshot, que
 * continua IGNORADO de propósito — os ids do snapshot não são estáveis no histórico (cada wipe
 * reiniciou o rowid em 1) e confiar neles cegamente misturaria artigos. Quem preserva ids é
 * quem já resolveu a identidade por URL e sabe qual snapshot é autoritativo (src/restore.js);
 * o campo separado torna isso uma decisão EXPLÍCITA, nunca um efeito colateral de repassar a
 * linha do snapshot.
 * A colisão é checada ANTES do INSERT: `local_id` já ocupado por OUTRA URL devolve
 * `reason:'id-taken'` sem escrever nada (o `INSERT OR IGNORE` engoliria a violação de PK e o
 * chamador acharia que tinha sido dedup por URL); ocupado pela MESMA URL é a 2ª passada
 * idempotente ('url').
 *
 * Retorna { inserted, id, reason }: reason 'url'/'hash' diz por que foi ignorado (linha já
 * existente pela URL ou pelo conteúdo), com o `id` da linha que já estava lá; 'bad-source' =
 * fonte inexistente; 'id-taken' = `local_id` já é de outra URL; 'no-url' = linha sem URL.
 */
export function restoreArticle(row) {
  const url = normalizeUrl(row?.url) || row?.url || null;
  if (!url) return { inserted: false, id: null, reason: 'no-url' };
  if (!sourceExists(row.source_id)) return { inserted: false, id: null, reason: 'bad-source' };
  const wantId = Number.isInteger(row?.local_id) && row.local_id > 0 ? row.local_id : null;
  if (wantId !== null) {
    const taken = stmts.getArticleUrlById.get(wantId);
    if (taken) {
      return taken.url === url
        ? { inserted: false, id: taken.id, reason: 'url' }
        : { inserted: false, id: null, reason: 'id-taken' };
    }
  }
  const content = typeof row.content === 'string' ? row.content : '';
  const contentHash = content ? sha256(content) : null;
  const stmt = wantId !== null ? stmts.restoreArticleWithId : stmts.restoreArticle;
  const res = stmt.run({
    ...(wantId !== null ? { id: wantId } : {}),
    source_id: row.source_id ?? null,
    url,
    title: row.title ?? url,
    title_pt: row.title_pt ?? null,
    summary_pt: row.summary_pt ?? null,
    content,
    content_hash: contentHash,
    published_at: row.published_at ?? row.date_iso ?? null,
    run_id: row.run_id ?? null,
    kind: row.kind ?? null,
    issue_url: row.issue_url ?? null,
    section: row.section ?? null,
    blurb: row.blurb ?? null,
    content_source: 'restore',
    cleaned: 1,
    needs_enrich: 0,
    verify_status: row.verify_status ?? null,
    verify_notes: row.verify_notes ?? null,
  });
  if (res.changes > 0) return { inserted: true, id: Number(res.lastInsertRowid), reason: null };
  const byUrl = stmts.getArticleByUrl.get(url);
  if (byUrl) return { inserted: false, id: byUrl.id, reason: 'url' };
  const byHash = contentHash ? stmts.getArticleByHash.get(contentHash) : null;
  return { inserted: false, id: byHash?.id ?? null, reason: byHash ? 'hash' : 'ignored' };
}

/**
 * Resolve (ou cria) a fonte local correspondente a uma fonte do snapshot e devolve o ID LOCAL,
 * p/ o restore remapear `articles.source_id`. Ordem de casamento: base_url (quando o chamador a
 * conhece, ex.: pelo sources.json) -> nome exato -> cria. NUNCA sobrescreve um cadastro
 * existente (só completa um base_url ausente): a fonte viva é a autoridade.
 * O snapshot não exporta base_url, então `baseUrl` costuma vir null e a fonte criada fica só
 * como rótulo (o crawl é semeado pelo sources.json, não pela tabela `sources`).
 * Retorna { id, created, source }.
 */
export function restoreSourceByName(name, baseUrl = null, type = null) {
  const nm = String(name ?? '').trim();
  const base = baseUrl ? normalizeUrl(baseUrl) || baseUrl : null;
  if (base) {
    const byUrl = stmts.getSourceByBaseUrl.get(base);
    if (byUrl) return { id: byUrl.id, created: false, source: byUrl };
  }
  if (nm) {
    const byName = stmts.getSourceByName.get(nm);
    if (byName) {
      if (base && !byName.base_url) stmts.fillSourceBaseUrl.run({ id: byName.id, base_url: base });
      return { id: byName.id, created: false, source: stmts.getSourceById.get(byName.id) };
    }
  }
  if (base) {
    const row = stmts.upsertSource.get({
      name: nm || hostOf(base) || base,
      base_url: base,
      type: type || 'listing',
      max_index_pages: null,
    });
    return { id: row.id, created: true, source: row };
  }
  const row = stmts.insertSourceByName.get({ name: nm || null, base_url: null, type: type || 'listing' });
  return { id: row.id, created: true, source: row };
}

/**
 * Grava as tags do snapshot ({faceta: [tag, ...]}, o mesmo shape que classify.js persiste) no
 * índice `article_tags`, com `rank` = posição dentro da faceta. INSERT OR IGNORE sobre a PK
 * (article_id, facet, tag): idempotente e ADITIVO — nunca apaga tags existentes (ao contrário do
 * classify, que faz delete+insert; ali a classificação nova é a autoridade, aqui não).
 *
 * `classifications` NÃO é escrita por padrão. O snapshot só carrega as tags: confidences,
 * uncovered, domain_confidence, taxonomy_version e model_used não existem nele, e uma linha
 * inventada seria indistinguível de uma classificação real. Sem a linha, as tags ficam válidas
 * p/ busca/browse e `listArticlesNeedingClassification` o torna ELEGÍVEL — mas o artigo
 * restaurado tem run_id NULL, então o piso legado o deixa fora da varredura padrão: só um
 * `finish --include-legacy --yes` refaz a classificação COMPLETA (custa LLM; o dado fica íntegro).
 * `markClassified: true` inverte o trade-off: grava a linha com `status = 'restored'` e
 * `model_used = 'restore'` (rótulos EXPLÍCITOS, nunca 'done'/um modelo real) p/ o sweep não
 * re-classificar o acervo restaurado inteiro.
 * Mesmo assim só insere se ainda NÃO houver classificação — nunca rebaixa uma real.
 * Retorna { tags, classification }.
 */
export function restoreTags(articleId, tagsByFacet, { markClassified = false } = {}) {
  if (!articleId || !tagsByFacet || typeof tagsByFacet !== 'object') {
    return { tags: 0, classification: false };
  }
  let tags = 0;
  let classification = false;
  const facets = {};
  const tx = db.transaction(() => {
    for (const [facet, list] of Object.entries(tagsByFacet)) {
      if (!Array.isArray(list)) continue;
      const clean = [];
      for (const t of list) {
        const tag = t == null ? '' : String(t);
        if (!tag) continue;
        tags += stmts.insertTag.run({ article_id: articleId, facet, tag, rank: clean.length }).changes;
        clean.push(tag);
      }
      facets[facet] = clean;
    }
    if (markClassified && !stmts.getClassification.get(articleId)) {
      stmts.upsertClassification.run({
        article_id: articleId,
        result_json: JSON.stringify({
          facets,
          confidences: {},
          uncovered: [],
          domain_confidence: null,
          taxonomy_version: null,
          status: 'restored',
        }),
        domain_confidence: null,
        taxonomy_version: null,
        model_used: 'restore',
        status: 'restored',
      });
      classification = true;
    }
  });
  tx();
  return { tags, classification };
}

/**
 * Registra na frontier, como RESOLVIDA ('done'), uma URL cujo conteúdo veio do snapshot. Faz a
 * URL casar no 3º ramo do `isUrlKnown` mesmo quando a linha de `articles` não existe (ex.: o
 * artigo foi ignorado por dedup de content_hash) — quando ela existe, o 1º ramo já casaria
 * sozinho e esta função é só higiene da fila.
 *
 * NÃO REBAIXA TRABALHO VIVO. Só há dois desfechos de escrita:
 *   - URL sem linha na frontier -> cria a linha JÁ em 'done';
 *   - linha em 'failed' (job abandonado após MAX_RETRIES) -> vira 'done'.
 * 'pending' (na fila desta run) e 'in_progress' (reivindicado agora, possivelmente por outro
 * processo) ficam INTOCADOS: derrubá-los para 'done' cancelaria um enriquecimento que ainda ia
 * rodar e, pior, cobraria uma tentativa fantasma — 'done' + needs_enrich=1 é contado como RODADA
 * FALHADA por `bumpFailedEnrichAttempts`, então um restore por cima de uma base viva queimaria
 * uma das ENRICH_MAX_ATTEMPTS de um job que nunca rodou. 'done' já é o alvo (no-op).
 * O `failed -> done` é neutro nesse mesmo contador: bump/requeue/countAtCap tratam os dois igual.
 *
 * Retorna { url, created, marked } — `created` = a linha nasceu aqui (já em 'done'), `marked` =
 * esta chamada mudou o estado de uma linha que já existia. Idempotente: a 2ª chamada devolve
 * ambos false.
 */
export function markUrlDone(url, kind = 'article', sourceId = null) {
  const n = normalizeUrl(url) || url || null;
  if (!n) return { url: null, created: false, marked: false };
  const ins = stmts.insertFrontierDone.run(n, kind || 'article', sourceId ?? null);
  if (ins.changes > 0) return { url: n, created: true, marked: true };
  return { url: n, created: false, marked: stmts.markFrontierDone.run(n).changes > 0 };
}

/**
 * Registra a URL de uma listagem/issue restaurada em `pages` — o 2º ramo do `isUrlKnown`.
 * INSERT OR IGNORE: uma página que o crawler já visitou de verdade mantém html_hash/status.
 *
 * O QUE ELA **NÃO** GARANTE. (1) Nada aqui impede uma issue de ser re-curada: a curadoria é
 * decidida pelo job de roundup em crawl.js/curate.js, que não consulta `pages`; o efeito desta
 * função é só fazer a URL contar como conhecida na varredura de links da paginação.
 * (2) Ela só rende o que o snapshot trouxer: o export JÁ carrega `issue_url` (src/export-web.js) e
 * o src/restore.js a chama uma vez por issue distinta, mas o `articles.json` COMMITADO hoje foi
 * gerado pelo exportador antigo e não tem o campo — restaurar dele repõe 0 `pages` (ver o
 * cabeçalho do bloco: 747 issues ficaram desconhecidas na restauração real). Cada crawl+deploy
 * novo devolve a proveniência ao snapshot.
 *
 * `source_id` desconhecido é PULADO (mesmo contrato de restoreArticle: FK violada derrubaria o
 * restore no meio); null é legal. Retorna true SÓ quando criou a linha — false = já existia ou
 * fonte desconhecida.
 */
export function restorePage(url, sourceId = null) {
  const n = normalizeUrl(url) || url || null;
  if (!n || !sourceExists(sourceId)) return false;
  return (
    stmts.insertPageIfMissing.run({
      source_id: sourceId ?? null,
      url: n,
      status: 'restored',
    }).changes > 0
  );
}

/** Total de artigos no acervo (relatório antes/depois do restore). */
export function countArticles() {
  return stmts.countArticles.get().c;
}

/**
 * Fotografia das contagens que o restore reporta (antes/depois). Reusa os stmts de `stats` já
 * existentes; `frontier` vem quebrada por estado (o que mostra quanto virou território conhecido).
 */
export function restoreCounts() {
  const frontier = { total: stmts.countFrontier.get().c };
  for (const r of stmts.countFrontierByState.all()) frontier[r.state] = r.c;
  return {
    articles: stmts.countArticles.get().c,
    sources: stmts.countSources.get().c,
    pages: stmts.countPages.get().c,
    tags: stmts.countArticleTags.get().c,
    classifications: stmts.countClassifications.get().c,
    frontier,
  };
}
