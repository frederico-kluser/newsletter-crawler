// Fachada de limpeza/extração. Re-exporta o NÚCLEO PURO (parse-core) para o resto do app e os
// testes, e adiciona as versões ASSÍNCRONAS das ops JSDOM roteadas pelo POOL DE WORKERS
// (parse-pool) — isolando o JSDOM do processo principal (um SIGSEGV mata só o worker). As ops
// cheerio/puras (pruneForLLM, extractPublishedDate, linksInHtml, …) seguem síncronas no
// processo principal (leves e seguras). cpuParse cede o event loop p/ essas ops leves.
import { getLane } from './governor.js';
import { runParse } from './parse-pool.js';

export {
  capHtml, extractArticle, linksInHtml, readableLinks, probablyArticle, pruneForLLM,
  htmlToMarkdown, isBlockedPage, extractPublishedDate, fallbackTitle, applyJunkSpans,
  sanityCheckCleaned,
} from './parse-core.js';

// Cede o event loop antes de um parse cheerio SÍNCRONO leve (prune), sob a lane cpu do
// governador (que encolhe se o loop atola). As ops JSDOM pesadas NÃO passam por aqui — vão
// pro pool de workers via *Async abaixo.
export async function cpuParse(fn) {
  return getLane('cpu')(async () => {
    await new Promise((r) => setImmediate(r));
    return fn();
  });
}

// ---- ops JSDOM no pool de workers (fallback inline se o pool indisponível) ----
// O safeDefault espelha o retorno de FALHA da função pura: extractArticle -> null,
// readableLinks -> vazio, probablyArticle -> false. O chamador já trata esses casos.
export function extractArticleAsync(html, url) {
  return runParse('extractArticle', [html, url], null);
}
export function readableLinksAsync(html, url) {
  return runParse('readableLinks', [html, url], { title: null, textLen: 0, links: [] });
}
export function probablyArticleAsync(html, url) {
  return runParse('probablyArticle', [html, url], false);
}
