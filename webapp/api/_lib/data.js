// Carregamento do snapshot publicado (meta.json + articles.json) a partir do próprio deployment.
// articles.json tem ~36 MB: cache local em /tmp por instância (TTL curto) para o step-loop da run
// não re-descarregar o ficheiro a cada passo. Nunca entra no bundle da função.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { warn } from './log.js';

const TTL_MS = 10 * 60 * 1000;

async function cachedJson(url, name) {
  // nome por URL (hash): instâncias/desployments diferentes não partilham cache
  const suffix = createHash('sha1').update(url).digest('hex').slice(0, 10);
  const file = path.join(os.tmpdir(), `nc-admin-${name}-${suffix}.json`);
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < TTL_MS) {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    }
  } catch {
    /* sem cache — segue para a rede */
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`falha ao ler ${name} em ${url}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    await fs.writeFile(file, text);
  } catch (err) {
    warn(`tmp cache indisponível (${err.message})`);
  }
  return JSON.parse(text);
}

/** {meta, articles[]} do snapshot publicado em <base>/data/. */
export async function loadSnapshot(base) {
  const root = String(base).replace(/\/$/, '');
  const [meta, articles] = await Promise.all([
    cachedJson(`${root}/data/meta.json`, 'meta'),
    cachedJson(`${root}/data/articles.json`, 'articles'),
  ]);
  return { meta, articles: Array.isArray(articles) ? articles : [] };
}
