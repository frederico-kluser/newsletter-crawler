// Guard anti-encolhimento do snapshot publicado: a DECISÃO PURA de "pode publicar este snapshot
// por cima do que já está no ar?". Sem git, sem rede, sem fs — quem lê arquivo/HEAD/site é o
// chamador (src/deploy.js e o .githooks/pre-push, via um `node -e` curto que importa daqui).
//
// POR QUE EXISTE (incidente 2026-08-24, commit 7c24491): o `ncrawl deploy` publicou um snapshot de
// 0 artigos por cima de 2866 e apagou 261.088 linhas dos JSONs commitados. O log mostra que o
// deploy TINHA os dois números na mão ("export web: 0 artigos" / "site no ar: 2866 artigos") — eles
// só nunca chegaram à decisão, viraram texto de log. O único guard existente morava no hook
// `.githooks/pre-push`, e o deploy commita/pusha com `--no-verify`, o que PULA o hook.
//
// Regra de fundo, decidida pelo usuário: o histórico do git é a BASE DE REGISTRO do acervo. Limpar
// a base LOCAL não pode, em hipótese nenhuma, propagar para o git. Perder dado publicado só por ato
// explícito e deliberado.
//
// Por isso a política aqui é FAIL-SAFE, ao contrário do resto do projeto (que é fail-open de
// propósito: uma página ruim não pode derrubar um crawl). Aqui o custo é invertido — o dado
// publicado é único, então quando NÃO DÁ PARA PROVAR que o acervo não encolheu, o veredito é
// BLOQUEIA. A única concessão fail-open é não existir base alguma para comparar (1º snapshot).
//
// Nota sobre o hook atual: `.githooks/pre-push:52` só aplica o guard quando consegue ler OS DOIS
// totais (`-n` em ambos) — leitura falhou, guard desligado. Um guard que se desliga sozinho quando
// a leitura falha é exatamente como se perde dado; aqui um total desconhecido BLOQUEIA.

// Opt-ins explícitos. Ficam em constante p/ o deploy e o hook citarem o MESMO nome nas mensagens.
// ATENÇÃO: estas strings são COPIADAS pelo usuário direto da mensagem de bloqueio p/ a linha de
// comando, então TÊM de ser aceitas pelo parseFlags de src/index.js — que NÃO quebra em `=`
// (`--allow-shrink=wipe` viraria a flag literal "allow-shrink=wipe" e o opt-in nunca chegaria
// aqui: o usuário bloqueado seguiria o hint e levaria o MESMO bloqueio). A forma com ESPAÇO
// (`--allow-shrink wipe`) é a que o parser entende: vira flags['allow-shrink'] === 'wipe'.
// test/snapshot-guard.test.js prova isso rodando o parseFlags REAL, extraído de src/index.js.
export const SHRINK_OPT_IN = '--allow-shrink';
export const WIPE_OPT_IN = '--allow-shrink wipe';

// Fração do acervo publicado que precisa SOBRAR para o encolhimento ainda contar como "normal".
// Abaixo disso a perda é CATASTRÓFICA e exige o opt-in FORTE (ver a decisão, passo 3).
const CATASTROPHIC_KEEP_RATIO = 10; // sobrar menos de 1/10 do publicado = wipe na prática

// ---- normalização de entradas ----

/**
 * Total de artigos vindo de fora → inteiro >= 0, ou null = DESCONHECIDO.
 * Aceita string numérica porque o hook é bash e passa tudo como texto. `''` NÃO vira 0 (Number('')
 * é 0, e "vazio" ali significa "não deu para ler" — o oposto de "zero artigos"). Número quebrado
 * (1.5) não é uma contagem de artigos: é entrada corrompida → DESCONHECIDO (fail-safe), nunca um
 * total que a comparação aceitaria como válido.
 */
export function toCount(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  }
  return null;
}

/**
 * Total de artigos de um meta.json JÁ PARSEADO (aceita também a string crua, p/ o hook despejar o
 * `git show` direto aqui). Fail-safe: formato ausente/inválido → null = DESCONHECIDO, que o
 * evaluateSnapshotChange trata como "não dá para provar que não encolheu" — e não como zero.
 */
