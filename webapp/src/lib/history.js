// Histórico de buscas IA do webapp ESTÁTICO: persiste no NAVEGADOR (localStorage via storage.js),
// já que não há backend. Espelha a tabela `searches` do CLI/web local — cada busca CONCLUÍDA vira
// um registro CONGELADO (consulta, escopo, stats, custo e os hits como ids+vereditos LEVES); a
// restauração re-hidrata a ficha de cada hit do snapshot (byId no App), sem re-chamar a IA.
// Payload versionado `{v:1, items:[novo→antigo]}`. Auto-save SEM limite (decisão do usuário); só
// poda o suficiente p/ caber quando a quota do localStorage estoura (fail-open — nunca quebra a
// busca que já custou dinheiro).
import { getHistoryRaw, trySetHistory } from './storage.js';

const VERSION = 1;
const MAX_HITS = 1000; // teto defensivo por registro (paridade com SEARCH_WEB_MAX_ITEMS do servidor)

// id monotônico e único mesmo com vários saves no mesmo ms (Date.now sozinho colidiria).
let _seq = 0;
function makeId() {
  _seq += 1;
  return `${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/** Lê e valida o payload; qualquer corrupção/versão nova vira lista vazia (fail-open). */
export function loadHistory() {
  const raw = getHistoryRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.items)) return [];
    return parsed.items;
  } catch {
    return [];
  }
}

/** Grava a lista podando os mais antigos SÓ se a quota recusar (retry até caber ou esvaziar). */
function persist(items) {
  let list = items;
  for (;;) {
    if (trySetHistory(JSON.stringify({ v: VERSION, items: list }))) return list;
    if (list.length <= 1) {
      // nem 1 registro cabe: desiste de persistir, devolve o que der p/ a sessão em memória
      trySetHistory(JSON.stringify({ v: VERSION, items: [] }));
      return [];
    }
    // poda ~20% do rabo (os mais antigos) e re-tenta
    list = list.slice(0, Math.max(1, Math.floor(list.length * 0.8)));
  }
}

/**
 * Adiciona uma busca concluída ao topo do histórico e devolve a lista atualizada.
 * `result` = o retorno de runSearch (query/deep/scanned/total/relevant/failed/truncated/spentUsd/hits).
 * `scope` = {sourceId, from, to} usado na busca (p/ o re-rodar restaurar o mesmo recorte).
 */
export function addToHistory(result, scope = {}) {
  const entry = {
    id: makeId(),
    createdAt: new Date().toISOString(),
    query: result.query,
    deep: Boolean(result.deep),
    scope: { sourceId: scope.sourceId ?? null, from: scope.from || '', to: scope.to || '' },
    spec: result.spec || null, // o "entendimento" da consulta — banner ao reabrir (paridade com o fim da busca)
    stats: {
      scanned: result.scanned ?? 0,
      total: result.total ?? 0,
      relevant: result.relevant ?? (result.hits?.length ?? 0),
      failed: result.failed ?? 0,
      truncated: Boolean(result.truncated),
      spentUsd: result.spentUsd ?? 0,
    },
    hits: (result.hits || []).slice(0, MAX_HITS).map((h) => ({ id: h.id, relation: h.relation, kind: h.kind })),
  };
  return persist([entry, ...loadHistory()]);
}

/** Remove um registro por id; devolve a lista atualizada. */
export function removeFromHistory(id) {
  return persist(loadHistory().filter((e) => e.id !== id));
}

/** Esvazia o histórico; devolve []. */
export function clearHistory() {
  return persist([]);
}
