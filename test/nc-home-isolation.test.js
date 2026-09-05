// REDE DE SEGURANÇA — malha CONHECIDA, não garantia. O que ela faz: varrer o TEXTO dos arquivos
// de teste procurando os padrões que fariam um teste abrir o NC_HOME REAL (~/.newsletter-crawler),
// onde mora o crawler.db do usuário. Um `import` estático de qualquer módulo que alcance
// src/config.js já CRIA/semeia esse diretório e carrega o .env dele; alcançar src/db.js ABRE o
// banco em ESCRITA (migrações aditivas + rebuild do FTS). Um teste futuro que navegasse mais fundo
// no menu da TUI chegaria em "Limpar tudo (reset)" — com `flags:{yes:true}` embutido — e APAGARIA
// o acervo.
//
// Por que ESTÁTICO e não em tempo de execução: o `node --test` roda CADA arquivo num PROCESSO
// SEPARADO, então um guard rodando aqui não enxerga o process.env dos outros. A única forma de,
// de um só lugar, cobrir a suíte inteira é analisar o GRAFO DE IMPORTS dos arquivos — e o grafo
// responde exatamente à pergunta certa, porque em ESM o `import` estático é IÇADO: ele é avaliado
// ANTES da primeira linha do corpo do módulo, logo NENHUM `process.env.NC_HOME = ...` escrito no
// teste chega a tempo. O contrato do repo é: setar NC_HOME num diretório temporário e só então
// `await import(...)` o módulo (padrão de commands.summary.test.js, events.buffer.test.js, etc).
//
// O QUE ELA NÃO PROMETE (leia a constante LIMITS abaixo — ela também vai na mensagem de falha):
// isto é um FILTRO de padrões textuais, não um verificador. Passar aqui NÃO prova isolamento;
// reprovar aqui é um sinal forte de que algo vai encostar no banco real. Escrever "garante" numa
// rede assim é como este repo já se machucou antes: o guard do `pre-push` foi tratado como garantia
// e acabou contornado com `--no-verify`. Prefira dizer a verdade e listar os buracos.
//
// Nada aqui importa src/ — a análise é textual, nenhum módulo do crawler é avaliado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const TEST = path.join(ROOT, 'test');
// O `node --test` (sem argumento) varre a raiz inteira, então webapp/test/** também roda. Hoje
// aqueles testes só alcançam webapp/src/**, que não tem config/db do crawler — mas eles entram na
// varredura mesmo assim: resolver é por CAMINHO, então um futuro `../../src/db.js` de lá é pego.
const SCAN_DIRS = [TEST, path.join(ROOT, 'webapp', 'test')].filter((d) => existsSync(d));

// Alvos PERIGOSOS: config.js faz mkdirSync(NC_HOME)+seed+load do .env no topo; db.js abre o
// DB_PATH (e roda migração/FTS) no topo. Alcançar QUALQUER um deles no load já é efeito colateral.
const DANGEROUS = {
  [path.join(SRC, 'config.js')]: 'cria/semeia o NC_HOME real e carrega o .env do usuário',
  [path.join(SRC, 'db.js')]: 'ABRE o crawler.db do usuário em escrita (migrações + FTS)',
};

// ---- limitações CONHECIDAS desta malha (ditas em voz alta, e repetidas na falha) ----
const LIMITS = [
  'specifier CALCULADO não é resolvido (variável, pathToFileURL(...), template com ${}) — não vira aresta;',
  'sem análise de FLUXO: a proteção exigida é POSICIONAL (+ profundidade de chaves). Um import perigoso ' +
  'no topo do módulo exige o process.env.NC_HOME também no topo; se o import perigoso estiver aninhado ' +
  '(dentro de um before()/função), aceita-se um NC_HOME aninhado — e aí um assignment que nunca roda passaria;',
  '"aponta para fora da casa real" é julgado por MARCADORES textuais (homedir/userInfo/process.env.HOME/' +
  '.newsletter-crawler/valor vazio) + 1 salto de variável: um RHS opaco (ex.: `cfg.dir`) é ACEITO;',
  'processo FILHO é invisível: spawnSync(node src/index.js), mock.module e scripts montados em string ' +
  'não entram no grafo — o isolamento deles é responsabilidade do próprio teste (env herdado);',
  'require com outro nome não é reconhecido (`const r = createRequire(...); r("../src/db.js")`);',
  'o grafo de src/ também é textual: um import calculado DENTRO de src/ não aparece nas cadeias;',
  'código dentro de ${} de um template não é analisado (o template inteiro conta como string);',
  'só varre test/ e webapp/test/: um .js executável fora desses diretórios fica de fora.',
];

