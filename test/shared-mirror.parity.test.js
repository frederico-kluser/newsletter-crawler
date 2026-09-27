// PARIDADE do código compartilhado CLI × site: todo src/shared/*.js tem cópia BYTE-IDÊNTICA em
// webapp/src/shared/ (scripts/sync-shared.mjs) e nenhum deles importa Node ou DOM — é o que deixa o
// Vite empacotar o mesmo núcleo do Jev que o crawler usa (limiares calibrados no Node valem no site).
// Deriva aqui = rode `node scripts/sync-shared.mjs` (e edite só src/shared/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffMirror, syncMirror, listShared, SRC_DIR, MIRROR_DIR } from '../scripts/sync-shared.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sync-shared.mjs');

// Tira comentários antes da varredura: a prosa em português ("processo", "document.") não conta.
// Ingênuo de propósito (um '//' dentro de string corta o resto da linha) — só encolhe o que é varrido.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('todo src/shared/*.js tem espelho byte-idêntico em webapp/src/shared/ (sem órfãos)', () => {
  const d = diffMirror();
  assert.ok(d.files.includes('jev-core.js'), 'src/shared/jev-core.js é a cópia canônica do núcleo');
  const hint = ' — rode `node scripts/sync-shared.mjs`';
  assert.deepEqual(d.missing, [], `sem cópia no espelho${hint}`);
  assert.deepEqual(d.changed, [], `espelho difere do original${hint}`);
  assert.deepEqual(d.orphans, [], `órfão no espelho sem original em src/shared${hint} --prune`);
  for (const f of d.files) {
    assert.ok(readFileSync(path.join(SRC_DIR, f)).equals(readFileSync(path.join(MIRROR_DIR, f))), f);
  }
});

test('código compartilhado é ISOMÓRFICO: só imports relativos, nada de Node/DOM', () => {
  const files = listShared(SRC_DIR);
  assert.ok(files.length > 0);
  for (const f of files) {
    const code = stripComments(readFileSync(path.join(SRC_DIR, f), 'utf8'));
    const specs = [...code.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g), ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
      (m) => m[1],
    );
    for (const s of specs) assert.ok(s.startsWith('./'), `${f}: import "${s}" — compartilhado só importa irmãos (./x.js)`);
    for (const [re, what] of [
      [/\brequire\s*\(/, 'require()'],
      [/\bprocess\./, 'process.*'],
      [/\bBuffer\b/, 'Buffer'],
      [/\b__dirname\b|\b__filename\b/, '__dirname'],
      [/\bwindow\./, 'window.*'],
      [/\bdocument\./, 'document.*'],
      [/\blocalStorage\b|\bsessionStorage\b/, 'storage do browser'],
    ]) {
      assert.ok(!re.test(code), `${f}: usa ${what} — o arquivo roda no Node E no browser`);
    }
  }
});

test('o espelho importa sozinho e expõe as MESMAS exportações do original', async () => {
  for (const f of listShared(SRC_DIR)) {
    const a = await import(pathToFileURL(path.join(SRC_DIR, f)).href);
    const b = await import(pathToFileURL(path.join(MIRROR_DIR, f)).href);
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), f);
  }
});

test('sync-shared: --check sai 0 no repo; detecta falta/mudança/órfão; sync + --prune consertam', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nc-sync-shared-'));
  try {
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--src', src, '--dst', dst, ...args], { encoding: 'utf8' });
    // origem inexistente não quebra (lista vazia, nada escrito).
    assert.deepEqual(syncMirror({ srcDir: src, mirrorDir: dst }).written, []);
    // origem com 2 arquivos e espelho ainda inexistente → falta.
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, 'a.js'), 'export const A = 1;\n');
    writeFileSync(path.join(src, 'b.js'), 'export const B = 2;\n');
    assert.deepEqual(diffMirror({ srcDir: src, mirrorDir: dst }).missing, ['a.js', 'b.js']);
    assert.equal(run('--check').status, 1);

    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    assert.ok(existsSync(path.join(dst, 'a.js')));

    writeFileSync(path.join(src, 'a.js'), 'export const A = 42;\n');
    assert.deepEqual(diffMirror({ srcDir: src, mirrorDir: dst }).changed, ['a.js']);
    assert.equal(run('--check').status, 1);

    writeFileSync(path.join(dst, 'ghost.js'), 'export {};\n');
    run();
    const d = diffMirror({ srcDir: src, mirrorDir: dst });
    assert.deepEqual(d.changed, []);
    assert.deepEqual(d.orphans, ['ghost.js'], 'sem --prune o órfão fica (só aviso)');
    assert.equal(run('--check').status, 1);
    assert.equal(run('--prune').status, 0);
    assert.equal(run('--check').status, 0);
    assert.ok(!existsSync(path.join(dst, 'ghost.js')));

    assert.equal(run('--bogus').status, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
