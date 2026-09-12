// Cursor de data POR FONTE — camada PURA (src/cursor.js): o parse da flag `--since-source` e a
// resolução do piso efetivo de UMA fonte. Nada aqui toca db/config/rede (cursor.js só importa
// util.js, que é puro), por isso o import pode ser ESTÁTICO — o nc-home-isolation.test.js só
// reprova estático que ALCANCE config.js/db.js.
//
// O que este arquivo fixa: a PRECEDÊNCIA (override > --since > cursor > derivado > mínimo), o
// CLAMP no piso mínimo, o TETO de data futura (que só invalida valor AUTOMÁTICO — flag explícita
// passa) e o vocabulário de `origem` que o log do crawl imprime (`piso <fonte>: <data> (<origem>)`)
// — quem lê o log para diagnosticar uma coleta depende dele. Fecha também casos de borda do
// `applyPendingCeiling` (teto do trabalho inacabado) que complementam test/cursor.pending.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSinceSourceFlag, resolveSourceFloor, applyPendingCeiling } from '../src/cursor.js';

const iso = (d) => d.toISOString().slice(0, 10);

// ---- parseSinceSourceFlag: `Nome=AAAA-MM-DD[,Outro=...]` -> Map(nomeLower -> Date) ----

test('parseSinceSourceFlag: um par vira Map com o NOME em minúsculas e a data parseada', () => {
  const m = parseSinceSourceFlag('JS Weekly=2026-01-02');
  assert.ok(m instanceof Map);
  assert.equal(m.size, 1);
  assert.deepEqual([...m.keys()], ['js weekly'], 'a chave é normalizada (case-insensitive)');
  assert.equal(iso(m.get('js weekly')), '2026-01-02');
});

test('parseSinceSourceFlag: lista por vírgula com espaços no nome e no valor', () => {
  const m = parseSinceSourceFlag(' JS Weekly = 2026-01-02 , Node Weekly=2026-03-04 ');
  assert.equal(m.size, 2);
  assert.equal(iso(m.get('js weekly')), '2026-01-02', 'trim do nome e do valor');
  assert.equal(iso(m.get('node weekly')), '2026-03-04');
});

test('parseSinceSourceFlag: item inválido é IGNORADO sem derrubar os válidos (fail-open)', () => {
  const m = parseSinceSourceFlag('Boa=2026-01-02,sem-igual,=2026-01-03,Quebrada=ontem,Vazia=,Outra=2026-05-06');
  assert.deepEqual([...m.keys()], ['boa', 'outra']);
  assert.equal(iso(m.get('outra')), '2026-05-06');
});

test('parseSinceSourceFlag: string vazia/branca/ausente/não-string -> Map vazio', () => {
  assert.equal(parseSinceSourceFlag('').size, 0);
  assert.equal(parseSinceSourceFlag('   ').size, 0);
  assert.equal(parseSinceSourceFlag(',').size, 0);
  assert.equal(parseSinceSourceFlag(undefined).size, 0);
  assert.equal(parseSinceSourceFlag(null).size, 0);
  assert.equal(parseSinceSourceFlag(42).size, 0);
});

test('parseSinceSourceFlag: data ambígua NÃO vira piso silencioso (inparseável fora)', () => {
  // '2026-13-45' não existe e 'ontem' não é data — parseDate -> null -> par descartado.
  assert.equal(parseSinceSourceFlag('X=2026-13-45').size, 0);
  // Date-only ISO é o formato canônico documentado na flag.
  assert.equal(iso(parseSinceSourceFlag('X=2026-09-12').get('x')), '2026-09-12');
});

// ---- resolveSourceFloor: precedência, clamp e ausência total ----

const MIN = '2026-01-01';
const CANDIDATOS = {
  override: '2026-05-05',
  explicitSince: '2026-04-04',
  cursor: '2026-03-03',
  derived: '2026-02-02',
};

