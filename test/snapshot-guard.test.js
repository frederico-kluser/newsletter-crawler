// Guard anti-encolhimento: a decisão PURA que impede publicar um snapshot que destrói o acervo.
// O caso que dá nome ao arquivo é real (2026-08-24, commit 7c24491): 0 artigos publicados por cima
// de 2866, 261.088 linhas de JSON apagadas do git. Todo teste abaixo existe para que essa
// combinação — e as vizinhas dela — nunca mais passem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateSnapshotChange, articlesFromMeta, toCount, SHRINK_OPT_IN, WIPE_OPT_IN,
} from '../src/snapshot-guard.js';

const META = (articles) => ({ schemaVersion: 1, generatedAt: '2026-08-24T12:18:23.000Z', totals: { articles } });

// O parseFlags REAL da CLI, extraído do próprio src/index.js (ele não é exportado, e importar o
// módulo dispararia o CLI). Extrair do arquivo — em vez de recopiar o algoritmo aqui — garante que
// a prova do opt-in acompanhe qualquer mudança no parser: se o parser mudar, este teste é quem
// quebra primeiro. Um hint não testado contra o parser real foi exatamente como nasceu o bug do
// `--allow-shrink=wipe` (o parser não quebra em `=`, então o opt-in citado nunca chegava ao guard).
const parseFlags = (() => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const inicio = src.indexOf('function parseFlags(argv) {');
  const fim = src.indexOf('\n}\n', inicio);
  assert.ok(inicio >= 0 && fim > inicio, 'não achei function parseFlags(argv) em src/index.js');
  return new Function(`${src.slice(inicio, fim + 3)}\nreturn parseFlags;`)();
})();

const chave = SHRINK_OPT_IN.slice(2); // 'allow-shrink' — a chave que o parseFlags produz

// ---- G1: o opt-in citado na mensagem tem de FUNCIONAR na linha de comando ----

test('parseFlags REAL: a forma citada no hint de wipe vira o opt-in forte de verdade', () => {
  const bloqueio = evaluateSnapshotChange({ novo: 0, head: 2866, live: 2866 });
  // A string é lida DA MENSAGEM (entre aspas), não da constante: é isso que o usuário copia.
  const citado = /"(--allow-shrink[^"]*)"/.exec(bloqueio.hint)?.[1];
  assert.equal(citado, WIPE_OPT_IN);

  const { flags, rest } = parseFlags(['deploy', ...citado.split(/\s+/)]);
  assert.deepEqual(rest, ['deploy']);
  assert.equal(flags[chave], 'wipe'); // e não `{'allow-shrink=wipe': true}` como na forma com `=`

  // ponta a ponta: o que o parser produziu libera o wipe quando repassado ao guard.
  const v = evaluateSnapshotChange({ novo: 0, head: 2866, live: 2866, allowShrink: flags[chave] });
  assert.equal(v.action, 'allow');
  assert.equal(v.reason, 'override-wipe');
});

test('parseFlags REAL: --allow-shrink sozinho vira o opt-in de encolhimento', () => {
  const { flags } = parseFlags(['deploy', SHRINK_OPT_IN]);
  assert.equal(flags[chave], true);
  const v = evaluateSnapshotChange({ novo: 1200, head: 2866, live: 2866, allowShrink: flags[chave] });
  assert.equal(v.reason, 'override-shrink');

  // seguido de outra flag também: `ncrawl deploy --allow-shrink --force`
  const { flags: f2 } = parseFlags(['deploy', SHRINK_OPT_IN, '--force']);
  assert.equal(f2[chave], true);
});

