// Pinna a semântica do setter dinâmico do p-limit — a base das lanes do governador:
// grow acorda a fila imediatamente; shrink é NÃO-preemptivo (ativos acima da nova capacidade
// terminam; nenhuma admissão nova até drenar). Se isto quebrar numa atualização do p-limit,
// o governor precisa de um gate próprio (fallback documentado no plano). npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pLimit from 'p-limit';

const tick = () => new Promise((r) => setImmediate(r));

test('p-limit: grow acorda a fila na hora', async () => {
  const limit = pLimit(1);
  const release = [];
  const task = () => limit(() => new Promise((r) => release.push(r)));
  const ps = [task(), task(), task()];
  await tick();
  assert.equal(limit.activeCount, 1);
  assert.equal(limit.pendingCount, 2);
  limit.concurrency = 3;
  await tick();
  assert.equal(limit.activeCount, 3, 'grow admite a fila inteira');
  assert.equal(limit.pendingCount, 0);
  release.forEach((r) => r());
  await Promise.all(ps);
});

test('p-limit: shrink é não-preemptivo e só readmite após drenar', async () => {
  const limit = pLimit(2);
  const release = [];
  const task = () => limit(() => new Promise((r) => release.push(r)));
  const ps = [task(), task(), task()];
  await tick();
  assert.equal(limit.activeCount, 2);
  assert.equal(limit.pendingCount, 1);

  limit.concurrency = 1;
  await tick();
  assert.equal(limit.activeCount, 2, 'não cancela trabalho em voo');
  assert.equal(limit.pendingCount, 1);

  release.shift()(); // termina o 1º; active(1) == capacity(1) -> fila segue esperando
  await tick();
  assert.equal(limit.activeCount, 1);
  assert.equal(limit.pendingCount, 1);

  release.shift()(); // termina o 2º; agora active(0) < capacity(1) -> admite o 3º
  await tick();
  assert.equal(limit.activeCount, 1);
  assert.equal(limit.pendingCount, 0);

  release.shift()();
  await Promise.all(ps);
});