test('resolveSourceFloor: cada origem da precedência, do mais específico ao mais genérico', () => {
  assert.deepEqual(resolveSourceFloor({ ...CANDIDATOS, minDate: MIN }), {
    date: new Date('2026-05-05'), origem: 'flag-fonte',
  });

  assert.deepEqual(resolveSourceFloor({ ...CANDIDATOS, override: null, minDate: MIN }), {
    date: new Date('2026-04-04'), origem: 'flag',
  });

  assert.deepEqual(resolveSourceFloor({ ...CANDIDATOS, override: null, explicitSince: null, minDate: MIN }), {
    date: new Date('2026-03-03'), origem: 'cursor',
  });

  assert.deepEqual(
    resolveSourceFloor({ ...CANDIDATOS, override: null, explicitSince: null, cursor: null, minDate: MIN }),
    { date: new Date('2026-02-02'), origem: 'derivado' },
  );
});

test('resolveSourceFloor: candidato inparseável é pulado e o próximo da fila assume', () => {
  assert.deepEqual(resolveSourceFloor({ ...CANDIDATOS, override: 'lixo', minDate: MIN }), {
    date: new Date('2026-04-04'), origem: 'flag',
  });
  assert.deepEqual(
    resolveSourceFloor({ ...CANDIDATOS, override: 'lixo', explicitSince: 'também não é data', minDate: MIN }),
    { date: new Date('2026-03-03'), origem: 'cursor' },
  );
});

test('resolveSourceFloor: aceita Date E string ISO (a flag entrega Date, o db entrega string)', () => {
  const d = new Date('2026-07-07T00:00:00Z');
  assert.deepEqual(resolveSourceFloor({ override: d, explicitSince: CANDIDATOS.explicitSince, minDate: MIN }), {
    date: d, origem: 'flag-fonte',
  });
  // cursor vindo do SQLite é string 'YYYY-MM-DD'; derived também.
  assert.deepEqual(resolveSourceFloor({ cursor: '2026-03-03', derived: new Date('2026-02-02T00:00:00Z'), minDate: MIN }), {
    date: new Date('2026-03-03'), origem: 'cursor',
  });
});

test('resolveSourceFloor: clamp no piso mínimo — candidato anterior devolve o mínimo', () => {
  assert.deepEqual(resolveSourceFloor({ override: '2025-12-31', minDate: MIN }), {
    date: new Date(MIN), origem: 'piso-minimo',
  });
  // vale para qualquer degrau da fila, não só o primeiro
  assert.deepEqual(resolveSourceFloor({ cursor: '2025-06-01', minDate: MIN }), {
    date: new Date(MIN), origem: 'piso-minimo',
  });
  assert.deepEqual(resolveSourceFloor({ derived: '2025-06-01', minDate: MIN }), {
    date: new Date(MIN), origem: 'piso-minimo',
  });
  // minDate também aceita string (vem de config como ISO/data)
  assert.deepEqual(resolveSourceFloor({ cursor: '2020-01-01', minDate: '2026-01-01' }), {
    date: new Date(MIN), origem: 'piso-minimo',
  });
});

test('resolveSourceFloor: o piso é INCLUSIVO — candidato IGUAL ao mínimo mantém a própria origem', () => {
  assert.deepEqual(resolveSourceFloor({ cursor: MIN, minDate: MIN }), {
    date: new Date(MIN), origem: 'cursor',
  });
  assert.deepEqual(resolveSourceFloor({ override: MIN, minDate: MIN }), {
    date: new Date(MIN), origem: 'flag-fonte',
  });
});

test('resolveSourceFloor: ausência total -> piso mínimo (ou null sem mínimo), origem piso-minimo', () => {
  assert.deepEqual(resolveSourceFloor({ minDate: MIN }), { date: new Date(MIN), origem: 'piso-minimo' });
  assert.deepEqual(resolveSourceFloor({ minDate: MIN, override: null, explicitSince: null, cursor: null, derived: null }), {
    date: new Date(MIN), origem: 'piso-minimo',
  });
  // sem piso mínimo conhecido o piso é "sem piso" — não inventa data
  assert.deepEqual(resolveSourceFloor({}), { date: null, origem: 'piso-minimo' });
  assert.deepEqual(resolveSourceFloor(), { date: null, origem: 'piso-minimo' });
  assert.deepEqual(resolveSourceFloor({ override: null, cursor: null, minDate: null }), {
    date: null, origem: 'piso-minimo',
  });
});