test('a forma `--flag=valor` NÃO é aceita por este parser: nenhum opt-in pode usá-la', () => {
  const { flags } = parseFlags(['deploy', '--allow-shrink=wipe']);
  assert.equal(flags[chave], undefined);          // o bug: o opt-in nunca chegaria ao guard
  assert.equal(flags['allow-shrink=wipe'], true); // vira uma flag literal com `=` no nome
  // Guarda de regressão: nenhuma constante de opt-in pode conter `=`.
  for (const optIn of [SHRINK_OPT_IN, WIPE_OPT_IN]) assert.equal(optIn.includes('='), false);
});

// ---- o incidente ----

test('7c24491: novo=0 sobre head=2866/live=2866 é BLOQUEADO (sem opt-in)', () => {
  const v = evaluateSnapshotChange({ novo: 0, head: 2866, live: 2866 });
  assert.equal(v.action, 'block');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'wipe');
  assert.equal(v.risk, 'wipe');
  assert.equal(v.override, false);
  assert.deepEqual(v.counts, { novo: 0, head: 2866, live: 2866, baseline: 2866 });
  // A mensagem tem que ser inequívoca sobre o que aconteceria, com os números.
  assert.match(v.message, /APAGARIA o acervo do site/);
  assert.match(v.message, /0 artigos/);
  assert.match(v.message, /2866/);
  // ... e acionável: o que provavelmente houve + qual é a saída legítima.
  assert.match(v.hint, /RESTAURE o banco/);
  assert.ok(v.hint.includes(WIPE_OPT_IN));
});

test('7c24491 chegando pelos meta.json de verdade (o que deploy/hook leem)', () => {
  const v = evaluateSnapshotChange({
    novo: articlesFromMeta(META(0)),
    head: articlesFromMeta(JSON.stringify(META(2866))), // o hook despeja o `git show` como string
    live: articlesFromMeta(META(2866)),
  });
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'wipe');
});

test('zerar exige o opt-in FORTE: --allow-shrink sozinho não libera', () => {
  for (const optIn of [true, 'true', 'shrink', '1', 'yes', 'YES', ' True ']) {
    const v = evaluateSnapshotChange({ novo: 0, head: 2866, live: 2866, allowShrink: optIn });
    assert.equal(v.action, 'block', `optIn=${optIn} não podia liberar o wipe`);
    assert.equal(v.reason, 'wipe');
    assert.match(v.hint, /não libera zerar/);
  }
  for (const forte of ['wipe', 'WIPE', ' wipe ']) {
    const w = evaluateSnapshotChange({ novo: 0, head: 2866, live: 2866, allowShrink: forte });
    assert.equal(w.action, 'allow');
    assert.equal(w.reason, 'override-wipe');
    assert.equal(w.override, true);
    assert.equal(w.risk, 'wipe');
    assert.match(w.message, /APAGADO/);
  }
});

test('opt-ins de encolhimento reconhecidos liberam o shrink parcial (e só ele)', () => {
  for (const optIn of [true, 'true', '1', 'yes', 'shrink', 'TRUE', ' yes ']) {
    const v = evaluateSnapshotChange({ novo: 2000, head: 2866, live: 2866, allowShrink: optIn });
    assert.equal(v.reason, 'override-shrink', `optIn=${optIn} devia liberar o encolhimento`);
  }
  for (const naoOptIn of [false, null, undefined, 0, 1, '', ' ', 'no', 'talvez', 'sim', 'y', {}]) {
    const v = evaluateSnapshotChange({ novo: 2000, head: 2866, live: 2866, allowShrink: naoOptIn });
    assert.equal(v.action, 'block', `allowShrink=${String(naoOptIn)} não é opt-in`);
    assert.equal(v.override, false);
  }
});

test('wipe é detectado com UM único total conhecido (head OU live)', () => {
  assert.equal(evaluateSnapshotChange({ novo: 0, head: 2866, live: null }).reason, 'wipe');
  assert.equal(evaluateSnapshotChange({ novo: 0, head: null, live: 2866 }).reason, 'wipe');
});

