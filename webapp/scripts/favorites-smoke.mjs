#!/usr/bin/env node
/**
 * favorites-smoke.mjs — verificação Playwright da feature de FAVORITOS do webapp.
 *
 * Cobre os critérios de aceite:
 *   1. CARD: estrela alterna favorito SEM abrir o artigo; estado em `nc-favorites` (localStorage).
 *   2. SHEET: o preview do artigo espelha o estado; toggling lá sincroniza card + storage.
 *   3. FILTRO "Somente favoritos": grade reduz aos favoritados; pill removível devolve tudo.
 *   4. PERSISTÊNCIA: favoritos + filtro sobrevivem ao reload.
 *   5. VAZIO: sem favoritos com o filtro ligado mostra o empty state próprio.
 *   6. MOBILE: o drawer de filtros traz o switch de favoritos.
 *   7. Sem erros de console/pageerror em nenhuma rodada.
 *
 * Uso: cd webapp && npm run build && node scripts/favorites-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const errors = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function watch(page, label) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!/favicon|net::ERR|Failed to load resource/i.test(text)) errs.push(`console: ${text}`);
    }
  });
  return {
    assertClean: () => {
      if (errs.length) errors.push(`${label}: ${errs.join(' | ')}`);
      check(`sem erros de console/pageerror (${label})`, errs.length === 0, errs.slice(0, 2).join(' | '));
    },
  };
}

async function waitForApp(page) {
  await page.waitForSelector('.card[data-article-id]', { timeout: 60000 });
  await page.waitForSelector('.editorial-hero', { timeout: 15000 });
}

// contagem de cards ESTÁVEL: volta ao topo e deixa a coreografia (AnimatePresence popLayout)
// assentar — os cards que SAÍRAM ficam no DOM durante a animação e inflam a contagem (gotcha).
async function settleAndCount(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(950);
  return page.evaluate(() => document.querySelectorAll('.card[data-article-id]').length);
}

const starOf = (page, id) => page.locator(`.card[data-article-id="${id}"] .card-fav`);
const favIds = (page) =>
  page.evaluate(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('nc-favorites') || '{}');
      return Array.isArray(raw.ids) ? raw.ids : [];
    } catch {
      return [];
    }
  });

async function main() {
  const server = spawn(
    process.execPath,
    [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'pipe' },
  );
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite preview não subiu')), 20000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('http://127.0.0.1')) {
        clearTimeout(t);
        res();
      }
    });
    server.on('exit', (c) => rej(new Error(`vite preview saiu (${c})`)));
  });

  const browser = await chromium.launch();

  try {
    // ─────────────────────────── DESKTOP (pt-BR) ───────────────────────────
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
      const page = await ctx.newPage();
      const w = watch(page, 'desktop');
      // nc-tutorial-seen ANTES do goto: o modal de 1ª visita intercepta todo clique (gotcha)
      await page.addInitScript(() => localStorage.setItem('nc-tutorial-seen', '1'));
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await waitForApp(page);

      const total = await settleAndCount(page);
      check('desktop: cards trazem a estrela de favorito', (await page.locator('.card-fav').count()) > 0);
      const firstId = await page.locator('.card[data-article-id]').first().getAttribute('data-article-id');
      check('desktop: estrela começa desligada', (await starOf(page, firstId).getAttribute('aria-pressed')) === 'false');

      // 1. favoritar NÃO abre o artigo e grava em nc-favorites
      await starOf(page, firstId).click();
      await page.waitForTimeout(350);
      check('desktop: estrela liga (aria-pressed=true)', (await starOf(page, firstId).getAttribute('aria-pressed')) === 'true');
      check('desktop: favoritar NÃO abre o artigo', (await page.locator('.sheet-title').count()) === 0);
      check('desktop: id favoritado em nc-favorites ({v:1, ids})', (await favIds(page)).map(String).includes(String(firstId)), `ids=${JSON.stringify(await favIds(page))}`);
      check('desktop: sem filtro a grade não muda de tamanho', (await settleAndCount(page)) === total, `total=${total}`);

      // 2. sheet espelha o estado e o toggle de lá sincroniza
      await page.locator(`.card[data-article-id="${firstId}"] .card-hit`).click();
      await page.waitForSelector('.sheet-title', { timeout: 8000 });
      check('desktop: sheet mostra a estrela já favoritada', (await page.locator('.sheet-fav').getAttribute('aria-pressed')) === 'true');
      await page.locator('.sheet-fav').click();
      await page.waitForTimeout(300);
      check('desktop: desfavoritar no sheet limpa nc-favorites', (await favIds(page)).length === 0);
      await page.locator('.sheet-head-actions .icon-btn[aria-label="Fechar"]').click();
      await page.waitForSelector('.sheet-title', { state: 'detached', timeout: 8000 }).catch(() => {});

      // 3. filtro "somente favoritos": grade reduz aos favoritados + pill
      await starOf(page, firstId).click(); // favorita de novo
      const secondId = await page
        .locator('.card[data-article-id]')
        .nth(1)
        .getAttribute('data-article-id');
      await starOf(page, secondId).click();
      await page.waitForTimeout(300);
      check('desktop: dois favoritos em nc-favorites', (await favIds(page)).length === 2);

      await page.locator('label.switch-row', { hasText: 'Somente favoritos' }).locator('input').check();
      const filtered = await settleAndCount(page);
      check('desktop: filtro "somente favoritos" reduz a grade aos favoritados', filtered === 2, `cards=${filtered}`);
      const pillText = await page
        .locator('.pill', { hasText: 'Favoritos' })
        .first()
        .innerText()
        .catch(() => '');
      check('desktop: pill ★ Favoritos aparece', pillText.includes('Favoritos'), `pill="${pillText.trim()}"`);

      // 4. reload: favoritos + filtro sobrevivem
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForApp(page);
      const afterReload = await settleAndCount(page);
      check('desktop: favoritos + filtro sobrevivem ao reload', afterReload === 2, `cards=${afterReload}`);
      check(
        'desktop: estrelas continuam favoritadas após reload',
        (await starOf(page, firstId).getAttribute('aria-pressed')) === 'true' &&
          (await starOf(page, secondId).getAttribute('aria-pressed')) === 'true',
      );

      // pill remove o filtro e devolve a grade inteira
      await page.locator('.pill', { hasText: 'Favoritos' }).first().click();
      const backAll = await settleAndCount(page);
      check('desktop: pill remove o filtro e devolve a grade', backAll > 2, `cards=${backAll}`);

      // 5. empty state: filtro ligado + zero favoritos
      await page.locator('label.switch-row', { hasText: 'Somente favoritos' }).locator('input').check();
      await settleAndCount(page);
      await starOf(page, firstId).click();
      await starOf(page, secondId).click();
      await page.waitForTimeout(950);
      const emptyTitle = await page
        .locator('.state-title')
        .first()
        .innerText()
        .catch(() => '');
      check('desktop: empty state próprio sem favoritos', emptyTitle.includes('Nenhuma matéria favoritada'), `title="${emptyTitle.trim()}"`);

      w.assertClean();
      await ctx.close();
    }

    // ─────────────────────────── MOBILE (drawer) ───────────────────────────
    {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: 'pt-BR',
      });
      const page = await ctx.newPage();
      const w = watch(page, 'mobile');
      await page.addInitScript(() => localStorage.setItem('nc-tutorial-seen', '1'));
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await waitForApp(page);

      await page.tap('.filter-btn');
      await page.waitForSelector('.drawer .filter-panel', { timeout: 8000 });
      const switchVisible = await page
        .locator('.drawer label.switch-row', { hasText: 'Somente favoritos' })
        .isVisible()
        .catch(() => false);
      check('mobile: drawer de filtros traz "Somente favoritos"', switchVisible);
      const countHint = await page
        .locator('.drawer .filter-hint', { hasText: 'favorito' })
        .first()
        .innerText()
        .catch(() => '');
      check('mobile: contagem de favoritos visível no drawer', /favorit/i.test(countHint), `hint="${countHint.trim()}"`);
      await page.tap('.drawer-head-actions .icon-btn');
      await page.waitForSelector('.drawer', { state: 'detached', timeout: 8000 }).catch(() => {});
      w.assertClean();
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} verificações OK`);
  if (errors.length) console.log('erros capturados:', errors.join(' | '));
  process.exit(failed || errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('favorites-smoke falhou:', e);
  process.exit(1);
});
