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

// Pool com largura ADAPTATIVA: como o asyncPool, drena `items` preservando a ordem e faz
// fail-open por item no `fn` — mas relê `getLimit()` a cada folga, então a concorrência efetiva
// acompanha a lane AIMD (lane.js) e encolhe/cresce ao vivo. Encolher NÃO preempta quem já está
// em voo; crescer só admite novos workers quando algum termina. `signal` aborta e para o pool.
export function adaptivePool(items, fn, { getLimit, signal } = {}) {
  const results = new Array(items.length);
  const limitNow = () => Math.max(1, Math.floor(getLimit ? getLimit() : items.length) || 1);
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let finished = 0;
    let stopped = false;
    const fail = (e) => {
      if (!stopped) {
        stopped = true;
        reject(e);
      }
    };
    const pump = () => {
      if (stopped) return;
      if (finished >= items.length) {
        resolve(results);
        return;
      }
      if (signal?.aborted) {
        fail(signal.reason || new DOMException('abortado', 'AbortError'));
        return;
      }
      while (active < limitNow() && next < items.length) {
        const i = next++;
        active++;
        Promise.resolve()
          .then(() => fn(items[i], i))
          .then((r) => {
            results[i] = r;
          })
          .catch(fail)
          .finally(() => {
            active--;
            finished++;
            pump();
          });
      }
    };
    pump();
  });
}
