// Pool de concorrência mínimo (substitui o p-limit do CLI no browser): N workers drenam a
// lista preservando a ORDEM dos resultados. Erros do `fn` propagam (o chamador da busca faz
// fail-open por item DENTRO do fn; só o abort escapa de propósito, p/ parar o pool inteiro).
export async function asyncPool(limit, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