// ---- máscara textual (léxico simplificado — nada é executado) ----
// Antes de procurar padrão nenhum, o fonte é reescrito: comentários (`//` E `/* */`) e literais de
// REGEX viram vazio; cada literal de STRING vira um MARCADOR opaco (o conteúdo é guardado à parte).
// Isso mata os dois falsos positivos que reprovavam código correto — `import ... from '../src/db.js'`
// dentro de um bloco `/* */` e o mesmo texto dentro de uma string (detect-type.test.js monta o script
// de um processo filho assim) — sem abrir mão de enxergar o specifier real de quem importa de fato.
// As quebras de linha do trecho mascarado são preservadas: a numeração de linha continua exata.
const MARK = '\u0000'; // NUL não existe num .js real: o fonte não consegue FORJAR um marcador
const SPEC = `${MARK}(\\d+)${MARK}`;
const WORD_CHAR = /[\w$]/;
// Depois destes um `/` abre REGEX; depois de um valor (identificador, `)`, `]`, número) é divisão.
const REGEX_OK_CHARS = '([{},;:=!&|?+-*%~^<>';
const REGEX_OK_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

/** Fim (exclusivo) do literal citado que começa em `i` (`'`, `"` ou crase), pulando escapes e ${…}. */
function endOfQuoted(txt, i) {
  const q = txt[i];
  let j = i + 1;
  while (j < txt.length) {
    const c = txt[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && txt[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < txt.length && depth > 0) {
        const k = txt[j];
        if (k === '`' || k === "'" || k === '"') j = endOfQuoted(txt, j);
        else {
          if (k === '{') depth++;
          else if (k === '}') depth--;
          j++;
        }
      }
      continue;
    }
    if (q !== '`' && c === '\n') return j; // string simples não atravessa linha: não fechou
    j++;
  }
  return txt.length;
}

/** Fim (exclusivo) do literal de regex que começa em `i`, ou -1 se não fechar na mesma linha. */
function endOfRegex(txt, i) {
  let j = i + 1;
  let klass = false;
  while (j < txt.length) {
    const c = txt[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return -1;
    if (klass) { if (c === ']') klass = false; } else if (c === '[') klass = true;
    else if (c === '/') {
      j++;
      while (j < txt.length && WORD_CHAR.test(txt[j])) j++; // flags
      return j;
    }
    j++;
  }
  return -1;
}

const newlinesOf = (s) => '\n'.repeat((s.match(/\n/g) || []).length);

function maskSource(txt) {
  const values = [];
  let out = '';
  let lastSig = ''; // último caractere significativo já emitido como CÓDIGO
  let lastWord = ''; // última palavra emitida (para distinguir `return /re/` de `a / b`)
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = endOfQuoted(txt, i);
      const raw = txt.slice(i, end);
      const closed = raw.length >= 2 && raw.at(-1) === c;
      const inner = closed ? raw.slice(1, -1) : raw.slice(1);
      // template com interpolação = specifier indeterminado (null): nunca resolve para um arquivo.
      values.push(c === '`' ? (inner.includes('${') ? null : inner) : inner.replace(/\\(.)/g, '$1'));
      out += `${MARK}${values.length - 1}${MARK}${newlinesOf(raw)}`;
      lastSig = ')'; // uma string é um VALOR: o `/` seguinte seria divisão
      lastWord = '';
      i = end;
      continue;
    }
    if (c === '/' && txt[i + 1] === '/') {
      const end = txt.indexOf('\n', i);
      i = end === -1 ? txt.length : end; // o \n fica para a próxima volta
      continue;
    }
    if (c === '/' && txt[i + 1] === '*') {
      const end = txt.indexOf('*/', i + 2);
      const raw = txt.slice(i, end === -1 ? txt.length : end + 2);
      out += newlinesOf(raw);
      i += raw.length;
      continue;
    }
    if (c === '/' && (!lastSig || REGEX_OK_CHARS.includes(lastSig) || REGEX_OK_WORDS.has(lastWord))) {
      const end = endOfRegex(txt, i);
      if (end > 0) { // regex fechada: some (um `'` ou um `import(` dentro dela não é código)
        out += ' ';
        lastSig = ')';
        lastWord = '';
        i = end;
        continue;
      }
    }
    if (WORD_CHAR.test(c)) {
      let j = i;
      while (j < txt.length && WORD_CHAR.test(txt[j])) j++;
      const word = txt.slice(i, j);
      out += word;
      lastSig = word.at(-1);
      lastWord = word;
      i = j;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i++;
  }
  return { code: out, values };
}