// ---- G3: a fronteira shrink x wipe (perda catastrófica) ----
// Critério: sobrar MENOS de 1/10 do acervo publicado é destruição, não redução — 2866 → 1 perde
// 99,97% e é, operacionalmente, o mesmo desastre de 2866 → 0. Redução intencional (purge de uma
// fonte, re-crawl parcial) guarda muito mais que 10%, então segue liberada pelo opt-in genérico.

test('perda catastrófica (2866 → 1) exige o opt-in FORTE, igual ao zero', () => {
  const semOptIn = evaluateSnapshotChange({ novo: 1, head: 2866, live: 2866 });
  assert.equal(semOptIn.action, 'block');
  assert.equal(semOptIn.reason, 'wipe');
  assert.match(semOptIn.message, /sobrariam só 1 artigo\(s\)/);

  const generico = evaluateSnapshotChange({ novo: 1, head: 2866, live: 2866, allowShrink: true });
  assert.equal(generico.action, 'block', '--allow-shrink não pode liberar perder 99,97%');
  assert.equal(generico.reason, 'wipe');

  const forte = evaluateSnapshotChange({ novo: 1, head: 2866, live: 2866, allowShrink: 'wipe' });
  assert.equal(forte.action, 'allow');
  assert.equal(forte.reason, 'override-wipe');
  assert.match(forte.message, /só 1 artigo\(s\)/);
});

test('fronteira EXATA dos dois lados: baseline/10 ainda é shrink, abaixo disso é wipe', () => {
  // baseline 2866 → 10% = 286,6. 287 sobrevive como encolhimento; 286 já é catastrófico.
  assert.equal(evaluateSnapshotChange({ novo: 287, head: 2866, live: 2866 }).reason, 'shrink');
  assert.equal(evaluateSnapshotChange({ novo: 286, head: 2866, live: 2866 }).reason, 'wipe');
  assert.equal(
    evaluateSnapshotChange({ novo: 287, head: 2866, live: 2866, allowShrink: true }).reason,
    'override-shrink');
  assert.equal(
    evaluateSnapshotChange({ novo: 286, head: 2866, live: 2866, allowShrink: true }).reason,
    'wipe');

  // baseline redondo: exatamente 10% (100 de 1000) ainda é shrink; 99 é wipe.
  assert.equal(evaluateSnapshotChange({ novo: 100, head: 1000, live: null }).reason, 'shrink');
  assert.equal(evaluateSnapshotChange({ novo: 99, head: 1000, live: null }).reason, 'wipe');

  // bases minúsculas: 1 de 10 é a fronteira; 1 de 11 já é catastrófico.
  assert.equal(evaluateSnapshotChange({ novo: 1, head: 10, live: null }).reason, 'shrink');
  assert.equal(evaluateSnapshotChange({ novo: 1, head: 11, live: null }).reason, 'wipe');
});

// ---- encolhimento parcial (regra central) ----

test('encolheu em relação ao HEAD => bloqueia', () => {
  const v = evaluateSnapshotChange({ novo: 1200, head: 2866, live: 2866 });
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'shrink');
  assert.equal(v.risk, 'shrink');
  assert.match(v.message, /1200 < 2866/);
  assert.match(v.message, /1666 artigo\(s\)/); // a perda, explícita
  assert.match(v.hint, new RegExp(SHRINK_OPT_IN.replace(/-/g, '\\-')));
});

test('encolher por UM artigo já bloqueia (sem tolerância, sem off-by-one)', () => {
  const v = evaluateSnapshotChange({ novo: 2865, head: 2866, live: 2866 });
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'shrink');
  assert.match(v.message, /1 artigo\(s\)/);
  assert.equal(evaluateSnapshotChange({ novo: 2866, head: 2866, live: 2866 }).reason, 'same');
  assert.equal(evaluateSnapshotChange({ novo: 2867, head: 2866, live: 2866 }).reason, 'grow');
});

