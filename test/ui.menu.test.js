// Smoke da UI sem TTY real: ink-testing-library renderiza o App p/ string e conferimos os labels
// do menu. (O idioma vem de CRAWLER_LANG no load do módulo; o EN é checado em subprocesso.)
// A tela Chave LLM é exercitada por DIAGNÓSTICO do probe (sem rede vs chave recusada): o baseURL
// da DeepSeek é lido do ENV em call-time, então servidores locais simulam os dois casos — mesmo
// seam do test/keys.test.js. Nenhum caso chega ao `upsertEnvVar` (falha antes), então o NC_HOME
// real NÃO é tocado.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';
import { wait, selectMenuItem, keys, typeText } from './helpers/ink.js';

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
  broken.close(); // idempotente
  refuser.close();
});

test('UI: o menu lista as ações principais (PT)', () => {
  const { lastFrame, unmount } = render(html`<${App} />`);
  const frame = lastFrame() || '';
  for (const label of [
    'newsletter-crawler', 'Coletar', 'Buscar', 'Status', 'Exportar', 'Finalizar',
    'Adicionar', 'Limites', 'Chave', 'Limpar',
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
