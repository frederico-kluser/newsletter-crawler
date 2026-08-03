// Reprodução client-side do WEB_WHERE (src/db.js:213-238 do CLI) sobre o snapshot: fonte,
// período (date_iso já vem resolvido do export — published_at normalizado com fallback em
// extracted_at, então NUNCA é null), kind de 3 vias (release = coluna exata; news/tool =
// coluna vence, fallback por tags) e verify. Módulo PURO (testável com node --test, sem React/DOM).
//
// DIVERGÊNCIA DELIBERADA do WEB_WHERE (só no webapp): as facetas fazem INTERSEÇÃO (AND) puro —
// AND dentro da faceta E entre facetas — em vez do "AND-de-OR" do SQL. Escolha de produto do
// site público: selecionar duas tags = itens que têm AS DUAS. NÃO "ressincronize" para OR sem
// checar o pedido (o web-ui SQL local segue OR; são superfícies distintas). Ver computeFacetCounts.
//
// 2ª DIVERGÊNCIA (só no webapp): FONTE é MULTI-SELEÇÃO em UNIÃO (OR) — `sourceIds: []`, vazio =
// todas — enquanto o WEB_WHERE do SQL só tem `@sourceId` de uma fonte por vez. Fonte é atributo
// único do artigo, então AND entre fontes devolveria sempre vazio: aqui OR é a única semântica útil.
import { articleIsTool } from './taxonomy.js';

export const EMPTY_FILTERS = Object.freeze({
  sourceIds: [],
  // piso de data padrão (CRAWLER_SINCE): o campo "from" vem pré-preenchido com 2026-01-01 em vez
  // de vazio (= "sem piso"); o usuário pode limpar para ver o acervo inteiro (2015+).
  from: '2026-01-01',
  to: '',
  facets: {},
  kind: 'all',
  verify: '',
});

/**
 * Escopo de uma busca IA ({sourceIds, from, to}) num shape único e retrocompatível: as buscas
 * gravadas ANTES da multi-seleção (histórico/checkpoint no localStorage) trazem `sourceId` de uma
 * fonte só — aqui vira lista de um item, e o resto do app só conhece `sourceIds`.
 */
export function normalizeScope(scope = {}) {
  const ids = Array.isArray(scope.sourceIds)
    ? scope.sourceIds
    : scope.sourceId != null
      ? [scope.sourceId]
      : [];
  return { sourceIds: ids, from: scope.from || '', to: scope.to || '' };
}

/** Filtros ativos (para o badge "Filtros (n)" e as pills). Kind fica fora — mora no Segmented. */
export function countActiveFilters(f) {
  let n = 0;
  n += f.sourceIds?.length || 0;
  if (f.from || f.to) n++;
  if (f.verify) n++;
  for (const tags of Object.values(f.facets || {})) n += tags.length;
  return n;
}

/** Aplica os filtros de browse. `toolTypes` vem de meta.toolContentTypes. */
export function applyFilters(articles, f, toolTypes) {
  const facetEntries = Object.entries(f.facets || {}).filter(([, tags]) => tags && tags.length);
  const sourceIds = f.sourceIds?.length ? new Set(f.sourceIds) : null; // vazio = todas as fontes
  return articles.filter((a) => {
    if (sourceIds && !sourceIds.has(a.source_id)) return false;
    if (f.from && a.date_iso < f.from) return false;
    if (f.to && a.date_iso > f.to) return false;
    // INTERSEÇÃO (AND) total: o artigo tem de conter TODA tag selecionada (dentro da faceta e
    // entre facetas). Duas tags marcadas = só quem tem as duas. (Diverge do OR-dentro-da-faceta
    // do WEB_WHERE — ver cabeçalho.)
    for (const [facet, tags] of facetEntries) {
      const have = a.tags?.[facet];
      if (!have || !tags.every((t) => have.includes(t))) return false;
    }
    if (f.kind && f.kind !== 'all') {
      if (f.kind === 'release') {
        if (a.kind !== 'release') return false;
      } else if ((f.kind === 'tool') !== articleIsTool(a, toolTypes)) {
        return false;
      }
    }
    if (f.verify && a.verify_status !== f.verify) return false;
    return true;
  });
}

