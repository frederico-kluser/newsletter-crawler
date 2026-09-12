// Teto de TRABALHO INACABADO sobre o piso por fonte (src/cursor.js `applyPendingCeiling`).
//
// Por que existe: o piso por fonte (cursor/derivado) assume "maior data capturada ⇒ tudo abaixo
// está capturado". Isso é FALSO quando a captura anterior foi parcial (`--max-articles`, budget,
// Ctrl+C, deadline): os roundups que ficaram `pending` têm data abaixo do piso, seriam pulados por
// `below-since` e o job marcado `done` — e o `enqueue` (INSERT OR IGNORE) + `isUrlKnown` (conta
// frontier em QUALQUER estado) nunca os trariam de volta: perda permanente, só recuperável por
// `purge`. O teto garante que o piso nunca ultrapassa o backlog pendente da fonte.
//
// Puro: nada aqui toca db/config/rede (cursor.js só importa util.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPendingCeiling } from '../src/cursor.js';

const iso = (d) => d.toISOString().slice(0, 10);
const MIN = new Date('2026-01-01T00:00:00Z');

test('sem pendências o piso resolvido passa intacto', () => {
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'cursor' },
    { oldest: null, undated: 0 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-09-09');
  assert.equal(r.origem, 'cursor');
  assert.equal(r.limitadoPor, null);
});

test('pendência DATADA mais antiga que o piso rebaixa o piso até ela (mantém a origem)', () => {
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'cursor' },
    { oldest: '2026-08-01', undated: 0 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-08-01', 'o backlog drenado — nunca fica abaixo do piso');
  assert.equal(r.origem, 'cursor', 'a origem continua sendo o que resolveu o piso');
  assert.equal(r.limitadoPor, 'backlog');
});

test('pendência datada mais NOVA que o piso não muda nada (caso normal de leftovers)', () => {
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'derivado' },
    { oldest: '2026-09-10', undated: 0 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-09-09');
  assert.equal(r.limitadoPor, null);
});

test('aceita Date ou string ISO no oldest (o stmt devolve ISO YYYY-MM-DD)', () => {
  const a = applyPendingCeiling({ date: '2026-09-09', origem: 'cursor' }, { oldest: new Date('2026-07-15T00:00:00Z') }, { minDate: MIN });
  const b = applyPendingCeiling({ date: '2026-09-09', origem: 'cursor' }, { oldest: '2026-07-15' }, { minDate: MIN });
  assert.equal(iso(a.date), '2026-07-15');
  assert.equal(iso(b.date), '2026-07-15');
});

test('pendência SEM data não prova cobertura: cai no piso mínimo (varre mais, nunca perde)', () => {
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'cursor' },
    { oldest: null, undated: 3 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-01-01');
  assert.equal(r.origem, 'piso-minimo');
  assert.equal(r.limitadoPor, 'backlog');
});

test('o teto vale TAMBÉM para flag explícita: rebaixar varre mais; o alternativo é perder backlog', () => {
  const datada = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'flag' },
    { oldest: '2026-08-01', undated: 0 },
    { minDate: MIN },
  );
  assert.equal(iso(datada.date), '2026-08-01', 'a pendência datada rebaixa o piso mesmo com --since');
  assert.equal(datada.origem, 'flag', 'a origem registra que a flag foi quem pediu o piso');
  assert.equal(datada.limitadoPor, 'backlog');

  const semData = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'flag-fonte' },
    { oldest: null, undated: 1 },
    { minDate: MIN },
  );
  assert.equal(iso(semData.date), '2026-01-01', 'pendência sem data derruba para o mínimo');
  assert.equal(semData.origem, 'piso-minimo');
  assert.equal(semData.limitadoPor, 'backlog');
});

test('piso nulo (sem candidato) continua nulo; sem minDate não inventa data', () => {
  const r = applyPendingCeiling({ date: null, origem: 'piso-minimo' }, { oldest: '2026-08-01', undated: 0 }, {});
  assert.equal(r.date, null);
  const r2 = applyPendingCeiling({ date: null, origem: 'piso-minimo' }, { oldest: null, undated: 2 }, {});
  assert.equal(r2.date, null, 'sem piso mínimo configurado, nada a devolver');
});