export function articlesFromMeta(meta) {
  try {
    const m = typeof meta === 'string' ? JSON.parse(meta) : meta;
    if (!m || typeof m !== 'object') return null;
    return toCount(m?.totals?.articles);
  } catch {
    return null;
  }
}

// Opt-in → 'no' | 'shrink' | 'wipe'. Tolerante ao estilo de flag do repo (`x === true || 'true'`):
// `--allow-shrink` sozinho chega como true, `--allow-shrink wipe` chega como a string 'wipe'.
function normalizeOptIn(allowShrink) {
  if (allowShrink === true) return 'shrink';
  if (typeof allowShrink !== 'string') return 'no';
  const s = allowShrink.trim().toLowerCase();
  if (s === 'wipe') return 'wipe';
  if (s === 'true' || s === '1' || s === 'yes' || s === 'shrink') return 'shrink';
  return 'no';
}

const fmt = (n) => (n == null ? '?' : String(n));

// ---- decisão ----

/**
 * Decide se um snapshot novo pode ser publicado por cima do acervo já publicado.
 *
 * @param {object}  o
 * @param {number|string|null} o.novo   total de artigos do snapshot recém-exportado
 * @param {number|string|null} o.head   total commitado no HEAD (null = desconhecido/inexistente)
 * @param {number|string|null} o.live   total servido pelo site no ar (null = desconhecido/offline)
 * @param {boolean|string}     o.allowShrink  opt-in explícito: true/'true' libera ENCOLHER;
 *                                            'wipe' libera a perda CATASTRÓFICA (true não libera)
 * @returns {{
 *   action: 'allow'|'block', ok: boolean,
 *   reason: 'grow'|'same'|'no-baseline'|'shrink'|'wipe'|'unknown-new'
 *          |'override-shrink'|'override-wipe'|'override-unknown',
 *   risk: null|'shrink'|'wipe'|'unknown',
 *   override: boolean,
 *   counts: { novo: number|null, head: number|null, live: number|null, baseline: number|null },
 *   message: string, hint: string|null,
 * }}
 *
 * `risk` diz o que foi DETECTADO (independe da decisão), `action` diz o que fazer e `override` diz
 * se só passou por causa do opt-in — é isso que o chamador loga alto. `message`/`hint` já vêm
 * prontos p/ o usuário (o deploy joga direto num `new DeployError(message, hint)`).
 *
 * A base de comparação é o MAIOR total conhecido entre head e live: encolher em relação a QUALQUER
 * um dos dois é encolher. Ler os dois também pega o caso "site no ar à frente do HEAD local".
 */
