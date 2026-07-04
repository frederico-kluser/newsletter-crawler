// Núcleo do eval de LOTE: scoring ESTRITO (direct) vs AMPLO (direct∪similar) — a métrica que
// separa a busca precisão-primeiro (o toggle "estrito") do comportamento atual. Puro, sem LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCell, REL_BROAD, REL_STRICT } from '../eval/score.mjs';

const rec = (id, gtRel, predRel) => ({ scn: 'S1', id, gtRel, predRel, gtKind: 'news', predKind: 'news', ms: 10, fail: false });

test('AMPLO: direct∪similar contam como relevantes', () => {
  const recs = [rec(1, 'direct', 'direct'), rec(2, 'similar', 'direct'), rec(3, 'none', 'none')];
  const broad = scoreCell(recs, { isRel: REL_BROAD });
  assert.equal(broad.macroPrecision, 1);
  assert.equal(broad.macroRecall, 1);
});

test('ESTRITO: "direct" super-chamado vira falso positivo (similar previsto direct)', () => {
  const recs = [rec(1, 'direct', 'direct'), rec(2, 'similar', 'direct'), rec(3, 'none', 'none')];
  const strict = scoreCell(recs, { isRel: REL_STRICT });
  // gt relevante estrito = {1}; previsto direct = {1,2} → tp=1, fp=1 (id 2) → P=0.5, R=1
  assert.equal(strict.macroPrecision, 0.5);
  assert.equal(strict.macroRecall, 1);
});

test('default de scoreCell = AMPLO (similar conta como relevante)', () => {
  const recs = [rec(1, 'similar', 'similar')];
  assert.equal(scoreCell(recs).macroRecall, 1);
});

test('acc3way e kindAcc independem de isRel', () => {
  const recs = [rec(1, 'direct', 'direct'), rec(2, 'similar', 'none')];
  const a = scoreCell(recs, { isRel: REL_BROAD });
  const b = scoreCell(recs, { isRel: REL_STRICT });
  assert.equal(a.acc3way, b.acc3way);
  assert.equal(a.acc3way, 0.5); // 1 de 2 rótulos 3-vias exatos
});

test('cenário vazio não quebra (divisões por zero viram 0)', () => {
  const s = scoreCell([], { isRel: REL_STRICT });
  assert.equal(s.macroF1, 0);
  assert.equal(s.n, 0);
});