test('encolheu só em relação ao SITE NO AR (head igual) => ainda bloqueia', () => {
  // O hook de hoje não olha o site: compararia 2866 com 2866 e deixaria passar.
  const v = evaluateSnapshotChange({ novo: 2866, head: 2866, live: 3000 });
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'shrink');
  assert.equal(v.counts.baseline, 3000); // a base é o MAIOR total conhecido
  assert.match(v.hint, /git pull --rebase/); // site à frente do HEAD: repo atrasado OU build velho
  assert.match(v.hint, /build\s+anterior/);  // ... e o hint não afirma qual dos dois é
});

test('head desconhecido não desliga o guard: compara com o que o site serve', () => {
  const v = evaluateSnapshotChange({ novo: 10, head: null, live: 2866 });
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'wipe'); // 10 de 2866 é perda catastrófica, não encolhimento
  assert.match(v.message, /HEAD: \?/);
  const parcial = evaluateSnapshotChange({ novo: 2000, head: null, live: 2866 });
  assert.equal(parcial.reason, 'shrink');
  assert.equal(parcial.counts.baseline, 2866);
});

test('--allow-shrink libera o encolhimento parcial, e o veredito grita OVERRIDE', () => {
  const v = evaluateSnapshotChange({ novo: 1200, head: 2866, live: 2866, allowShrink: true });
  assert.equal(v.action, 'allow');
  assert.equal(v.reason, 'override-shrink');
  assert.equal(v.override, true);
  assert.equal(v.risk, 'shrink');
  assert.match(v.message, /OPT-IN/);
  assert.match(v.message, /ENCOLHER em 1666/);
  assert.equal(v.hint, null);
});

// ---- caminhos normais ----

test('crescer, empatar e primeiro snapshot passam sem override', () => {
  const cresceu = evaluateSnapshotChange({ novo: 2900, head: 2866, live: 2866 });
  assert.equal(cresceu.action, 'allow');
  assert.equal(cresceu.reason, 'grow');
  assert.equal(cresceu.risk, null);
  assert.equal(cresceu.override, false);

  const igual = evaluateSnapshotChange({ novo: 2866, head: 2866, live: 2866 });
  assert.equal(igual.reason, 'same');

  const primeiro = evaluateSnapshotChange({ novo: 42, head: null, live: null });
  assert.equal(primeiro.action, 'allow');
  assert.equal(primeiro.reason, 'no-baseline');

  // Base publicada vazia + snapshot vazio: não é wipe (não há o que perder).
  const vazioSobreVazio = evaluateSnapshotChange({ novo: 0, head: 0, live: 0 });
  assert.equal(vazioSobreVazio.action, 'allow');
  assert.equal(vazioSobreVazio.reason, 'same');

  // Primeiro snapshot vazio (nada publicado ainda): nada a perder.
  const primeiroVazio = evaluateSnapshotChange({ novo: 0, head: null, live: null });
  assert.equal(primeiroVazio.action, 'allow');
  assert.equal(primeiroVazio.reason, 'no-baseline');
});

// ---- desconhecido = fail-SAFE (não fail-open) ----

test('total novo desconhecido BLOQUEIA (o hook atual seguiria em frente)', () => {
  for (const novo of [null, undefined, '', 'nan', NaN, -1, 1.5, {}, [], Infinity]) {
    const v = evaluateSnapshotChange({ novo, head: 2866, live: 2866 });
    assert.equal(v.action, 'block', `novo=${String(novo)} tinha de bloquear`);
    assert.equal(v.reason, 'unknown-new');
    assert.equal(v.risk, 'unknown');
  }
  const v = evaluateSnapshotChange({ novo: null, head: 2866, live: 2866 });
  assert.match(v.message, /NÃO consegue provar/);
  assert.match(v.hint, /export --format web/);
});

test('total novo desconhecido bloqueia mesmo sem base conhecida', () => {
  const v = evaluateSnapshotChange({ novo: null, head: null, live: null });
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'unknown-new');
});

