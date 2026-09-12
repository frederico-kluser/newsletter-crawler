// Piso de data POR FONTE ("cursor"): cada fonte guarda a data do item mais novo já capturado e a
// próxima coleta repete esse piso em vez de varrer o arquivo de novo — confiando nas capturas
// passadas, POR FONTE (não um --since comum a todas). Este módulo é PURO (sem db/rede) para a
// decisão ser testável isolada; quem lê/grava o cursor é o db.js (`sources.cursor_date`) e quem
// resolve por job é o crawl (commands.js). Ver docs/reprocesso-IA-audit-2026-09-11.md.
import { parseDate } from './util.js';

/**
 * `--since-source "Nome=AAAA-MM-DD,Outro=2026-01-02"` -> Map(nomeLower -> Date).
 * Item sem '=' ou com data inválida é IGNORADO (fail-open: quem chama avisa o que não casou).
 */
export function parseSinceSourceFlag(raw) {
  const map = new Map();
  if (typeof raw !== 'string' || !raw.trim()) return map;
  for (const part of raw.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const d = parseDate(part.slice(i + 1).trim());
    if (name && d) map.set(name, d);
  }
  return map;
}

/**
 * Piso efetivo de UMA fonte. Precedência (mais específico primeiro): override por fonte
 * (`--since-source`) > `--since` global > cursor da fonte > derivado (MAX(published_at) do que já
 * temos dela) > piso mínimo. O piso é INCLUSIVO: um item datado exatamente no cursor é re-checado
 * (e é grátis — a dedup por URL responde antes de qualquer LLM).
 * Datas aceitas como Date ou string ISO; ausência = null. Resultado sempre clampado no piso mínimo
 * (data mais antiga permitida) — candidato abaixo dele devolve o mínimo com origem 'piso-minimo'.
 * `maxDate` (ex.: hoje) protege contra DATA FUTURA de valor AUTOMÁTICO (cursor/derivado): um scrape
 * errado pularia todo o intervalo até essa data, então o candidato é DESCARTADO e a resolução cai
 * para o próximo. Flag explícita (`--since`/`--since-source`) NÃO é descartada — é escolha do
 * usuário (e uma data "de hoje" num fuso à frente do UTC não pode virar no-op silencioso).
 * Retorna { date: Date|null, origem: 'flag-fonte'|'flag'|'cursor'|'derivado'|'piso-minimo' }.
 */
export function resolveSourceFloor({
  explicitSince = null,
  override = null,
  cursor = null,
  derived = null,
  minDate = null,
  maxDate = null,
} = {}) {
  const min = minDate instanceof Date ? minDate : parseDate(minDate);
  const max = maxDate instanceof Date ? maxDate : parseDate(maxDate);
  for (const [origem, raw] of [
    ['flag-fonte', override],
    ['flag', explicitSince],
    ['cursor', cursor],
    ['derivado', derived],
  ]) {
    const d = raw instanceof Date ? raw : parseDate(raw);
    if (!d) continue;
    // Data futura só invalida valor automático (ver o doc acima); flag explícita passa.
    if (max && d > max && (origem === 'cursor' || origem === 'derivado')) continue;
    if (min && d < min) return { date: min, origem: 'piso-minimo' };
    return { date: d, origem };
  }
  return { date: min, origem: 'piso-minimo' };
}

/**
 * TETO de trabalho inacabado sobre o piso resolvido. O piso por fonte (cursor/derivado) assume
 * "maior data capturada ⇒ tudo abaixo está capturado" — falso quando a captura anterior foi
 * PARCIAL (`--max-articles`, budget, Ctrl+C, deadline): os roundups que ficaram `pending` têm data
 * abaixo do piso, seriam pulados por `below-since` e o job marcado `done` — e o `enqueue`
 * (INSERT OR IGNORE) + `isUrlKnown` nunca os trariam de volta (perda permanente). Regras:
 *  - pendência SEM data não prova cobertura → cai no piso mínimo (varre mais, nunca perde);
 *  - pendência datada mais antiga que o piso → o piso REBAIXA até ela (o backlog é drenado);
 *  - vale também para flag explícita: rebaixar o piso só faz varrer mais, e o alternativo seria
 *    perder o backlog em silêncio (o log mostra `· limitado por pendências`).
 * Puro/testável. Retorna { date, origem, limitadoPor: 'backlog'|null }.
 */
export function applyPendingCeiling(
  { date = null, origem = 'piso-minimo' } = {},
  { oldest = null, undated = 0 } = {},
  { minDate = null } = {},
) {
  if ((undated ?? 0) > 0) {
    const min = minDate instanceof Date ? minDate : parseDate(minDate);
    return { date: min, origem: 'piso-minimo', limitadoPor: 'backlog' };
  }
  // Normaliza os DOIS lados (aceita Date ou ISO): comparar Date com string devolveria sempre
  // "sem teto" e o backlog ficaria abaixo do piso de novo.
  const floor = date instanceof Date ? date : parseDate(date);
  const cap = oldest instanceof Date ? oldest : parseDate(oldest);
  if (cap && floor && cap < floor) return { date: cap, origem, limitadoPor: 'backlog' };
  return { date: floor, origem, limitadoPor: null };
}
