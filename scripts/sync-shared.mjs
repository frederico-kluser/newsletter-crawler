#!/usr/bin/env node
// ESPELHO do código compartilhado: copia src/shared/*.js → webapp/src/shared/ BYTE A BYTE.
//
// Por que cópia e não import cruzado: o deploy da Vercel usa Root Directory `webapp/` (o build não
// enxerga ../src sem mexer em server.fs.allow e no pacote), e o CLI não deve importar de dentro do
// webapp. A cópia canônica é src/shared/ — o espelho nunca é editado à mão; a paridade é barrada
// por test/shared-mirror.parity.test.js e por `--check` (sai 1 na deriva).
//
//   node scripts/sync-shared.mjs            # copia o que falta/mudou; avisa órfãos
//   node scripts/sync-shared.mjs --check    # só confere: 0 = idêntico, 1 = deriva
//   node scripts/sync-shared.mjs --prune    # também apaga do espelho os .js sem original
//   (--src <dir> --dst <dir> trocam os diretórios — usado pelo teste com tmpdirs)
//
// Sem efeito colateral ao importar: o teste importa diffMirror/syncMirror; o main só roda como script.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorLog, log, warn } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = path.join(ROOT, 'src', 'shared');
export const MIRROR_DIR = path.join(ROOT, 'webapp', 'src', 'shared');

/** Os .js de um diretório (ordenados); diretório ausente = lista vazia. */
export function listShared(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => d.name)
    .sort();
}

/**
 * Compara original × espelho. Devolve {files, missing, changed, same, orphans, ok}: missing = sem
 * cópia no espelho; changed = bytes diferentes; orphans = .js no espelho sem original (código
 * compartilhado apagado/renomeado no src que ficou vivo no site).
 */
export function diffMirror({ srcDir = SRC_DIR, mirrorDir = MIRROR_DIR } = {}) {
  const files = listShared(srcDir);
  const mirrored = new Set(listShared(mirrorDir));
  const missing = [];
  const changed = [];
  const same = [];
  for (const f of files) {
    if (!mirrored.has(f)) {
      missing.push(f);
      continue;
    }
    const a = readFileSync(path.join(srcDir, f));
    const b = readFileSync(path.join(mirrorDir, f));
    (a.equals(b) ? same : changed).push(f);
  }
  const orphans = [...mirrored].filter((f) => !files.includes(f));
  return { files, missing, changed, same, orphans, ok: !missing.length && !changed.length && !orphans.length };
}

/** Copia o que falta/mudou (e, com prune, apaga os órfãos). Devolve o diff + {written, pruned}. */
export function syncMirror({ srcDir = SRC_DIR, mirrorDir = MIRROR_DIR, prune = false } = {}) {
  const d = diffMirror({ srcDir, mirrorDir });
  const written = [...d.missing, ...d.changed];
  if (written.length) mkdirSync(mirrorDir, { recursive: true });
  for (const f of written) writeFileSync(path.join(mirrorDir, f), readFileSync(path.join(srcDir, f)));
  const pruned = [];
  if (prune) {
    for (const f of d.orphans) {
      unlinkSync(path.join(mirrorDir, f));
      pruned.push(f);
    }
  }
  return { ...d, written, pruned };
}

function parseArgs(argv) {
  const o = { check: false, prune: false, srcDir: SRC_DIR, mirrorDir: MIRROR_DIR, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--prune') o.prune = true;
    else if (a === '--src' && argv[i + 1]) o.srcDir = path.resolve(argv[++i]);
    else if (a === '--dst' && argv[i + 1]) o.mirrorDir = path.resolve(argv[++i]);
    else o.bad = a;
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.bad) {
    errorLog(`sync-shared: argumento desconhecido "${o.bad}" (use --check, --prune, --src <dir>, --dst <dir>)`);
    return 2;
  }
  if (o.check) {
    const d = diffMirror(o);
    if (d.ok) {
      log(`sync-shared: espelho idêntico (${d.files.length} arquivo(s))`);
      return 0;
    }
    if (d.missing.length) errorLog(`sync-shared: sem cópia no espelho: ${d.missing.join(', ')}`);
    if (d.changed.length) errorLog(`sync-shared: espelho difere do original: ${d.changed.join(', ')}`);
    if (d.orphans.length) errorLog(`sync-shared: órfãos no espelho (sem original em src/shared): ${d.orphans.join(', ')}`);
    errorLog('sync-shared: rode `node scripts/sync-shared.mjs` (edite só src/shared/)');
    return 1;
  }
  const r = syncMirror(o);
  if (r.written.length) log(`sync-shared: copiado(s) → ${path.relative(ROOT, o.mirrorDir) || o.mirrorDir}: ${r.written.join(', ')}`);
  else log(`sync-shared: nada a copiar (${r.files.length} arquivo(s) já idênticos)`);
  if (r.pruned.length) log(`sync-shared: órfãos removidos: ${r.pruned.join(', ')}`);
  else if (r.orphans.length) warn(`sync-shared: órfãos no espelho (use --prune p/ remover): ${r.orphans.join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
