// Estimativa de custo pré-busca — espelho de estimateStageCallUsd (src/budget.js do CLI):
// usa a média REAL por chamada do estágio quando o export trouxe amostra (meta.search.costHints),
// senão os SEEDS por tier (Flash 0.005 / Pro 0.05). Regra de confirmação: profunda SEMPRE
// confirma (como a UI atual); soft só acima de softConfirm (o escopo raramente passa de 4000).
const SEED_FLASH = 0.005;
const SEED_PRO = 0.05;
const seedForModel = (model) => (String(model || '').includes('flash') ? SEED_FLASH : SEED_PRO);

export function estimateSearch({ count, deep, search }) {
  const stage = deep ? 'searchRelevance' : 'searchBatch';
  const model = search.models?.[stage]?.model;
  const calls = deep ? count : Math.ceil(count / (search.batchSize || 40));
  const perCall = search.costHints?.[stage] ?? seedForModel(model);
  const usd = calls * perCall;
  const needsConfirm = deep || count > (search.softConfirm ?? 4000);
  return { calls, usd, needsConfirm };
}
