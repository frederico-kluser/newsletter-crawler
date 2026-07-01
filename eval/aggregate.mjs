// Agrega eval/results/round-*.json -> média±desvio por (variante×modelo) e escreve eval/REPORT.md.
// Uso: node eval/aggregate.mjs [--dir eval/results]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const DIR = path.resolve(__dirname, '..', String(args.dir || 'eval/results'));

const files = fs.readdirSync(DIR).filter((f) => /^round-\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
if (!files.length) { console.error('sem round-*.json em', DIR); process.exit(1); }

const rounds = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// coleta séries por cell
const cells = new Map(); // key -> {variant, model, series:{metric:[...]}, fp:Map, fn:Map}
for (const r of rounds) {
  for (const [key, c] of Object.entries(r.cells)) {
    if (!cells.has(key)) cells.set(key, { variant: c.variant, model: c.model, s: {}, fp: new Map(), fn: new Map(), scn: {} });
    const cc = cells.get(key);
    for (const m of ['macroF1', 'macroPrecision', 'macroRecall', 'acc3way', 'kindAcc', 'meanMs', 'jsonFails']) {
      (cc.s[m] ||= []).push(c[m]);
    }
    for (const x of c.misses?.fp || []) cc.fp.set(x, (cc.fp.get(x) || 0) + 1);
    for (const x of c.misses?.fn || []) cc.fn.set(x, (cc.fn.get(x) || 0) + 1);
    for (const [sn, sv] of Object.entries(c.perScenario || {})) (cc.scn[sn] ||= []).push(sv.f1);
  }
}

const list = [...cells.values()].map((c) => ({
  variant: c.variant, model: c.model,
  f1: mean(c.s.macroF1), f1sd: std(c.s.macroF1),
  prec: mean(c.s.macroPrecision), rec: mean(c.s.macroRecall),
  acc3: mean(c.s.acc3way), kind: mean(c.s.kindAcc),
  ms: mean(c.s.meanMs), fails: mean(c.s.jsonFails),
  fp: [...c.fp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  fn: [...c.fn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  scn: c.scn,
})).sort((a, b) => b.f1 - a.f1);

const lines = [];
lines.push(`# Relatório do eval de prompt — relevância (DeepSeek V4 Flash vs Pro)`);
lines.push('');
lines.push(`Rodadas agregadas: **${rounds.length}** (${files[0]}..${files[files.length - 1]}) · pool=${rounds[0].poolSize} · cenários=${rounds[0].scenarios} · effort=${rounds[0].effort}`);
lines.push(`Métrica primária: **F1 macro** de relevância binária (relevant = direct∪similar), média sobre cenários e rodadas. Gabarito: Opus 4.8 (eval/golden.json).`);
lines.push('');
lines.push('| # | variante | modelo | F1 (μ±σ) | Precisão | Recall | acc 3-vias | kind acc | latência | JSON fails |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
list.forEach((c, i) => {
  lines.push(`| ${i + 1} | ${c.variant} | ${c.model} | **${f(c.f1)}** ±${f(c.f1sd, 2)} | ${f(c.prec)} | ${f(c.rec)} | ${f(c.acc3)} | ${f(c.kind)} | ${Math.round(c.ms)}ms | ${f(c.fails, 1)} |`);
});
lines.push('');
const best = list[0];
lines.push(`**Melhor:** \`${best.variant}\` / ${best.model} — F1 ${f(best.f1)}.`);
// melhor por modelo
for (const mk of ['flash', 'pro']) {
  const top = list.filter((c) => c.model === mk)[0];
  if (top) lines.push(`- Melhor **${mk}**: \`${top.variant}\` (F1 ${f(top.f1)}, acc3 ${f(top.acc3)}, ${Math.round(top.ms)}ms).`);
}
lines.push('');
lines.push('## Erros mais frequentes (cenário:id → nº rodadas)');
for (const c of list.slice(0, 6)) {
  lines.push(`- \`${c.variant}/${c.model}\` — FP: ${c.fp.map(([k, v]) => `${k}(${v})`).join(', ') || '—'} · FN: ${c.fn.map(([k, v]) => `${k}(${v})`).join(', ') || '—'}`);
}
lines.push('');
lines.push('## F1 por cenário (melhor variante de cada modelo)');
for (const mk of ['flash', 'pro']) {
  const top = list.filter((c) => c.model === mk)[0];
  if (!top) continue;
  const per = Object.entries(top.scn).map(([sn, xs]) => `${sn}=${f(mean(xs))}`).join(' · ');
  lines.push(`- **${mk}** \`${top.variant}\`: ${per}`);
}

const outMd = path.join(DIR, '..', 'REPORT.md');
fs.writeFileSync(outMd, lines.join('\n') + '\n');
fs.writeFileSync(path.join(DIR, 'summary.json'), JSON.stringify(list, null, 2));
console.log(lines.join('\n'));
console.log(`\n-> escrito ${outMd}`);
