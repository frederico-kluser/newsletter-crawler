// Smoke da UI sem TTY real: ink-testing-library renderiza o App p/ string e conferimos os labels
// do menu. (O idioma vem de CRAWLER_LANG no load do módulo; o EN é checado em subprocesso.)
// A tela Chave LLM é exercitada por DIAGNÓSTICO do probe (sem rede vs chave recusada): o baseURL
// da DeepSeek é lido do ENV em call-time, então servidores locais simulam os dois casos — mesmo
// seam do test/keys.test.js. Nenhum caso chega ao `upsertEnvVar` (falha antes).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render } from 'ink-testing-library';
import { wait, selectMenuItem, keys, typeText } from './helpers/ink.js';

// NC_HOME temporário ANTES do import (App.js -> commands.js -> db.js abre o DB no load: com o
// NC_HOME real, `npm test` abriria o crawler.db do USUÁRIO em ESCRITA). Import dinâmico porque o
// `import` estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-menu-'));
const { html } = await import('../src/ui/html.js');
const { default: App } = await import('../src/ui/App.js');
const { db } = await import('../src/db.js');

// Servidor que DESTRÓI o socket = erro de REDE real (o got lança, o probe devolve {ok:false,status:0}).
const broken = http.createServer((req, res) => res.destroy());
await new Promise((r) => broken.listen(0, '127.0.0.1', r));
const DS_BROKEN_URL = `http://127.0.0.1:${broken.address().port}`;
// 401 = chave recusada pela API (HTTP real, mesma semântica do test/keys.test.js).
const refuser = http.createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"Authentication Fails"}}');
});
await new Promise((r) => refuser.listen(0, '127.0.0.1', r));
const DS_401_URL = `http://127.0.0.1:${refuser.address().port}`;
const ORIG_DS_BASE = process.env.DEEPSEEK_BASE_URL; // restaurar no fim (máquina pode ter setada)
after(() => {
  if (ORIG_DS_BASE === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = ORIG_DS_BASE;
  // finally: um close() que lance não pode deixar o diretório temporário para trás.
  try {
    broken.close(); // idempotente
    refuser.close();
    db.close();
  } finally {
    rmSync(process.env.NC_HOME, { recursive: true, force: true });
  }
});

test('UI: o menu lista as ações principais (PT)', () => {
  const { lastFrame, unmount } = render(html`<${App} />`);
  const frame = lastFrame() || '';
  // "Limpar tudo" NÃO está mais aqui: mudou para o submenu "Backup e recuperação" (ver
  // test/ui.destructive.test.js — ele era a penúltima linha, colada no "Sair").
  for (const label of [
    'newsletter-crawler', 'Coletar', 'Buscar', 'Status', 'Exportar', 'Finalizar',
    'Adicionar', 'Limites', 'Chave', 'Backup e recuperação',
  ]) {
    assert.ok(frame.includes(label), `o menu deve conter "${label}"\n--- frame ---\n${frame}`);
  }
  unmount();
});

// Abre a tela Chave LLM e submete uma chave no provedor DeepSeek (2ª opção do Select).
async function openKeyScreen(stdin, lastFrame) {
  await wait(80);
  await selectMenuItem(stdin, lastFrame, 'Chave'); // item "Chave LLM" do menu
  await wait(40);
  stdin.write(keys.DOWN); // 2ª opção do Select de provedor: "DeepSeek (API direta)"
  await wait(20);
  stdin.write(keys.ENTER);
  await wait(80); // monta o passo da chave (TextInput)
  // typeText = caractere a caractere (um write da string inteira faz o submit ler valor vazio).
  await typeText(stdin, 'sk-ds-xyz');
  stdin.write(keys.ENTER); // submete -> probe no servidor local
}

// Espera o resultado ASSÍNCRONO do probe aparecer no frame (o submit é async).
async function waitFor(lastFrame, needle, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((lastFrame() || '').includes(needle)) return true;
    await wait(50);
  }
  return (lastFrame() || '').includes(needle);
}

test('UI: erro de REDE no probe da chave mostra "sem rede", não "chave inválida"', async () => {
  process.env.DEEPSEEK_BASE_URL = DS_BROKEN_URL;
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await openKeyScreen(stdin, lastFrame);
  assert.ok(
    await waitFor(lastFrame, 'sem rede'),
    `rede fora deve mostrar o aviso do probe (keyProbeFail)\n${lastFrame()}`,
  );
  assert.ok(
    !(lastFrame() || '').includes('Chave inválida'),
    `rede fora NÃO é chave inválida (diagnóstico falso)\n${lastFrame()}`,
  );
  unmount();
});

test('UI: chave recusada pela API (HTTP 401) mostra "chave inválida"', async () => {
  process.env.DEEPSEEK_BASE_URL = DS_401_URL;
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await openKeyScreen(stdin, lastFrame);
  assert.ok(
    await waitFor(lastFrame, 'Chave inválida'),
    `401 deve mostrar "Chave inválida" (keyInvalid)\n${lastFrame()}`,
  );
  unmount();
});