/** Profundidade de CHAVES em cada posição do texto já mascarado (topo do módulo = 0). */
function braceDepths(code) {
  const d = new Int32Array(code.length + 1);
  let cur = 0;
  for (let i = 0; i < code.length; i++) {
    d[i] = cur;
    if (code[i] === '{') cur++;
    else if (code[i] === '}') cur = Math.max(0, cur - 1);
  }
  d[code.length] = cur;
  return d;
}

// ---- padrões de import sobre o texto MASCARADO (a string virou um marcador único) ----
// Estático = IÇADO (roda antes do corpo): `import ... from 'x'`, `import 'x'` e TAMBÉM
// `export ... from 'x'` (re-export é import com outro nome — foi por aí que passou uma evasão).
const STATIC_RE = new RegExp(`(?:^|[\\n;{}()])\\s*(?:import|export)\\b\\s*(?:[^;${MARK}]*?\\bfrom\\s*)?${SPEC}`, 'gd');
// Em tempo de EXECUÇÃO (ordem do arquivo manda): import() dinâmico — com aspas OU crase — e as
// duas formas de require em ESM (Node 24 faz `require(ESM)`).
const DYNAMIC_RE = new RegExp(`\\bimport\\s*\\(\\s*${SPEC}\\s*\\)`, 'gd');
const REQUIRE_RE = new RegExp(`\\brequire\\s*\\(\\s*${SPEC}\\s*\\)`, 'gd');
const CREATE_REQUIRE_RE = new RegExp(`\\bcreateRequire\\s*\\([^()]*\\)\\s*\\(\\s*${SPEC}\\s*\\)`, 'gd');
const NC_HOME_SET_RE = /process\.env\.NC_HOME\s*=(?!=)/g;
// Marcadores de que o NC_HOME NÃO saiu da casa real (o critério é "está isolado?", não "usou
// mkdtempSync"): apontar para o home do usuário, ou deixar vazio/undefined — o config.js cai no
// default ~/.newsletter-crawler quando process.env.NC_HOME é falsy.
const REAL_HOME_RE = /homedir\s*\(|userInfo\s*\(|process\.env\.HOME\b|\.newsletter-crawler|"~\//;
const NOT_ISOLATED_RE = /^\s*(""|undefined|null|process\.env\.NC_HOME)\s*$/;

const lineOf = (txt, index) => txt.slice(0, index).split('\n').length;

function resolveLocal(fromFile, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null; // bare = node_modules
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (cand.endsWith('.js') && existsSync(cand)) return cand;
  }
  return null;
}

function importsOf(file, txt) {
  const { code, values } = maskSource(txt);
  const depths = braceDepths(code);
  const collect = (re, kind) => {
    const out = [];
    for (const m of code.matchAll(re)) {
      const to = resolveLocal(file, values[Number(m[1])]);
      if (!to) continue;
      const at = m.indices[1][0];
      out.push({ to, kind, at, line: lineOf(code, at), depth: depths[at] });
    }
    return out;
  };
  const stat = collect(STATIC_RE, 'import estático');
  const runtime = [
    ...collect(DYNAMIC_RE, 'await import()'),
    ...collect(REQUIRE_RE, 'require()'),
    ...collect(CREATE_REQUIRE_RE, 'createRequire()()'),
  ].sort((a, b) => a.at - b.at);
  return { stat, runtime, code, values, depths };
}

// ---- grafo do src/ (todo import lá é estático: um alcance = avaliação no load) ----
const srcDeps = new Map();
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.js')) {
      const { stat, runtime } = importsOf(f, readFileSync(f, 'utf8'));
      srcDeps.set(f, new Set([...stat, ...runtime].map((d) => d.to)));
    }
  }
})(SRC);

