// Utilitários puros (sem dependência dos módulos de fetch/db, para evitar ciclos).
import crypto from 'node:crypto';
import { openSync, writeSync, closeSync, mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import normalizeUrlLib from 'normalize-url';

/** Normaliza e absolutiza uma URL; retorna null se inválida. */
export function normalizeUrl(u, base) {
  if (!u) return null;
  try {
    const abs = base ? new URL(u, base).href : new URL(u).href;
    return normalizeUrlLib(abs, {
      // NÃO remover "www.": www.host e host podem ser servidores DIFERENTES — vários Substack de
      // domínio próprio (ex.: www.deeplearningweekly.com) NÃO têm DNS no ápice, então colapsar
      // www->ápice gera URL morta (ENOTFOUND). hostOf/domainSig já preservam o www; isto alinha.
      stripWWW: false,
      stripHash: true,
      removeQueryParameters: [/^utm_/i, 'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      sortQueryParameters: true,
      removeTrailingSlash: true,
    });
  } catch {
    return null;
  }
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

/**
 * A URL é plausível como ALVO real? (defensivo; nunca lança). Complementa o normalizeUrl, que
 * aceita o que o `new URL()` aceita — incluindo os placeholders de truncamento que o LLM da
 * curadoria fabrica a partir do texto do agregador ("github.com/...", "x.com/…", "https://..").
 * Medido 2026-10-10: 32 artigos PUBLICADOS com URL terminada em `/...` (ex.: `https://github.com/...`)
 * + 31 jobs de frontier — o `new URL()` engole todos. Regras (anti falso-positivo):
 *   - hostname de verdade: ≥1 ponto + TLD alfabético (rejeita `..`, `...`, host sem ponto);
 *   - path/search NÃO termina em `/...` (ou `/…`) nem contém o segmento `...` (placeholder);
 *   - sem caracteres de HTML/espaço colados.
 * Uma URL legítima com "..." no MEIO de um slug passa (só o placeholder é rejeitado).
 */
export function isPlausibleUrl(url) {
  const s = String(url || '').trim();
  if (!s || s.length > 2048) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i.test(u.hostname)) return false;
  // Path DECODIFICADO: a URL codifica "…" (%E2%80%A6) e o placeholder tem de ser apanhado nas
  // duas formas. Segmento `/...` (ou `/…`) em qualquer posição = placeholder do agregador;
  // reticências no MEIO de um slug ("a...b") continuam legítimas.
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch { /* path mal-codificado: segue com o cru */ }
  if (/\/\.\.\.|\/\u2026/.test(p)) return false;
  if (/[<>"]|\s/.test(s)) return false;
  return true;
}

/**
 * Traduz uma string de data (Readability/LLM/JSON-LD) para um Date iterável/comparável.
 * Cobre ISO-8601 (com Z, offset, ou milissegundos) e date-only (YYYY-MM-DD -> meia-noite UTC).
 * Defensivo: null/vazio/inválido -> null (nunca lança), p/ uma data ruim não derrubar o crawl.
 */
export function parseDate(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Tolerância p/ fuso: um boletim publicado "amanhã" em UTC+13 é legítimo; 2 dias à frente, não.
const FUTURE_DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Trava de data no FUTURO, aplicada na COLETA (antes de gravar published_at). Extração errada de
 * data (JSON-LD de "próxima edição", regex pegando o ano errado) cravava o item no topo do site
 * para sempre — ordenamos por data. Passou de hoje + 1 dia? grava a data de hoje (YYYY-MM-DD).
 * Data inparseável ou dentro do prazo volta INTACTA: published_at é string crua do scrape e quem
 * normaliza é o iso_date do db.js.
 */
export function clampFutureDate(raw, now = new Date()) {
  const d = parseDate(raw);
  if (!d) return raw;
  return d.getTime() > now.getTime() + FUTURE_DATE_TOLERANCE_MS ? now.toISOString().slice(0, 10) : raw;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Espera baseMs com jitter de 0.5x–1.5x para cortesia anti-bot. */
export async function jitterDelay(baseMs) {
  if (!baseMs) return;
  await sleep(Math.floor(baseMs * (0.5 + Math.random())));
}

export function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

/** Assinatura de template: host + tipo de página (chave do cache de seletores).
 * Artigo: 1 template de conteúdo por host. Listagem: inclui um "template" de caminho p/
 * separar arquivos multinível no mesmo host (ex.: /issues vs /issues/<slug>) — segmentos
 * dinâmicos (com dígito ou muito longos, tipo slugs) viram `*`. */
export function domainSig(u, kind = 'listing') {
  const host = hostOf(u);
  if (kind === 'article') return `${host}:article`;
  let pathTpl = '';
  try {
    const segs = new URL(u).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => (/\d/.test(s) || s.length > 24 ? '*' : s));
    pathTpl = '/' + segs.slice(0, 2).join('/');
  } catch {
    pathTpl = '';
  }
  return `${host}:${kind}:${pathTpl}`;
}

export function slugify(s) {
  return (
    (s || 'untitled')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

/** Fold p/ busca textual local: minúsculas + sem acentos (NFKD). O lower()/LIKE do SQLite só
 * dobram ASCII, então o buscador web registra isto como função SQL (db.js) e aplica o MESMO
 * fold à consulta, casando "Época" com "epoca". */
export function foldText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

// ---- detecção de texto CJK (chinês/japonês/coreano) ----
// Usada pela guarda de idioma do stage summarize: title_pt/summary_pt são PT-BR e o Flash às
// vezes responde no idioma do ARTIGO (captura 2026-08-14: 11/188 resumos em chinês). Cobre Han
// (U+3400–U+4DBF ext. A, U+4E00–U+9FFF unificado, U+F900–U+FAFF compat.), hiragana+katakana
// (U+3040–U+30FF) e hangeul (U+AC00–U+D7AF) — todos BMP, 1 code unit cada.
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/;

/** True se a string contém QUALQUER caractere CJK (Han/hiragana/katakana/hangeul). */
export function hasCjk(s) {
  return CJK_RE.test(String(s ?? ''));
}

/** Razão de caracteres CJK sobre o total (0..1); 0 para string vazia/sem CJK. */
export function cjkRatio(s) {
  const t = String(s ?? '');
  const m = t.match(/[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/g); // /g: conta TODAS as ocorrências
  return m ? m.length / t.length : 0;
}

// ---- idioma + legibilidade da camada de LEITURA (title_pt/summary_pt) ----
// A camada de leitura tem de ser SEMPRE PT-BR e legível (regra do produto, 2026-10-10). O guarda
// antigo só apanhava CJK — resumos em inglês/lixo passavam (medido: 15 em EN + ~70 duvidosos).
const PT_MARKERS = new Set(
  ('de da do das dos em no na nos nas um uma uns umas que não e ou para por com sem ser está foi são ' +
    'como mais muito também já quando onde qual pelo pela entre sobre isto isso seu sua seus suas ' +
    'mas se ao aos à às num numa até desde depois antes durante pode podem deve devem tem têm ' +
    'será serão apenas ainda só novo nova novos novas versão recurso recursos').split(' '),
);
const EN_MARKERS = new Set(
  ('the and of to in is for on with that are was be this from as at by or an it not you can has have ' +
    'will its their his her they we our your which when what where there been were would should').split(' '),
);

/**
 * O texto LÊ-SE como português? Heurística por palavras-marca (PT × EN), LENIENTE com textos
 * curtos/neutros (menos de 3 marcas = true; indecidível não reprova). Para o guarda de idioma do
 * summarize e a varredura de reparação — nunca lança. Código/identificadores técnicos NÃO contam
 * p/ o idioma: PRs de Rust/Clippy trazem texto PT cheio de identificadores EN (`manual_is_variant_and`,
 * `map_or`, `for _ in 0..n`) e o guarda marcava resumos PERFEITOS como "fora do PT-BR" (9 fichas
 * presas por isto, medido 2026-10-15) — spans de código e identificadores saem antes da contagem.
 */
export function looksPortuguese(text) {
  const semCodigo = String(text ?? '')
    .replace(/`[^`\n]{1,200}`/g, ' ') // spans de código em backticks
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+/g, ' ') // caminhos Rust/C++ (From::from)
    .replace(/\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b/g, ' ') // snake_case (identificador)
    .replace(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, ' '); // camelCase (identificador)
  const words = semCodigo.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
  const marked = words.filter((w) => PT_MARKERS.has(w) || EN_MARKERS.has(w));
  if (marked.length < 3) return true; // curto/neutro: indecidível => não reprova
  const pt = words.filter((w) => PT_MARKERS.has(w)).length;
  const en = words.filter((w) => EN_MARKERS.has(w)).length;
  return pt >= en; // empate favorece o PT (nomes de produto em inglês são normais num resumo PT)
}

/**
 * Remove o que NÃO é texto de leitura: tags HTML estruturais, entidades, markdown-link solto
 * (`[texto](url)` fica só `texto`) e espaços em excesso. O que é citação de código em backticks
 * (`<T>`, `<div>`) FICA — é conteúdo, não lixo. Determinístico e idempotente.
 */
export function stripDisplayJunk(text) {
  let s = String(text ?? '');
  if (!s) return s;
  // Citações de código entre backticks ficam INTACTAS (`<T>`, `<div>` são conteúdo): protegidas
  // com placeholders e repostas no fim.
  const codeSpans = [];
  s = s.replace(/`[^`\n]{1,200}`/g, (m) => {
    codeSpans.push(m);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]\n]{1,200})\]\(https?:\/\/[^)\s]{1,400}\)/g, '$1'); // [texto](url) -> texto
  s = s.replace(/<\/?(?:div|p|br|span|a|img|ul|ol|li|table|tr|td|th|section|article|header|footer|nav|h[1-6]|strong|em|i|b)\b[^>]{0,300}>/gi, ' ');
  // Entidades HTML: os NOMES vêm por CONCATENAÇÃO p/ o código-fonte nunca conter o padrão crua.
  const ENT_MAP = {
    amp: String.fromCharCode(38), nbsp: ' ', quot: String.fromCharCode(34),
    lt: String.fromCharCode(60), gt: String.fromCharCode(62),
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  };
  s = s.replace(/&(#[0-9a-fx]{1,8}|[a-z]{2,10});/gi, (m, name) => {
    if (name[0] === '#') {
      const c = Number(name[1] === 'x' || name[1] === 'X' ? '0' + name.slice(1) : name.slice(1));
      return Number.isFinite(c) && c >= 32 && c <= 0x10ffff ? String.fromCodePoint(c) : ' ';
    }
    return ENT_MAP[name.toLowerCase()] ?? ' ';
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codeSpans[Number(i)]);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * O texto é uma RECUSA/meta-texto sobre a TAREFA em vez de conteúdo? Os modelos de extração e de
 * resumo escrevem desculpas quando lhes chega página vazia/interstitial/sem corpo ("Artigo não
 * fornecido", "Não foi possível extrair o conteúdo porque o texto do artigo não foi fornecido.",
 * "…é uma mensagem de verificação de página web") — e elas JÁ viveram como `content`/`title_pt`/
 * `summary_pt` no acervo (medido 2026-10-15: 259 fichas). REGRA ÚNICA do runtime: os guards do
 * crawl/summarize e o script de reparação usam ESTA função, nunca uma regex paralela.
 * Olha para o COMEÇO do texto (uma recusa é o texto todo; um resumo legítimo só mencionaria
 * "não fornecido" pelo meio). Duas portas: frases-fechadas de recusa OU sujeito+negação com
 * menção do que FALTA (o triplo crivo que impede "O resumo não pode ser produzido sem colaboração
 * dos editores" — notícia legítima — casar). Nunca lança.
 */
const REFUSAL_STANDALONE = [
  // forma fechada: "<Erro:> <Nenhum> artigo [não] [foi] fornecido[. | para …]" — o verbo da falta
  // logo após o sujeito. O lookahead impede a construção NOMINAL legítima "O artigo fornecido
  // PELO autor foi bem recebido" (o que vem depois distingue: recusa segue com fim/para/por favor).
  '^\\W*(erro\\s*[:\\u2014-]\\s*)?((nenhum|nenhuma|o|um|uma|este|esta)\\s+)?' +
    '(artigo|conte[uú]do|texto|resumo)(\\s+\\S+){0,2}\\s+(n[aã]o\\s+)?(foi\\s+)?fornecid' +
    '\\w*\\b(?!\\s+(pelo|pela|pelo menos|por (um|uma|o|a|n[óo]s)))',
  // "Não foi fornecido o artigo para tradução…" — a negação vem ANTES do objeto (objeto exigido:
  // uma notícia "Não foi fornecido um parecer sobre o caso" NÃO casa)
  '^\\W*n[aã]o (foi )?fornecid\\w*\\s+((o|um|o pr[oó]prio|a)\\s+)?(artigo|conte[uú]do|texto|resumo|tradu[cç][aã]o)',
  // "Não recebi/tenho o artigo…" — pedido de material
  '^\\W*n[aã]o (recebi|tenho|encontrei|possuo)\\s+((o|um|o pr[oó]prio)\\s+)?(artigo|conte[uú]do|texto|resumo)',
  // outras desculpas/infra-estrutura de prompt que já viveram no acervo
  'n[aã]o (h[aá] )?(conte[uú]do|texto|artigo) dispon[ií]vel',
  'n[aã]o (forneceu|possui|apresenta) (o |um )?(conte[uú]do|texto|artigo)',
  '^\\W*(desculpe|sorry),?\\s*(n[aã]o|i (can|cannot|can.?t))',
  '^\\W*forne[cç]a (o |um )?(resumo|texto|artigo|conte[uú]do)',
  '^\\W*(submit|write|translate|send|provide|enter) (an |the |a )?(article|title|summary|text|content)',
  '^\\W*this is a (summary|title|test|sample)',
  '^\\W*responda (\\S+ ){0,2}(apenas|só|somente)',
  '^\\W*(translated title|proper format|summary of previous|title_pt|summary_pt)\\b',
  'n[aã]o (foi poss[ií]vel|[ée] poss[ií]vel)\\s*(gerar|realizar|produzir|extrair|traduzir|resumir)' +
    '\\s*(\\S+\\s+){0,2}(resumo|t[ií]tulo|tradu[cç][aã]o|conte[uú]do)',
  // "…, por favor, envie/insira/cole o texto [do artigo]" (em QUALQUER posição — pedido de material
  // com objeto exigido para "por favor, envie o relatório à direção" (notícia) não casar)
  'por favor,?\\s*(envie|insira|forne[cç]a|adicione|informe|cole)\\s+(\\S+\\s+){0,3}(texto|artigo|conte[uú]do|resumo)',
  '^\\W*please\\s*(provide|send|paste|enter|supply)',
  '^\\W*(the )?(article|text|content|summary)(\\s+\\S+){0,2}\\s+(was |is )?(not (provided|supplied|available|included)|(was |is )?missing)',
  '^\\W*as an ai\\b',
  'mensagem de verifica[cç][aã]o',
].join('|');
// Porta 2: sujeito (artigo/conteúdo/texto/resumo) + negação ESPECÍFICA de recusa + menção do que
// falta/pedido. A negação é exigida completa ("não é um artigo", não "não é") para "O artigo
// apresenta uma lista não exaustiva…" não casar.
const REFUSAL_SUBJECT =
  '^\\W*(erro\\s*[:\\u2014-]\\s*)?((nenhum|nenhuma|um|uma|o|a|este|esta|o pr[oó]prio)\\s+)?' +
  '(artigo|conte[uú]do|texto|resumo)(\\s+\\S+){0,4}\\s+';
const REFUSAL_CLAIM =
  '(n[aã]o (foi )?fornecid|n[aã]o (foi )?enviad|' +
  'n[aã]o (pode|p[oô]de|foi poss[ií]vel) ser (produzid|gerad|exibid|realizad|traduzid|resumid|acessad|obtid|lido|carregad)|' +
  'n[aã]o apresenta um artigo|n[aã]o cont[eé]m um artigo|n[aã]o [ée] um artigo|est[aá] (em falta|indispon[ií]vel))';
const REFUSAL_MISSING =
  '(fornecid|enviad|em falta|ausente|vazi|indispon|dispon[ií]vel|sem (conte[uú]do|texto|artigo)|' +
  'por favor|verifica[cç][aã]o|erro[s]?\\W{0,3}(4\\d\\d|5\\d\\d)|p[aá]gina (inacess[ií]vel|indispon[ií]vel))';
const REFUSAL_RE_STANDALONE = new RegExp(REFUSAL_STANDALONE, 'i');
const REFUSAL_RE_SUBJECT = new RegExp(REFUSAL_SUBJECT, 'i');
const REFUSAL_RE_CLAIM = new RegExp(REFUSAL_CLAIM, 'i');
const REFUSAL_RE_MISSING = new RegExp(REFUSAL_MISSING, 'i');

export function isRefusalText(text) {
  const head = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!head) return false;
  if (REFUSAL_RE_STANDALONE.test(head)) return true;
  return REFUSAL_RE_SUBJECT.test(head) && REFUSAL_RE_CLAIM.test(head) && REFUSAL_RE_MISSING.test(head);
}

const ts = () => new Date().toISOString();

// Sink opcional de logs: quando setado (ex.: a UI Ink), TODO o output do crawl vai p/ ele em
// vez do console — sem tocar em crawl.js/fetch.js/classify.js. setLogSink(null) restaura o console.
let logSink = null;
export function setLogSink(fn) {
  logSink = typeof fn === 'function' ? fn : null;
}
/** A TUI está capturando os logs via sink? (alguns emissores duplicam marcos se o sink já
 * converte erro->evento — o CLI, sem sink, emite o marco ele mesmo.) */
export function hasLogSink() {
  return logSink != null;
}

// ---- log persistente por processo (NC_HOME/logs) ----
// openLogFile() grava TODO o log do processo (log/warn/errorLog/debug) num arquivo com flush
// IMEDIATO (writeSync = syscall direto, sem buffer userspace): um `tail -f` do arquivo vê cada
// linha NA HORA, mesmo quando o stdout do processo está buferizado num pipe (`npm run crawl |
// tee` cegava o observador por minutos — o arquivo mata esse problema por construção). O sink da
// TUI e o console NÃO mudam de comportamento (o sink continua recebendo {level, text} sem
// timestamp; o console recebe a linha formatada como antes). Fail-open: qualquer erro de
// filesystem apenas desliga o arquivo, nunca derruba o comando.
const LEVEL_MARK = { log: '', warn: ' WARN', error: ' ERROR', debug: ' DEBUG' };
let logFd = null;
let logPathStr = null;

// Mesma regra do config.js (NC_HOME override por env; default ~/.newsletter-crawler) — sem
// importar config p/ manter util pura (config importa util). Exportado: o devtrace resolve
// NC_HOME/logs pela MESMA regra.
export function ncHomeDir() {
  return process.env.NC_HOME
    ? path.resolve(process.env.NC_HOME)
    : path.join(os.homedir(), '.newsletter-crawler');
}

/** Abre (ou troca) o arquivo de log do processo: NC_HOME/logs/<comando>-<ts>-<pid>.log + um
 * symlink estável NC_HOME/logs/latest.log apontando p/ ele (p/ `tail -f latest.log`). Retorna o
 * caminho, ou null se o filesystem recusar (fail-open). Idempotente: chamar de novo fecha o fd
 * anterior e grava num arquivo novo. */
export function openLogFile({ command = 'ncrawl' } = {}) {
  const name = String(command || 'ncrawl').replace(/[^a-z0-9-]+/gi, '-');
  try {
    const dir = path.join(ncHomeDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${name}-${stamp}-${process.pid}.log`);
    const fd = openSync(file, 'a');
    if (logFd != null) {
      try { closeSync(logFd); } catch { /* já fechado */ }
    }
    logFd = fd;
    logPathStr = file;
    // Ponteiro estável p/ tail -f (symlink RELATIVO: o alvo vive no MESMO diretório).
    try {
      const latest = path.join(dir, 'latest.log');
      try { unlinkSync(latest); } catch { /* ainda não existe (ou já era dangling): ok */ }
      symlinkSync(path.basename(file), latest);
    } catch { /* symlink é conveniência; o arquivo datado segue sendo gravado */ }
    return file;
  } catch {
    logFd = null;
    logPathStr = null;
    return null;
  }
}

/** Caminho do arquivo de log do processo atual (null se nenhum foi aberto). */
export function logFilePath() {
  return logPathStr;
}

/** Fecha o arquivo de log (o próximo log() cai só no console/sink de sempre). */
export function closeLogFile() {
  if (logFd != null) {
    try { closeSync(logFd); } catch { /* idem */ }
    logFd = null;
    logPathStr = null;
  }
}

// Formata um valor p/ a linha do ARQUIVO (o sink/console recebem os args crus como hoje):
// objetos viram JSON, erros viram stack — nunca "[object Object]".
const fmtLogValue = (x) => {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || x.message || String(x);
  if (x && typeof x === 'object') {
    try { return JSON.stringify(x); } catch { return String(x); }
  }
  return String(x);
};

const emit = (level, a) => {
  const stamp = `[${ts()}]${LEVEL_MARK[level] || ''}`;
  const text = a.map(fmtLogValue).join(' ');
  // Log persistente (flush imediato: writeSync passa por cima de qualquer buffer de usuário).
  if (logFd != null) {
    try {
      writeSync(logFd, `${stamp} ${text}\n`);
    } catch {
      /* gravação de log nunca derruba o processo */
    }
  }
  if (logSink) {
    logSink({ level, text });
    return true;
  }
  if (level === 'log') console.log(stamp, ...a);
  else if (level === 'warn') console.warn(stamp, ...a);
  else console.error(stamp, ...a); // error e debug vão p/ stderr (não polui stdout)
  return false;
};
export const log = (...a) => {
  emit('log', a); // o próprio emit decide: arquivo -> sink -> console
};
export const warn = (...a) => {
  emit('warn', a);
};
export const errorLog = (...a) => {
  emit('error', a);
};
// Debug verboso, ligado por env DEBUG=1 (ou true). Vai p/ stderr p/ não poluir stdout.
const DEBUG_ON = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
export const debug = (...a) => {
  if (!DEBUG_ON) return;
  emit('debug', a);
};