test('resolveSourceFloor: valor AUTOMÁTICO no futuro é DESCARTADO e a resolução cai para o próximo', () => {
  const HOJE = new Date('2026-09-12T12:00:00Z');
  // Cursor envenenado por scrape errado (JSON-LD de "próxima edição", ano trocado): usá-lo como
  // piso pularia TODO o intervalo até essa data — o derivado (mais velho e real) assume.
  assert.deepEqual(
    resolveSourceFloor({ cursor: '2027-05-05', derived: '2026-08-01', minDate: MIN, maxDate: HOJE }),
    { date: new Date('2026-08-01'), origem: 'derivado' },
  );
  // Todos os candidatos automáticos no futuro -> piso mínimo (coleta normal, sem pular nada).
  assert.deepEqual(
    resolveSourceFloor({ derived: '2027-01-01', minDate: MIN, maxDate: HOJE }),
    { date: new Date(MIN), origem: 'piso-minimo' },
  );
  // Futuro no cursor mas derivado válido: o derivado assume (nunca "tudo futuro -> mínimo" cedo).
  assert.deepEqual(
    resolveSourceFloor({ cursor: '2027-01-01', derived: '2026-03-03', minDate: MIN, maxDate: HOJE }),
    { date: new Date('2026-03-03'), origem: 'derivado' },
  );
});

test('resolveSourceFloor: FLAG explícita no futuro passa como veio (escolha do usuário, não scrape)', () => {
  const HOJE = new Date('2026-09-12T12:00:00Z');
  // "Hoje" num fuso à frente do UTC é futuro em UTC — descartar a flag explícita transformaria a
  // coleta pedida pelo usuário num no-op silencioso. A guarda de futuro vale só p/ cursor/derivado.
  assert.deepEqual(
    resolveSourceFloor({ override: '2027-01-01', minDate: MIN, maxDate: HOJE }),
    { date: new Date('2027-01-01'), origem: 'flag-fonte' },
  );
  assert.deepEqual(
    resolveSourceFloor({ explicitSince: '2027-01-01', cursor: '2026-03-03', minDate: MIN, maxDate: HOJE }),
    { date: new Date('2027-01-01'), origem: 'flag' },
  );
  // Uma flag futura POLEIROSA (ou com ano errado) ainda é clampada pelo piso mínimo, não pelo teto.
  assert.deepEqual(
    resolveSourceFloor({ override: '2025-12-31', minDate: MIN, maxDate: HOJE }),
    { date: new Date(MIN), origem: 'piso-minimo' },
  );
  // E o override futuro vence o --since válido (precedência intacta), sem ser descartado.
  assert.deepEqual(
    resolveSourceFloor({ override: '2027-01-01', explicitSince: '2026-06-06', minDate: MIN, maxDate: HOJE }),
    { date: new Date('2027-01-01'), origem: 'flag-fonte' },
  );
});

test('resolveSourceFloor: maxDate inclui o PRÓPRIO instante (UTC+13 publica "amanhã")', () => {
  const AGORA = new Date('2026-09-12T12:00:00Z');
  assert.deepEqual(resolveSourceFloor({ cursor: '2026-09-12T00:00:00Z', minDate: MIN, maxDate: AGORA }), {
    date: new Date('2026-09-12T00:00:00Z'), origem: 'cursor',
  }, 'exatamente no teto é válido (a comparação é estritamente futura)');
  assert.deepEqual(resolveSourceFloor({ cursor: '2026-09-12T12:00:00.001Z', minDate: MIN, maxDate: AGORA }), {
    date: new Date(MIN), origem: 'piso-minimo',
  }, '1 ms depois já é futuro');
});