test('opt-in também cobre o total desconhecido, marcado como override', () => {
  const v = evaluateSnapshotChange({ novo: null, head: 2866, live: 2866, allowShrink: true });
  assert.equal(v.action, 'allow');
  assert.equal(v.reason, 'override-unknown');
  assert.equal(v.override, true);
});

test('chamada sem argumento nenhum não explode e bloqueia', () => {
  const v = evaluateSnapshotChange();
  assert.equal(v.action, 'block');
  assert.equal(v.reason, 'unknown-new');
});

// ---- leitura dos totais ----

test('articlesFromMeta: objeto, string crua, e todo formato inválido => null', () => {
  assert.equal(articlesFromMeta(META(2866)), 2866);
  assert.equal(articlesFromMeta(JSON.stringify(META(2866))), 2866);
  assert.equal(articlesFromMeta(META(0)), 0); // zero é um total VÁLIDO, não "desconhecido"
  assert.equal(articlesFromMeta({ totals: { articles: '2866' } }), 2866); // hook passa texto
  for (const ruim of [null, undefined, '', 'não é json', '{}', {}, { totals: {} },
    { totals: { articles: null } }, { totals: { articles: 'muitos' } },
    { totals: { articles: -5 } }, { totals: { articles: 1.5 } }, 42, [], '[]']) {
    assert.equal(articlesFromMeta(ruim), null, `${JSON.stringify(ruim)} devia ser desconhecido`);
  }
});

test('toCount: string vazia é DESCONHECIDO, nunca zero; e nada de contagem quebrada', () => {
  assert.equal(toCount(''), null); // Number('') === 0 — a armadilha que zeraria a base
  assert.equal(toCount('   '), null);
  assert.equal(toCount('0'), 0);
  assert.equal(toCount(0), 0);
  assert.equal(toCount('2866'), 2866);
  assert.equal(toCount(-1), null);
  assert.equal(toCount(NaN), null);
  assert.equal(toCount(false), null);
  assert.equal(toCount(1.5), null);   // contagem de artigos é inteira: quebrado = entrada corrompida
  assert.equal(toCount('1.5'), null);
  assert.equal(toCount(Infinity), null);
});

// ---- F2: prova por enumeração, com oráculo INDEPENDENTE ----
// A expectativa NÃO pode sair de `v.counts` (seria conferir a implementação contra ela mesma: um
// baseline errado — ou fixo em 0 — passaria verde). Aqui ela é recalculada das ENTRADAS CRUAS por
// uma tabela de decisão escrita a partir da POLÍTICA, não do código.

const refTotal = (x) => {               // "total conhecido" = inteiro >= 0 ou string só de dígitos
  if (typeof x === 'number') return Number.isInteger(x) && x >= 0 ? x : null;
  if (typeof x === 'string') return /^\d+$/.test(x.trim()) ? Number(x.trim()) : null;
  return null;
};
const refOptIn = (x) => {               // as ÚNICAS formas de opt-in aceitas
  if (x === true) return 'shrink';           // `--allow-shrink` sozinho nunca é o opt-in forte
  if (typeof x !== 'string') return 'no';
  const s = x.trim().toLowerCase();
  if (s === 'wipe') return 'wipe';
  return s === 'true' || s === '1' || s === 'yes' || s === 'shrink' ? 'shrink' : 'no';
};