export function evaluateSnapshotChange({ novo, head, live, allowShrink } = {}) {
  const n = toCount(novo);
  const h = toCount(head);
  const l = toCount(live);
  const optIn = normalizeOptIn(allowShrink);

  const conhecidos = [h, l].filter((x) => x != null);
  const baseline = conhecidos.length ? Math.max(...conhecidos) : null;
  const counts = { novo: n, head: h, live: l, baseline };
  const ctx = `HEAD: ${fmt(h)}, no ar: ${fmt(l)}`;
  const verdict = (action, reason, risk, override, message, hint) => ({
    action, ok: action === 'allow', reason, risk, override, counts, message, hint: hint || null,
  });

  // 1. Sem o total novo não dá para provar NADA. Fail-safe: bloqueia (o hook, hoje, seguiria).
  if (n == null) {
    if (optIn !== 'no') {
      return verdict('allow', 'override-unknown', 'unknown', true,
        `OPT-IN ${SHRINK_OPT_IN}: o total do snapshot novo é desconhecido — publicando SEM a ` +
        `verificação anti-encolhimento (${ctx}).`);
    }
    return verdict('block', 'unknown-new', 'unknown', false,
      `não deu para ler o total de artigos do snapshot novo — sem esse número o guard NÃO consegue ` +
      `provar que o acervo não encolheu (${ctx}).`,
      `re-exporte (ncrawl export --format web) e confira o campo totals.articles em ` +
      `webapp/public/data/meta.json. ${SHRINK_OPT_IN} publica assim mesmo, por sua conta e risco.`);
  }

  // 2. Nada publicado com que comparar: nada a perder. Única concessão fail-open do módulo.
  if (baseline == null) {
    return verdict('allow', 'no-baseline', null, false,
      `primeiro snapshot: não há acervo publicado para comparar (${ctx}) — publicando ${n} artigo(s).`);
  }

  // 3. Perda CATASTRÓFICA = o caso 7c24491, e ele NÃO é só o zero exato. Sobrar menos de 1/10 do
  //    acervo publicado (2866 → 1 perde 99,97%) destrói o dado publicado exatamente como zerar,
  //    e nenhuma redução intencional (purge de uma fonte, re-crawl parcial) guarda menos de 10%.
  //    A fronteira usa aritmética INTEIRA (n * 10 < baseline) p/ não depender de arredondamento
  //    de float. `--allow-shrink` sozinho NÃO libera: destruir o acervo tem que ser dito com
  //    todas as letras, com o opt-in FORTE.
  if (baseline > 0 && (n === 0 || n * CATASTROPHIC_KEEP_RATIO < baseline)) {
    const sobra = n === 0 ? 'o snapshot novo tem 0 artigos' : `sobrariam só ${n} artigo(s)`;
    if (optIn === 'wipe') {
      return verdict('allow', 'override-wipe', 'wipe', true,
        `OPT-IN ${WIPE_OPT_IN}: publicando ${n === 0 ? 'um snapshot VAZIO' : `só ${n} artigo(s)`} ` +
        `por cima de ${baseline} artigo(s) (${ctx}). O acervo do site vai ser APAGADO.`);
    }
    return verdict('block', 'wipe', 'wipe', false,
      `publicar este snapshot APAGARIA o acervo do site: ${sobra} e o publicado tem ${baseline} ` +
      `(${ctx}).`,
      `a base local está vazia/quase vazia (banco em outra máquina, NC_HOME apontando p/ outro ` +
      `lugar, reset/purge recente) — RESTAURE o banco e re-exporte (ncrawl export --format web). ` +
      `Se destruir o acervo do site é MESMO o que você quer, repita com "${WIPE_OPT_IN}" ` +
      `(${SHRINK_OPT_IN} sozinho não libera zerar).`);
  }

  // 4. Encolhimento parcial: bloqueia, a menos que o opt-in esteja lá. REGRA CENTRAL.
  if (n < baseline) {
    const perda = baseline - n;
    if (optIn !== 'no') {
      return verdict('allow', 'override-shrink', 'shrink', true,
        `OPT-IN ${SHRINK_OPT_IN}: publicando um snapshot MENOR — ${n} < ${baseline} (${ctx}). ` +
        `O acervo do site vai ENCOLHER em ${perda} artigo(s).`);
    }
    // Site no ar à frente do HEAD local: pode ser repo atrasado OU um build antigo ainda servido.
    const atrasado = h != null && l != null && l > h
      ? ` O site no ar (${l}) reporta MAIS artigos que o HEAD local (${h}): ou seu repositório ` +
        `está atrasado (nesse caso, "git pull --rebase" antes), ou a borda ainda serve um build ` +
        `anterior — confira qual dos dois antes de liberar.`
      : '';
    return verdict('block', 'shrink', 'shrink', false,
      `o snapshot novo tem MENOS artigos que o já publicado: ${n} < ${baseline} (${ctx}) — este ` +
      `deploy encolheria a base do site em ${perda} artigo(s).`,
      `a base local pode estar incompleta ou vazia (banco em outra máquina, NC_HOME diferente, ` +
      `crawl/purge parcial) — confira e re-exporte (ncrawl export --format web).${atrasado} Se a ` +
      `redução é INTENCIONAL, repita com ${SHRINK_OPT_IN}.`);
  }

  // 5. Cresceu ou empatou: caminho normal.
  if (n === baseline) {
    return verdict('allow', 'same', null, false,
      `snapshot com o mesmo total do publicado: ${n} artigo(s) (${ctx}).`);
  }
  return verdict('allow', 'grow', null, false,
    `snapshot cresceu: ${baseline} → ${n} artigo(s) (${ctx}).`);
}
