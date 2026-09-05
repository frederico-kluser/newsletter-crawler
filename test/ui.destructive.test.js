// A TUI não pode mais apagar o acervo por REFLEXO. Duas barreiras, as duas fixadas aqui:
//   (1) "Limpar tudo" saiu do menu principal. Ele era a PENÚLTIMA linha, colada no "Sair" —
//       descer até o fim e dar dois Enter apagou o acervo do usuário duas vezes (25/08 e 01/09,
//       7s depois de a TUI abrir). Agora o fim do menu é "Sair" e o destrutivo mora dentro de
//       "Backup e recuperação".
//   (2) A tela de reset mostra o IMPACTO (a mesma conta do CLI, com o US$ de LLM que não volta) e
//       exige DIGITAR o número de artigos — o mesmo desafio que o cmdReset refaz do outro lado
//       (`{yes:true}` sozinho é recusado por ele desde a onda 3).
// NC_HOME temporário ANTES do import (App.js -> commands.js -> db.js abre o banco no load).
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render } from 'ink-testing-library';
import { wait, waitForFrame, selectMenuItem, pointerLine, keys, typeText } from './helpers/ink.js';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-destr-'));
const { html } = await import('../src/ui/html.js');
const { default: App } = await import('../src/ui/App.js');
const { ResetConfirm } = await import('../src/ui/screens.js');
const { stmts, db } = await import('../src/db.js');

// 3 artigos: o desafio numérico da tela passa a ser "digite 3" (com 0 artigos não há o que perder
// e a tela dispensa o desafio, como o próprio checkResetConfirmation).
const src = stmts.upsertSource.get({
  name: 'DestrutivoFeed', base_url: 'https://destrutivo.test', type: 'listing', max_index_pages: null,
});
for (let i = 1; i <= 3; i++) {
  stmts.insertArticle.run({
    source_id: src.id,
    url: `https://destrutivo.test/artigo-${i}`,
    title: `Artigo ${i}`,
    content: 'conteúdo',
    content_hash: `hash-destr-${i}`,
    published_at: '2026-08-13',
    run_id: null,
    kind: 'news',
    issue_url: null,
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });
}

after(() => {
  try {
    db.close();
  } finally {
    rmSync(process.env.NC_HOME, { recursive: true, force: true });
  }
});

const countArticles = () => stmts.countArticles.get().c;

test('T1: descer até o fim do menu e dar dois Enter NÃO apaga nada (o fim é "Sair")', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(120);
  const menu = lastFrame() || '';
  assert.ok(!menu.includes('Limpar tudo'), `o menu principal não pode mais oferecer o reset\n${menu}`);
  assert.ok(menu.includes('Backup e recuperação'), `o menu deve oferecer a manutenção\n${menu}`);

  for (let i = 0; i < 20; i++) {
    stdin.write(keys.DOWN);
    await wait(15);
  }
  const atEnd = pointerLine(lastFrame());
  assert.ok(/Sair/.test(atEnd), `o último item do menu deve ser "Sair", e não o reset — linha: ${atEnd}`);

  stdin.write(keys.ENTER); // 1º Enter: sai do app
  await wait(60);
  stdin.write(keys.ENTER); // 2º Enter (o gesto do incidente)
  await wait(60);
  assert.equal(countArticles(), 3, 'nenhum artigo pode ter sido apagado pelo gesto do incidente');
  unmount();
});

test('T1b: o reset vive no submenu de manutenção, com ⚠ e o nº de artigos no label', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(120);
  await selectMenuItem(stdin, lastFrame, 'Backup e recuperação');
  const frame = await waitForFrame(lastFrame, (f) => f.includes('Limpar tudo'));
  assert.ok(frame.includes('Backups do acervo'), `manutenção deve oferecer os backups\n${frame}`);
  assert.ok(frame.includes('Recuperar o acervo'), `manutenção deve oferecer a recuperação\n${frame}`);
  assert.ok(frame.includes('⚠ Limpar tudo'), `o item destrutivo carrega o glifo de perigo\n${frame}`);
  assert.ok(/APAGA os 3 artigo/.test(frame), `o label diz quantos artigos estão em jogo\n${frame}`);
  // "← Voltar" é a ÚLTIMA linha: descer demais aqui também não cai no destrutivo.
  const lines = frame.split('\n').filter((l) => /Limpar tudo|Voltar/.test(l));
  assert.ok(
    lines.findIndex((l) => l.includes('Limpar tudo')) < lines.findIndex((l) => l.includes('Voltar')),
    `"Voltar" tem que ficar DEPOIS do destrutivo\n${frame}`,
  );
  unmount();
});

