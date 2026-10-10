// Modo de desenvolvimento LLM (devtrace): o trace JSONL é para a LLM analisar erros em tempo real,
// NÃO para o utilizador — o contrato é: off = zero I/O; on = JSONL imediato em NC_HOME/logs com
// redação de segredos, truncagem e retenção. Os testes fixam exatamente isso.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeSync, openSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// CONTRATO DE ISOLAMENTO: NC_HOME tmp ANTES do 1º import que alcança config.js/db.js.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-devtrace-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const {
  maybeInitDevTrace, devTrace, devTraceErr, devTraceEnabled, devTracePath, endDevTrace,
} = await import('../src/devtrace.js');

const readTrace = () => readFileSync(devTracePath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('off por default: devTrace é no-op e nada toca o disco', () => {
  assert.equal(devTraceEnabled(), false);
  devTrace('qualquer.coisa', { x: 1 }); // não pode lançar nem escrever
  devTraceErr('qualquer.erro', new Error('oi'));
  assert.equal(devTracePath(), null);
  assert.equal(existsSync(path.join(process.env.NC_HOME, 'logs')), false, 'nenhum dir de logs criado');
});

test('on via env: JSONL + meta + latest.jsonl + seq monotônico + end', () => {
  process.env.NC_LLM_DEV = '1';
  const file = maybeInitDevTrace({ command: 'crawl', argv: ['crawl', '--since', '2026-10-09'], meta: { version: 'test' } });
  assert.ok(file && existsSync(devTracePath()), 'abriu o trace');
  assert.equal(devTraceEnabled(), true);

  devTrace('job.start', { url: 'https://ex.test/a', kind: 'article' });
  devTraceErr('job.failed', new Error('explodi'), { url: 'https://ex.test/a' });
  endDevTrace({ ok: true });

  const evs = readTrace();
  assert.equal(evs[0].type, 'meta');
  assert.equal(evs[0].command, 'crawl');
  assert.deepEqual(evs[0].argv, ['crawl', '--since', '2026-10-09']);
  assert.equal(evs[1].type, 'job.start');
  const seqs = evs.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq monotônico');
  const fail = evs.find((e) => e.type === 'job.failed');
  assert.match(fail.err.stack, /explodi/, 'erro vira {error,message,stack}');
  assert.equal(evs.at(-1).type, 'end');
  assert.equal(devTraceEnabled(), false, 'endDevTrace fecha o trace');

  // Ponteiro estável p/ tail -f (symlink relativo, mesmo padrão do latest.log).
  const latest = path.join(process.env.NC_HOME, 'logs', 'latest.jsonl');
  assert.ok(existsSync(latest), 'latest.jsonl existe');
  delete process.env.NC_LLM_DEV;
});

test('redige segredos e trunca o gigante em QUALQUER profundidade', () => {
  // Token montado por CONCATENAÇÃO: o GitHub Push Protection varre o arquivo commitado e um
  // token literal aqui (mesmo sendo teste) derrubaria o push (GH013, ago/2026).
  const token = ['sk-', 'ant', 'ropic', '0123456789abcdef0123456789abcdef0123456789abcdef'].join('');
  process.env.NC_LLM_DEV = '1';
  process.env.NC_LLM_DEV_MAX_CHARS = '100';
  maybeInitDevTrace({ command: 'teste', argv: [] });
  devTrace('llm.attempt', {
    content: `resposta com ${token} no meio`,
    nested: { deep: [{ texto: 'x'.repeat(300) }] },
  });
  const evs = readTrace();
  const ev = evs.find((e) => e.type === 'llm.attempt');
  assert.ok(!JSON.stringify(ev).includes(token), 'segredo redigido (nem no nested)');
  assert.match(JSON.stringify(ev), /\[REDACTED\]/);
  assert.match(ev.nested.deep[0].texto, /\[TRUNCADO \d+ chars\]$/, 'gigante truncado com marcador');
  assert.ok(ev.nested.deep[0].texto.length < 150, 'truncado de fato');
  endDevTrace();
  delete process.env.NC_LLM_DEV;
  delete process.env.NC_LLM_DEV_MAX_CHARS;
});

test('retenção: só os NC_LLM_DEV_KEEP traces mais recentes ficam', () => {
  const dir = path.join(process.env.NC_HOME, 'logs');
  // 5 traces antigos FAKE (nomes carregam timestamp => ordem cronológica).
  for (let i = 0; i < 5; i += 1) {
    const f = path.join(dir, `trace-2020-01-0${i + 1}T00-00-00-000Z-1.jsonl`);
    writeSync(openSync(f, 'a'), '{}\n');
  }
  process.env.NC_LLM_DEV = '1';
  process.env.NC_LLM_DEV_KEEP = '3';
  maybeInitDevTrace({ command: 'teste', argv: [] });
  const restantes = readdirSync(dir).filter((f) => /^trace-.*\.jsonl$/.test(f)).sort();
  assert.equal(restantes.length, 3, 'poda manteve só 3 (os mais recentes: os fakes de 2020 saem)');
  assert.ok(restantes.every((f) => !f.includes('2020-01-0')), 'os antigos foram apagados');
  endDevTrace();
  delete process.env.NC_LLM_DEV;
  delete process.env.NC_LLM_DEV_KEEP;
});

test('fail-open: filesystem recusou => desliga o trace, nunca derruba o comando', () => {
  process.env.NC_LLM_DEV = '1';
  // NC_HOME apontando p/ um ARQUIVO (não dir): mkdirSync falha => fail-open.
  const comoArquivo = path.join(os.tmpdir(), `nc-devtrace-arquivo-${process.pid}`);
  writeSync(openSync(comoArquivo, 'a'), '');
  process.env.NC_HOME = comoArquivo;
  assert.equal(maybeInitDevTrace({ command: 'x', argv: [] }), null, 'não abriu');
  devTrace('a', { b: 1 }); // não lança
  assert.equal(devTraceEnabled(), false);
  // Restaura com um tmp LITERAL (a malha de isolamento do NC_HOME reprova RHS opaco vindo de
  // process.env.NC_HOME — ver test/nc-home-isolation.test.js).
  process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-devtrace-'));
  rmSync(comoArquivo, { force: true });
  delete process.env.NC_LLM_DEV;
});