test('resolveSourceFloor: sem maxDate não há teto (o relógio é responsabilidade do chamador)', () => {
  // A função é PURA: não consulta o relógio. Quem chama (commands.js, no seed) passa
  // `maxDate: new Date()`; aqui fica dito que o teto é opcional e que Date/string servem.
  assert.deepEqual(resolveSourceFloor({ cursor: '2099-01-01', minDate: MIN }), {
    date: new Date('2099-01-01'), origem: 'cursor',
  });
  assert.deepEqual(
    resolveSourceFloor({ cursor: '2099-01-01', minDate: MIN, maxDate: '2026-09-12T12:00:00Z' }),
    { date: new Date(MIN), origem: 'piso-minimo' },
  );
  const teto = new Date('2026-09-12T12:00:00Z');
  assert.deepEqual(resolveSourceFloor({ cursor: '2099-01-01', minDate: MIN, maxDate: teto }), {
    date: new Date(MIN), origem: 'piso-minimo',
  });
});

test('resolveSourceFloor: NÃO muta nem reparseia o Date recebido (devolve a mesma instância)', () => {
  const d = new Date('2026-05-05T00:00:00Z');
  assert.equal(resolveSourceFloor({ override: d, minDate: MIN }).date, d);
});

test('resolveSourceFloor: cada origem é um rótulo estável (o log do crawl imprime literalmente)', () => {
  const origens = new Set([
    resolveSourceFloor({ override: '2026-05-05', minDate: MIN }).origem,
    resolveSourceFloor({ explicitSince: '2026-05-05', minDate: MIN }).origem,
    resolveSourceFloor({ cursor: '2026-05-05', minDate: MIN }).origem,
    resolveSourceFloor({ derived: '2026-05-05', minDate: MIN }).origem,
    resolveSourceFloor({ minDate: MIN }).origem,
  ]);
  assert.deepEqual([...origens].sort(), ['cursor', 'derivado', 'flag', 'flag-fonte', 'piso-minimo']);
});

// ---- applyPendingCeiling: teto do trabalho INACABADO (casos que complementam test/cursor.pending.test.js) ----

test('applyPendingCeiling: pendência SEM data vence a datada (não prova cobertura nenhuma)', () => {
  // As duas existem: o ramo sem data é o mais conservador e sai primeiro, ignorando `oldest`.
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'cursor' },
    { oldest: '2026-02-02', undated: 1 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-01-01', 'derruba para o piso mínimo, não para a pendência datada');
  assert.equal(r.origem, 'piso-minimo');
  assert.equal(r.limitadoPor, 'backlog');
});

test('applyPendingCeiling: pendência EXATAMENTE no piso não rebaixa (o piso é inclusivo)', () => {
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'cursor' },
    { oldest: '2026-09-09', undated: 0 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-09-09', 'o item no piso é re-checado; não há o que rebaixar');
  assert.equal(r.limitadoPor, null, 'sem rebaixamento não há "limitado por pendências" no log');
});

test('applyPendingCeiling: oldest inparseável é ignorado (fail-open, o piso fica)', () => {
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'derivado' },
    { oldest: 'não é data', undated: 0 },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-09-09');
  assert.equal(r.limitadoPor, null);
});

test('applyPendingCeiling: o SUM do SQLite devolve NULL sem linhas — não pode derrubar o piso', () => {
  // `oldestUnfinishedForSource` agrega com SUM(): fonte sem NENHUMA linha na frontier devolve
  // {d: null, undated: null}. O `?? 0` do cursor.js é o que impede o null de virar "tem pendência".
  const r = applyPendingCeiling(
    { date: new Date('2026-09-09T00:00:00Z'), origem: 'cursor' },
    { oldest: null, undated: null },
    { minDate: MIN },
  );
  assert.equal(iso(r.date), '2026-09-09');
  assert.equal(r.limitadoPor, null);
});

test('applyPendingCeiling: pendência sem data derruba para o mínimo mesmo SEM piso resolvido', () => {
  const r = applyPendingCeiling({ date: null, origem: 'piso-minimo' }, { oldest: null, undated: 2 }, { minDate: MIN });
  assert.equal(iso(r.date), '2026-01-01', 'a varredura mais ampla possível é o fallback seguro');
  assert.equal(r.origem, 'piso-minimo');
  assert.equal(r.limitadoPor, 'backlog');
});