test('T1c: entrar no reset pelo submenu mostra o impacto e NÃO apaga nada', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(120);
  await selectMenuItem(stdin, lastFrame, 'Backup e recuperação');
  await waitForFrame(lastFrame, (f) => f.includes('Limpar tudo'));
  await selectMenuItem(stdin, lastFrame, 'Limpar tudo');
  const frame = await waitForFrame(lastFrame, (f) => f.includes('APAGA TODOS OS DADOS'));
  assert.ok(/3 artigo\(s\)/.test(frame), `a tela mostra os artigos que serão perdidos\n${frame}`);
  assert.ok(/US\$/.test(frame), `a tela mostra o gasto de LLM que não volta\n${frame}`);
  assert.ok(frame.includes('.nc-wipe.json'), `a tela avisa do marcador de wipe\n${frame}`);
  assert.ok(frame.includes('webapp/public/data'), `a tela avisa da remoção do snapshot do site\n${frame}`);
  assert.equal(countArticles(), 3);
  unmount();
});

test('T2: a tela de reset RECUSA o número errado e ACEITA o certo', async () => {
  // ---- número ERRADO ----
  let ran = null;
  let backs = 0;
  const wrong = render(
    html`<${ResetConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => { backs += 1; }} />`,
  );
  await wait(60);
  wrong.stdin.write(keys.DOWN); // 2ª opção: "Entendi — quero apagar…" (a 1ª é Cancelar)
  await wait(30);
  wrong.stdin.write(keys.ENTER);
  await waitForFrame(wrong.lastFrame, (f) => f.includes('Digite o número'));
  await typeText(wrong.stdin, '99');
  wrong.stdin.write(keys.ENTER);
  const wrongFrame = await waitForFrame(wrong.lastFrame, (f) => f.includes('NÃO confere'));
  assert.ok(/NÃO confere/.test(wrongFrame), `número errado tem que ser recusado\n${wrongFrame}`);
  assert.ok(/esperado é 3/.test(wrongFrame), `o esperado continua visível\n${wrongFrame}`);
  assert.equal(ran, null, 'número errado NÃO pode disparar o reset');
  wrong.unmount();

  // ---- número CERTO ----
  const right = render(
    html`<${ResetConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => { backs += 1; }} />`,
  );
  await wait(60);
  right.stdin.write(keys.DOWN);
  await wait(30);
  right.stdin.write(keys.ENTER);
  await waitForFrame(right.lastFrame, (f) => f.includes('Digite o número'));
  await typeText(right.stdin, '3');
  right.stdin.write(keys.ENTER);
  await wait(80);
  assert.deepEqual(ran, { sub: 'reset', flags: { yes: true, confirm: '3' } });
  right.unmount();

  assert.equal(countArticles(), 3, 'a tela NUNCA apaga por conta própria (quem apaga é o cmdReset)');
});

test('T2c: a tentativa recusada LIMPA o campo (senão a 2ª vira "993" e nunca acerta)', async () => {
  let ran = null;
  const r = render(html`<${ResetConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => {}} />`);
  await wait(60);
  r.stdin.write(keys.DOWN);
  await wait(30);
  r.stdin.write(keys.ENTER);
  await waitForFrame(r.lastFrame, (f) => f.includes('Digite o número'));
  await typeText(r.stdin, '99');
  r.stdin.write(keys.ENTER);
  await waitForFrame(r.lastFrame, (f) => f.includes('NÃO confere'));
  await typeText(r.stdin, '3'); // no MESMO campo: só funciona se ele foi remontado vazio
  r.stdin.write(keys.ENTER);
  await wait(100);
  assert.deepEqual(ran, { sub: 'reset', flags: { yes: true, confirm: '3' } });
  r.unmount();
});

test('T2b: Enter vazio no desafio cancela e volta; a 1ª opção da tela também é cancelar', async () => {
  let ran = null;
  let backs = 0;
  const r = render(
    html`<${ResetConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => { backs += 1; }} />`,
  );
  await wait(60);
  r.stdin.write(keys.ENTER); // 1ª opção = "Não — cancelar"
  await wait(60);
  assert.equal(backs, 1, 'o Enter direto na tela de reset CANCELA');
  assert.equal(ran, null);
  r.unmount();

  const r2 = render(
    html`<${ResetConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => { backs += 1; }} />`,
  );
  await wait(60);
  r2.stdin.write(keys.DOWN);
  await wait(30);
  r2.stdin.write(keys.ENTER);
  await waitForFrame(r2.lastFrame, (f) => f.includes('Digite o número'));
  r2.stdin.write(keys.ENTER); // submit VAZIO = desistir
  await wait(80);
  assert.equal(backs, 2, 'submit vazio no desafio volta ao menu');
  assert.equal(ran, null);
  r2.unmount();
});