function esperado({ novo, head, live, allowShrink }) {
  const n = refTotal(novo);
  const totais = [refTotal(head), refTotal(live)].filter((x) => x !== null);
  const baseline = totais.length ? totais.reduce((a, b) => (a > b ? a : b)) : null; // o MAIOR
  const optIn = refOptIn(allowShrink);
  const R = (action, reason, override) => ({ action, reason, override, baseline });

  if (n === null) return optIn === 'no' ? R('block', 'unknown-new', false) : R('allow', 'override-unknown', true);
  if (baseline === null) return R('allow', 'no-baseline', false);
  if (baseline > 0 && (n === 0 || n / baseline < 1 / 10)) { // perda catastrófica: sobra < 10%
    return optIn === 'wipe' ? R('allow', 'override-wipe', true) : R('block', 'wipe', false);
  }
  if (n < baseline) return optIn === 'no' ? R('block', 'shrink', false) : R('allow', 'override-shrink', true);
  return R('allow', n === baseline ? 'same' : 'grow', false);
}

test('enumeração: o veredito bate com a política, recalculada das entradas cruas', () => {
  // Valores ADJACENTES de propósito (2865/2866/2867 e 286/287, os vizinhos da fronteira de 10%):
  // sem eles, uma tolerância de 1% ou um off-by-one no `<` nunca seriam exercitados.
  const VALORES = [null, undefined, '', 0, 1, 10, 286, 287, 2865, 2866, 2867, 3000, '2866', -1, NaN];
  const OPT_INS = [undefined, false, null, 0, '', 'no', 'talvez', true, 'true', '1', 'yes', 'shrink', 'wipe'];
  const vistos = new Map();
  for (const novo of VALORES) {
    for (const head of VALORES) {
      for (const live of VALORES) {
        for (const allowShrink of OPT_INS) {
          const v = evaluateSnapshotChange({ novo, head, live, allowShrink });
          const e = esperado({ novo, head, live, allowShrink });
          const caso = `novo=${String(novo)} head=${String(head)} live=${String(live)} optIn=${String(allowShrink)}`;
          assert.deepEqual(
            { action: v.action, reason: v.reason, override: v.override, baseline: v.counts.baseline },
            e, `veredito divergiu da política em ${caso}`);

          // Invariantes de segurança, também a partir das ENTRADAS (nunca de v.counts):
          const n = refTotal(novo);
          const base = e.baseline;
          if (v.action === 'allow' && !v.override) {
            assert.notEqual(n, null, `liberou sem override com total desconhecido: ${caso}`);
            assert.ok(base === null || n >= base, `liberou sem override encolhendo: ${caso}`);
          }
          if (v.override) assert.notEqual(refOptIn(allowShrink), 'no', `override sem opt-in: ${caso}`);
          if (v.action === 'allow' && n !== null && base !== null && base > 0 && n / base < 1 / 10) {
            assert.equal(refOptIn(allowShrink), 'wipe', `perda catastrófica liberada em ${caso}`);
          }
          if (v.action === 'block') {
            assert.ok(v.message.length > 20 && v.hint && v.hint.includes(SHRINK_OPT_IN), `bloqueio mudo em ${caso}`);
          }
          vistos.set(v.reason, (vistos.get(v.reason) || 0) + 1);
        }
      }
    }
  }
  // Não passou por vacuidade: todo ramo da política foi exercitado nesta enumeração.
  for (const reason of ['grow', 'same', 'no-baseline', 'shrink', 'wipe', 'unknown-new',
    'override-shrink', 'override-wipe', 'override-unknown']) {
    assert.ok(vistos.get(reason) > 0, `o ramo ${reason} nunca apareceu na enumeração`);
  }
});

// ---- F5: pureza ----

test('função pura: mesma entrada => mesma saída, e o veredito não vaza estado', () => {
  const entrada = { novo: 0, head: 2866, live: 2866 };
  const a = evaluateSnapshotChange(entrada);
  const b = evaluateSnapshotChange(entrada);
  assert.deepEqual(a, b);
  assert.notEqual(a.counts, b.counts); // objetos distintos: mexer em um não contamina o outro
  a.counts.baseline = 0;
  a.action = 'allow';
  assert.deepEqual(evaluateSnapshotChange(entrada), b);
  assert.deepEqual(entrada, { novo: 0, head: 2866, live: 2866 }); // não muta a entrada
});