/**
 * Contagem de co-ocorrência por faceta/tag sobre um conjunto JÁ FILTRADO `R` (o resultado do
 * browse atual). Para cada tag T devolve quantos itens de `R` também têm T.
 *
 * Como `R` já exige TODA tag selecionada (applyFilters faz interseção), o tally responde de graça
 * às três perguntas da UI: tag SELECIONADA → |R| (todos de R a têm → sobe ao topo); tag da mesma
 * faceta/outra faceta que CO-OCORRE → a interseção com a seleção; tag que não aparece em nenhum
 * item de R → ausente (0) → a UI a desabilita. Passe SEMPRE o conjunto já filtrado, não o acervo.
 *
 * Retorna `{ [faceta]: { [tag]: n } }`. O(|R| × tags/artigo) — barato p/ o snapshot inteiro.
 */
export function computeFacetCounts(articles) {
  const counts = {};
  for (const a of articles) {
    const tags = a.tags;
    if (!tags) continue;
    for (const facet in tags) {
      const list = tags[facet];
      if (!list) continue;
      const bucket = counts[facet] || (counts[facet] = {});
      for (const tag of list) bucket[tag] = (bucket[tag] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Ordenação de exibição: SEMPRE data DESC (mais nova primeiro). O que muda é o desempate DENTRO
 * de uma mesma data — e é aí que morava o problema: o snapshot é gravado na ordem de COLETA, que é
 * fonte por fonte, então desempatar por id fazia um dia inteiro sair em blocos (84 itens de uma
 * newsletter, depois 67 de outra).
 *
 * `mix` (default) = RODÍZIO entre as fontes: 1º item da fonte A, 1º da B, 1º da C, 2º da A… e quando
 * uma fonte esgota as demais seguem sozinhas até o fim. A volta do rodízio é ALFABÉTICA pelo nome da
 * fonte (`sourceName`) — ordem estável entre visitas, independente do filtro. Dentro de cada fonte a
 * fila é `id` ASC = a ordem editorial da issue (manchete primeiro), então o rodízio mostra a matéria
 * principal de cada fonte antes das secundárias.
 *
 * `mix: false` = agrupado por fonte dentro da data (fonte alfabética, `id` ASC) — o modo do toggle
 * "misturar fontes" desligado.
 *
 * Puro: não muta a entrada. `sourceName` é opcional (sem ele o rodízio cai no `source_id`).
 */
export function sortForDisplay(articles, { mix = true, sourceName } = {}) {
  const nameOf = (a) => (sourceName ? sourceName(a.source_id) : '') || String(a.source_id ?? '');
  const byDate = new Map(); // date_iso -> Map(nome da fonte -> fila de artigos)
  for (const a of articles) {
    const date = a.date_iso || '';
    let queues = byDate.get(date);
    if (!queues) byDate.set(date, (queues = new Map()));
    const name = nameOf(a);
    const queue = queues.get(name);
    if (queue) queue.push(a);
    else queues.set(name, [a]);
  }
  const out = [];
  for (const date of [...byDate.keys()].sort().reverse()) {
    const queues = [...byDate.get(date).entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([, queue]) => queue.sort((x, y) => x.id - y.id));
    if (mix) {
      // rodízio: uma volta por rodada, pulando as filas que já esgotaram
      const rounds = Math.max(...queues.map((q) => q.length));
      for (let round = 0; round < rounds; round++) {
        for (const queue of queues) if (round < queue.length) out.push(queue[round]);
      }
    } else {
      for (const queue of queues) out.push(...queue);
    }
  }
  return out;
}
