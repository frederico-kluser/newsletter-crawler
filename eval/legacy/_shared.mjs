// Base comum dos prompts CONGELADOS (eval/legacy/*.mjs) da era DeepSeek.
//
// Por que congelar: a migração Jev APAGA de src/llm.js as funções que montam estes prompts
// (cleanArticleContent, verifyRecordLLM, curateRoundupItems, extractLinksItemByItem,
// compileQuerySpec…). Sem uma cópia fiel, nenhum baseline pago consegue mais rodar o prompt
// ANTIGO depois da onda que o remove — e é esse baseline que diz se o Jev empatou em qualidade.
// Estes módulos copiam o TEXTO (system/user), o json_schema e o parse (sem zod) VERBATIM e não
// importam nada de src/ — continuam funcionando depois que os originais sumirem.
//
// Uso num baseline pago (sempre via `scripts/dev-spend.mjs run`):
//   const req = buildCurateRoundupRequest({ markdown, baseUrl });
//   const raw = await callJSON(toCallJSONArgs(req));   // slug OpenRouter congelado em req.model
//   const out = req.parse(raw);                         // null = fora do schema (fail-open)

// Commit em que o texto foi copiado. O conteúdo de src/llm.js neste ponto é o do 8e07931.
export const FROZEN_FROM = Object.freeze({
  commit: '421b42c',
  date: '2026-09-26',
  files: ['src/llm.js', 'src/taxonomy.js', 'src/detect-type.js', 'config/models.json'],
});

// Defaults de config.js no momento do congelamento (MAX_HTML_FOR_LLM, SEARCH_MAX_CHARS,
// CLASSIFY_MAX_CHARS). NÃO leem o env de propósito: o baseline precisa ser reproduzível e um
// override no NC_HOME/.env (que o eval não lê) mudaria o recorte em silêncio. Quem quiser outro
// recorte passa `maxChars` explícito no builder.
export const LEGACY_MAX_HTML_FOR_LLM = 120000;
export const LEGACY_SEARCH_MAX_CHARS = 8000;
export const LEGACY_CLASSIFY_MAX_CHARS = 2000;

