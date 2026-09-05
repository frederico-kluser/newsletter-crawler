// `reextract` é destruição que não parece destruição: ele SOBRESCREVE o corpo já salvo. A única
// rejeição por tamanho era um piso ABSOLUTO (`< 50 chars`), que não olha o que já existe — um
// alvo que virou stub (paywall, SPA, redirect p/ a home, layout novo) devolve algumas centenas de
// caracteres de moldura, passa folgado nos 50 e substitui PERMANENTEMENTE um artigo inteiro.
// Aqui o guard é RELATIVO ao corpo atual: novo < 50% do atual => a ficha atual FICA.
// Sem rede (fetchSmartImpl injetado) e sem chave LLM: caminho 100% determinístico.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NC_HOME_TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-shrink-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
// NC_HOME/.env vazio vence o .env do repo real: HAS_LLM=false (sem clean/verify por IA).
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');

const {
  reextractTargets, isShrinkRejected, REEXTRACT_MIN_KEEP_RATIO, REEXTRACT_SHRINK_FLOOR,
} = await import('../src/reextract.js');
const { stmts, db } = await import('../src/db.js');
const { flushEvents } = await import('../src/events.js');

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

// Parágrafo de prosa real (o Readability exige >= 400 chars de texto p/ aceitar o artigo).
const P =
  'Este parágrafo existe para dar ao extrator prosa de verdade em quantidade suficiente, porque a ' +
  'extração só considera um documento como artigo quando o texto passa do mínimo exigido, e um ' +
  'corpo curto demais cairia noutro ramo do fluxo antes de chegar ao guard que este teste quer ' +
  'exercitar de fato, o que tornaria a prova inútil e silenciosamente vazia. ';

const page = (title, repeat) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>` +
  `${Array.from({ length: repeat }, (_, i) => `<p>${i}. ${P}</p>`).join('')}` +
  '</article></body></html>';

// Stub: prosa curta (passa o mínimo do Readability e o piso de 50 chars) — o caso perigoso.
const STUB = page('Produto', 2);
// Página cheia: bem maior que o corpo salvo — tem de ser aceita (guard sem falso positivo).
const CHEIA = page('Produto', 20);

const insert = (url, content) =>
  stmts.insertArticle.run({
    source_id: null, url, title: 'Artigo bom', content,
    content_hash: `hash-${url}`, published_at: '2026-08-13', run_id: null,
    kind: 'news', issue_url: null, section: null, blurb: 'blurb do agregador',
    content_source: 'target', cleaned: 0, needs_enrich: 0,
  });

test('isShrinkRejected: relativo ao corpo atual, e mudo para fichas pequenas', () => {
  assert.equal(REEXTRACT_MIN_KEEP_RATIO, 0.5);
  assert.equal(isShrinkRejected(40000, 300), true, 'stub de 300 contra artigo de 40k: rejeitado');
  assert.equal(isShrinkRejected(1000, 499), true, 'abaixo de 50% do atual: rejeitado');
  assert.equal(isShrinkRejected(1000, 500), false, 'exatamente 50%: passa (a regra é "menor que")');
  assert.equal(isShrinkRejected(1000, 4000), false, 'corpo maior sempre passa');
  assert.equal(
    isShrinkRejected(REEXTRACT_SHRINK_FLOOR - 1, 10),
    false,
    'ficha atual pequena não é "corpo bom": o guard não opina (senão nada mais melhoraria)',
  );
  assert.equal(isShrinkRejected(null, 10), false, 'sem corpo atual não há o que proteger');
});

test('reextract NÃO troca corpo bom por stub curto (guard de encolhimento) e registra o motivo', async () => {
  const url = 'https://shrink.test/artigo-bom';
  const bom = `CORPO BOM SALVO. ${P.repeat(12)}`; // ~4.6k chars
  insert(url, bom);
  const antes = stmts.getArticleFullByUrl.get(url);
  assert.ok(antes.content.length > 2000, 'a ficha atual é um corpo bom de verdade');

  const out = await reextractTargets({
    fetchSmartImpl: async (u) => ({ html: STUB, url: u }),
    urlFilter: 'shrink.test',
  });
  assert.equal(out.reextracted, 0, 'nada re-extraído');
  assert.equal(out.skipped, 1, 'contada como pulada');

  const depois = stmts.getArticleFullByUrl.get(url);
  assert.equal(depois.content, antes.content, 'CORPO BOM PRESERVADO');
  assert.equal(depois.content_hash, antes.content_hash, 'nem UPDATE houve');

  flushEvents(); // buffer de eventos é em lote
  const ev = stmts.listEventsForUrl.all(`%${url}%`, 10).find((e) => e.stage === 'reextract');
  assert.ok(ev, 'evento registrado');
  assert.match(ev.detail, /"reason":"shrink"/, 'o guard que pegou foi o de encolhimento');
  assert.match(ev.detail, /"was":\d+/, 'o evento registra o tamanho de antes');
  assert.match(ev.detail, /"now":\d+/, 'e o de depois');
});

test('o guard não é um freio geral: corpo MAIOR continua substituindo o salvo', async () => {
  const url = 'https://shrink.test/artigo-melhora';
  insert(url, `CORPO ANTIGO CURTO. ${P}`); // ~430 chars: acima do piso, mas pequeno
  const antes = stmts.getArticleFullByUrl.get(url);

  const out = await reextractTargets({
    fetchSmartImpl: async (u) => ({ html: CHEIA, url: u }),
    urlFilter: 'artigo-melhora',
  });
  assert.equal(out.reextracted, 1, 're-extração aceita');
  const depois = stmts.getArticleFullByUrl.get(url);
  assert.ok(depois.content.length > antes.content.length, 'corpo cresceu');
  assert.notEqual(depois.content_hash, antes.content_hash, 'gravado de verdade');
});