const memo = new Map();
/** Cadeia de imports de `file` até um módulo perigoso, ou null. */
function chainToDanger(file, seen = new Set()) {
  if (memo.has(file)) return memo.get(file);
  if (seen.has(file)) return null; // ciclo
  seen.add(file);
  if (DANGEROUS[file]) return [file];
  for (const dep of srcDeps.get(file) || []) {
    const rest = chainToDanger(dep, seen);
    if (rest) {
      const chain = [file, ...rest];
      memo.set(file, chain);
      return chain;
    }
  }
  return null;
}

const rel = (f) => path.relative(ROOT, f);
const fmtChain = (chain) => chain.map(rel).join(' -> ');

/** Devolve os literais de string ao texto (entre aspas) para julgar/mostrar um RHS. */
const unmask = (s, values) => s.replace(new RegExp(SPEC, 'g'), (_, n) => {
  const v = values[Number(n)];
  return typeof v === 'string' ? JSON.stringify(v) : '`…`';
});

/** Lado direito de uma atribuição a partir de `from`: até `;` ou fim de linha fora de parênteses. */
function rhsFrom(code, from) {
  let depth = 0;
  let start = from;
  while (start < code.length && /\s/.test(code[start])) start++; // o RHS pode vir na linha de baixo
  for (let i = start; i < code.length && i < start + 400; i++) {
    const c = code[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth <= 0 && (c === ';' || c === '\n')) return code.slice(start, i);
  }
  return code.slice(start, start + 400);
}

/** Onde o teste seta NC_HOME, com o RHS já legível e um veredito sobre para onde ele aponta. */
function ncHomeSets(code, values, depths) {
  const sets = [];
  for (const m of code.matchAll(NC_HOME_SET_RE)) {
    const at = m.index;
    const from = at + m[0].length;
    let rhs = unmask(rhsFrom(code, from), values).trim();
    // 1 salto de variável: `process.env.NC_HOME = TMP` com `const TMP = mkdtempSync(...)` acima.
    if (/^[A-Za-z_$][\w$]*$/.test(rhs)) {
      const decl = new RegExp(`\\b(?:const|let|var)\\s+${rhs}\\s*=([^;\\n]*)`).exec(code);
      if (decl) rhs = unmask(decl[1], values).trim();
    }
    let verdict = 'ok';
    if (REAL_HOME_RE.test(rhs)) verdict = 'casa-real';
    else if (NOT_ISOLATED_RE.test(rhs) || !rhs) verdict = 'vazio';
    sets.push({ at, line: lineOf(code, at), depth: depths[at], rhs, verdict });
  }
  return sets;
}

/**
 * Audita UM arquivo de teste (texto puro — dá para alimentar com um exemplo sintético).
 * Devolve a lista de problemas; vazia = nenhum padrão conhecido de vazamento (ver LIMITS).
 */