// config/models.json congelado (as etapas que têm prompt aqui), no valor EFETIVO que o stageModel
// resolvia. O slug é OpenRouter: a remoção do provedor DeepSeek DIRETO não bloqueia
// `deepseek/deepseek-v4-flash-0731` via OpenRouter.
export const LEGACY_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const LEGACY_STAGE_MODELS = Object.freeze({
  linkExtract: { model: LEGACY_DEFAULT_MODEL, effort: 'xhigh' },
  roundupExtract: { model: LEGACY_DEFAULT_MODEL, effort: 'xhigh' },
  articleExtract: { model: LEGACY_DEFAULT_MODEL, effort: 'xhigh' },
  classify: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
  'classify:difficulty': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  'classify:content-type': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  'classify:trending-emerging': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  'classify:ecosystem-language': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  'classify:company-vendor-model': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  'classify:framework-library-tool': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  'classify:concept-theme': { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  searchRelevance: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
  searchBatch: { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  searchTags: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
  searchSpec: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
  curate: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
  articleClean: { model: LEGACY_DEFAULT_MODEL, effort: 'medium' },
  // O models.json dizia 'high', mas articleReclean NÃO estava em STAGE_KEYS: o stageModel caía no
  // default e a produção mandava 'xhigh'. Congela o que era ENVIADO de fato (a W1 corrige a lista).
  articleReclean: { model: LEGACY_DEFAULT_MODEL, effort: 'xhigh' },
  verifyRecord: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
  detectType: { model: LEGACY_DEFAULT_MODEL, effort: 'high' },
});

/** Modelo+effort congelados da etapa (chave `classify:<faceta>` cai na base `classify`). */
export function legacyStageModel(key) {
  const hit = LEGACY_STAGE_MODELS[key] || LEGACY_STAGE_MODELS[String(key).split(':')[0]];
  return hit ? { ...hit } : { model: LEGACY_DEFAULT_MODEL, effort: 'xhigh' };
}

/** Mesmo recorte do `clamp` de src/llm.js (slice no teto de caracteres). */
export const clampText = (s, max = LEGACY_MAX_HTML_FOR_LLM) => (s || '').slice(0, max);

/**
 * Monta o pedido congelado. `modelKey` escolhe o par model/effort (default = stage); `opts`
 * permite trocar model/effort num experimento sem mexer no texto.
 */
export function legacyRequest({ stage, modelKey = stage, schemaName, schema, system, user, parse }, opts = {}) {
  const frozen = legacyStageModel(modelKey);
  return {
    stage,
    schemaName,
    schema,
    system,
    user,
    model: opts.model || frozen.model,
    effort: opts.effort || frozen.effort,
    parse,
    legacy: true,
    frozenFrom: FROZEN_FROM.commit,
  };
}

/**
 * Argumentos p/ o callJSON de src/llm.js. `fallbackModel: null` isola o modelo (o baseline mede
 * o slug congelado, sem escalada) e SEM `zod` (o parse congelado roda depois, via req.parse).
 */
export function toCallJSONArgs(req, overrides = {}) {
  return {
    model: req.model,
    reasoning: { effort: req.effort },
    stage: req.stage,
    schemaName: req.schemaName,
    schema: req.schema,
    system: req.system,
    user: req.user,
    fallbackModel: null,
    ...overrides,
  };
}

// ---- espelho mínimo do zod (sem a dependência) ----
// Cada tipo é (valor) => { ok, value }. Reproduz SÓ o que os schemas antigos usavam: string,
// number, coerce.number(.int), nullish/nullable, default, transform, array e object (que
// descarta chaves desconhecidas, como o z.object). `present:false` = chave ausente (undefined).
const OK = (value) => ({ ok: true, value });
const BAD = { ok: false };

export const t = {
  string: () => (v) => (typeof v === 'string' ? OK(v) : BAD),
  number: () => (v) => (typeof v === 'number' && Number.isFinite(v) ? OK(v) : BAD),
  // z.coerce.number(): Number(v) e rejeita NaN (Number(null) = 0, como no zod).
  coerceNumber: ({ int = false } = {}) => (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return BAD;
    if (int && !Number.isInteger(n)) return BAD;
    return OK(n);
  },
  nullish: (inner) => (v) => (v === undefined || v === null ? OK(v) : inner(v)),
  nullable: (inner) => (v) => (v === null ? OK(null) : inner(v)),
  // .default(d): só vale p/ undefined (null continua inválido, igual ao zod). Guarda o `inner`
  // p/ o modo estrito desembrulhar, como o strictZodShape do callJSON.
  withDefault: (inner, d) => {
    const type = (v) => (v === undefined ? OK(typeof d === 'function' ? d() : d) : inner(v));
    type.inner = inner;
    return type;
  },
  map: (inner, fn) => (v) => {
    const r = inner(v);
    return r.ok ? OK(fn(r.value)) : BAD;
  },
  array: (inner) => (v) => {
    if (!Array.isArray(v)) return BAD;
    const out = [];
    for (const item of v) {
      const r = inner(item);
      if (!r.ok) return BAD;
      out.push(r.value);
    }
    return OK(out);
  },
  object: (shape) => (v) => {
    const r = checkObject(shape, v);
    return r.failed.length ? BAD : OK(r.value);
  },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkObject(shape, v) {
  if (!isPlainObject(v)) return { value: null, failed: ['(root)'] };
  const value = {};
  const failed = [];
  for (const [key, type] of Object.entries(shape)) {
    const r = type(v[key]);
    if (!r.ok) failed.push(key);
    else if (r.value !== undefined) value[key] = r.value;
  }
  return { value, failed };
}

/**
 * Parse fail-open de uma resposta crua contra um shape congelado. Espelha o fim do callJSON com
 * `zod:` — shape ESTRITO primeiro; falhou, zera as chaves de TOPO inválidas e re-valida (os
 * defaults tolerantes preenchem, como o tolerantParse). Devolve null quando nem assim valida
 * (o chamador decide; o original lançava). `tolerant:false` só aceita o shape estrito — útil p/
 * o baseline re-amostrar como o retry de shape do callJSON fazia.
 */
export function parseWith(shape, raw, { tolerant = true } = {}) {
  if (!tolerant) {
    // Estrito = chave com default AUSENTE conta como inválida (re-amostraria no callJSON).
    const unwrapped = {};
    for (const [k, type] of Object.entries(shape)) unwrapped[k] = type.inner || type;
    const r = checkObject(unwrapped, raw);
    return r.failed.length ? null : checkObject(shape, raw).value;
  }
  const strict = checkObject(shape, raw);
  if (!strict.failed.length) return strict.value;
  // Raiz que não é objeto (array/string/null): o tolerantParse original ESPALHAVA o valor
  // ({...raw}) e re-validava — só os defaults sobrevivem (ex.: curate vira {items:[]}).
  const retry = { ...raw };
  if (!strict.failed.includes('(root)')) for (const k of strict.failed) delete retry[k];
  const second = checkObject(shape, retry);
  return second.failed.length ? null : second.value;
}