function auditTestFile(file, txt) {
  const problems = [];
  const { stat, runtime, code, values, depths } = importsOf(file, txt);

  for (const imp of stat) {
    const chain = chainToDanger(imp.to);
    if (chain) {
      problems.push(
        `${rel(file)}:${imp.line} alcança ESTATICAMENTE ${fmtChain(chain)} — o import estático é ` +
        `IÇADO, então roda ANTES de qualquer process.env.NC_HOME do corpo (${DANGEROUS[chain.at(-1)]}). ` +
        'Troque por: process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), \'nc-…-\')) e depois ' +
        '`const { … } = await import(…)`.',
      );
    }
  }

  const sets = ncHomeSets(code, values, depths);
  for (const s of sets) {
    if (s.verdict === 'casa-real') {
      problems.push(`${rel(file)}:${s.line} aponta NC_HOME para a casa REAL do usuário (${s.rhs}).`);
    } else if (s.verdict === 'vazio') {
      problems.push(
        `${rel(file)}:${s.line} seta NC_HOME com valor vazio/indefinido (${s.rhs || '<vazio>'}) — ` +
        'o config.js cai no default ~/.newsletter-crawler quando NC_HOME é falsy.',
      );
    }
  }

  const first = runtime.find((d) => chainToDanger(d.to));
  if (first) {
    // A proteção tem de vir ANTES (posição no arquivo) e, quando o import perigoso está no TOPO do
    // módulo, também no topo: um `process.env.NC_HOME` escondido dentro de uma função (que pode
    // nunca ser chamada) não protege nada. Isto é profundidade de chaves, NÃO análise de fluxo.
    const before = sets.filter((s) => s.at < first.at && s.verdict === 'ok' && (first.depth > 0 || s.depth === 0));
    if (!before.length) {
      const aninhado = sets.some((s) => s.at < first.at && s.verdict === 'ok' && s.depth > 0);
      problems.push(
        `${rel(file)}:${first.line} faz ${first.kind} de ${fmtChain(chainToDanger(first.to))} ` +
        (aninhado
          ? 'e o único process.env.NC_HOME anterior está ANINHADO (dentro de {…}) — um assignment que ' +
            'pode nunca rodar não protege um import no topo do módulo. Suba-o para o topo.'
          : 'sem setar process.env.NC_HOME antes — usaria o NC_HOME REAL do usuário.'),
      );
    }
  }
  return problems;
}

function testJsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testJsFiles(f));
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

// ---- os testes ----
const SELF = path.join(TEST, 'nc-home-isolation.test.js');
const FAKE = path.join(TEST, '__exemplo__.test.js'); // caminho fictício: só serve p/ resolver '../src/…'

test('nenhum teste casa com um padrão conhecido de abrir o NC_HOME real (~/.newsletter-crawler)', () => {
  const files = SCAN_DIRS.flatMap(testJsFiles); // ESTE arquivo incluído: os exemplos aqui são strings
  assert.ok(files.length >= 50, `a varredura deve enxergar a suíte inteira (viu ${files.length})`);

  const problems = files.flatMap((f) => auditTestFile(f, readFileSync(f, 'utf8')));
  assert.deepEqual(
    problems,
    [],
    `\n\nTESTE PRESTES A USAR O BANCO REAL DO USUÁRIO:\n\n${problems.join('\n\n')}\n\n` +
    `NC_HOME real desta máquina: ${path.join(os.homedir(), '.newsletter-crawler')}\n\n` +
    `Esta rede é uma MALHA CONHECIDA, não uma garantia — ela NÃO pega:\n- ${LIMITS.join('\n- ')}\n`,
  );
});

test('o próprio guard não alcança src/ (ele se inclui na varredura)', () => {
  const { stat, runtime } = importsOf(SELF, readFileSync(SELF, 'utf8'));
  assert.deepEqual(stat.filter((s) => chainToDanger(s.to)), [], 'sem import estático perigoso');
  assert.deepEqual(runtime.filter((s) => chainToDanger(s.to)), [], 'sem import dinâmico perigoso');
  // Os `import('../src/…')` que aparecem aqui embaixo são EXEMPLOS dentro de strings; a máscara
  // os apaga — é justamente por isso que este arquivo pode se auditar sem se auto-reprovar.
});

test('a malha tem dentes: pega o violador em todas as formas de import', () => {
  // (a) import estático de um módulo que alcança config.js.
  const viola = auditTestFile(FAKE, "import { isBlockedPage } from '../src/clean.js';\n");
  assert.equal(viola.length, 1, 'import estático que alcança config.js deve ser acusado');
  assert.match(viola[0], /ESTATICAMENTE/);

  // (b) import estático que alcança db.js (o caso catastrófico da TUI).
  const violaDb = auditTestFile(FAKE, "import App from '../src/ui/App.js';\n");
  assert.equal(violaDb.length, 1, 'import estático que alcança db.js deve ser acusado');
  assert.match(violaDb[0], /db\.js/);

  // (c) import dinâmico SEM setar NC_HOME antes.
  const semHome = auditTestFile(FAKE, "const { db } = await import('../src/db.js');\n");
  assert.equal(semHome.length, 1, 'await import sem NC_HOME deve ser acusado');
  assert.match(semHome[0], /sem setar process\.env\.NC_HOME antes/);

  // (d) NC_HOME apontando para a casa REAL (isolamento só na aparência).
  const casaReal = auditTestFile(
    FAKE,
    "process.env.NC_HOME = path.join(os.homedir(), '.newsletter-crawler');\n" +
    "const { db } = await import('../src/db.js');\n",
  );
  assert.ok(casaReal.some((p) => /casa REAL/.test(p)), 'NC_HOME na casa real deve ser acusado');

  // (e) NC_HOME vazio: o config.js cai no default ~/.newsletter-crawler.
  const vazio = auditTestFile(FAKE, "process.env.NC_HOME = '';\nconst { db } = await import('../src/db.js');\n");
  assert.ok(vazio.some((p) => /vazio\/indefinido/.test(p)), 'NC_HOME vazio deve ser acusado');

  // ---- as EVASÕES que passavam batido (cada uma criava crawler.db de verdade) ----
  // (f) re-export: `export ... from` é import com outro nome.
  const reexport = auditTestFile(FAKE, "export * from '../src/db.js';\n");
  assert.equal(reexport.length, 1, 'export * from deve ser acusado');
  assert.match(reexport[0], /ESTATICAMENTE/);
  assert.equal(auditTestFile(FAKE, "export { db } from '../src/db.js';\n").length, 1);

  // (g) createRequire: em Node 24 o require alcança ESM.
  const req = auditTestFile(FAKE, "createRequire(import.meta.url)('../src/db.js');\n");
  assert.equal(req.length, 1, 'createRequire(...)(...) deve ser acusado');
  assert.match(req[0], /createRequire/);
  assert.equal(
    auditTestFile(FAKE, "const req = createRequire(import.meta.url);\nreq('../src/db.js');\n").length,
    0,
    'LIMITE conhecido: require rebatizado NÃO é reconhecido (está em LIMITS)',
  );

  // (h) import dinâmico com CRASE.
  const crase = auditTestFile(FAKE, 'const { db } = await import(`../src/db.js`);\n');
  assert.equal(crase.length, 1, 'import(`…`) com template deve ser acusado');

  // (i) NC_HOME dentro de função que ninguém chama, acima do import de topo.
  const naoRoda = auditTestFile(
    FAKE,
    'function setup() {\n  process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), \'nc-x-\'));\n}\n' +
    "const { db } = await import('../src/db.js');\n",
  );
  assert.equal(naoRoda.length, 1, 'NC_HOME aninhado não protege um import de topo');
  assert.match(naoRoda[0], /ANINHADO/);
});

test('a malha NÃO reprova padrão legítimo (falso positivo trava o repo inteiro)', () => {
  // (a) o padrão CORRENTE do repo.
  assert.deepEqual(
    auditTestFile(
      FAKE,
      "import { mkdtempSync } from 'node:fs';\n" +
      "process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-exemplo-'));\n" +
      "const { db } = await import('../src/db.js');\n",
    ),
    [],
    'tmp + await import tem de passar',
  );

  // (b) módulo PURO (util.js não alcança config): import estático é legítimo.
  assert.deepEqual(auditTestFile(FAKE, "import { parseDate } from '../src/util.js';\n"), []);

  // (c) import perigoso dentro de um BLOCO DE COMENTÁRIO — código morto não abre banco nenhum.
  assert.deepEqual(
    auditTestFile(FAKE, "/*\nimport { db } from '../src/db.js';\n*/\nimport { parseDate } from '../src/util.js';\n"),
    [],
    'import comentado em /* */ não pode reprovar',
  );

  // (d) o mesmo texto dentro de uma STRING (detect-type.test.js monta o script do filho assim).
  assert.deepEqual(
    auditTestFile(FAKE, 'const CHILD = "const { db } = await import(\'../src/db.js\');";\n'),
    [],
    'import dentro de string literal não pode reprovar',
  );
  assert.deepEqual(
    auditTestFile(FAKE, 'const CHILD = `\nprocess.env.NC_HOME = x;\nawait import("../src/db.js");\n`;\n'),
    [],
    'import dentro de template não pode reprovar',
  );

  // (e) tmpdir determinístico (sem mkdtempSync): o isolamento é REAL, o critério é "está isolado?".
  assert.deepEqual(
    auditTestFile(
      FAKE,
      "process.env.NC_HOME = path.join(os.tmpdir(), 'nc-fixed-' + process.pid);\n" +
      "const { db } = await import('../src/db.js');\n",
    ),
    [],
    'NC_HOME em tmpdir sem mkdtempSync tem de passar',
  );

  // (f) NC_HOME por variável (padrão de config.key.test.js e amigos).
  assert.deepEqual(
    auditTestFile(
      FAKE,
      "const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-x-'));\n" +
      'process.env.NC_HOME = NC_HOME_TMP;\n' +
      "const { db } = await import('../src/db.js');\n",
    ),
    [],
    'NC_HOME por variável tem de passar',
  );

  // (g) LER src/ como TEXTO não é importar (snapshot-guard.test.js extrai o parseFlags do fonte).
  assert.deepEqual(
    auditTestFile(FAKE, "const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');\n"),
    [],
    'readFileSync de um módulo perigoso não pode reprovar',
  );

  // (h) regex com aspas dentro (o lexer não pode confundir com string e engolir o arquivo).
  assert.deepEqual(
    auditTestFile(
      FAKE,
      'const citado = /"(--allow-shrink[^"]*)"/.exec(hint);\n' +
      "process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-x-'));\n" +
      "const { db } = await import('../src/db.js');\n",
    ),
    [],
    'regex com aspas não pode desalinhar a máscara',
  );

  // (i) RHS começando na LINHA DE BAIXO do `=` (quebra de linha não é "valor vazio").
  assert.deepEqual(
    auditTestFile(
      FAKE,
      'process.env.NC_HOME =\n  mkdtempSync(path.join(os.tmpdir(), \'nc-x-\'));\n' +
      "const { db } = await import('../src/db.js');\n",
    ),
    [],
    'atribuição quebrada em duas linhas tem de passar',
  );
});

test('o grafo enxerga as cadeias reais (âncora contra um parser que pare de achar imports)', () => {
  assert.ok(chainToDanger(path.join(SRC, 'ui', 'App.js')), 'src/ui/App.js alcança config/db');
  assert.ok(chainToDanger(path.join(SRC, 'clean.js')), 'src/clean.js alcança config');
  assert.equal(chainToDanger(path.join(SRC, 'util.js')), null, 'src/util.js é PURO (sem config/db)');
});

test('as limitações CONHECIDAS viajam junto com a falha (a malha não se vende como garantia)', () => {
  assert.ok(LIMITS.length >= 6, 'a lista de buracos conhecidos não pode encolher em silêncio');
  for (const l of LIMITS) assert.match(l, /\S/);
  const header = readFileSync(SELF, 'utf8').slice(0, 2400);
  assert.match(header, /não garantia|NÃO PROMETE/i, 'o cabeçalho tem de dizer o que a malha não é');
});
