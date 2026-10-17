#!/usr/bin/env node
/**
 * e2e-redesign.mjs — verificação Playwright do webapp reconstruído (Editorial Tech Premium).
 *
 * Cobre os critérios de aceite da remodelação:
 *   1. MOBILE: botão de filtro abre o drawer SEM derrubar a aplicação (bug clássico);
 *      facetas em accordion funcionam; "Ver N artigos" fecha e filtra.
 *   2. PERSISTÊNCIA: aplicar filtro + rolar → reload restaura filtro, paginação e scrollY.
 *   3. DESKTOP: hero editorial com métricas, Command Palette ⌘K filtra e executa comandos.
 *   4. DARK/LIGHT: sem erros de console/pageerror em nenhuma das rodadas.
 *
 * Uso: cd webapp && npm run build && node scripts/e2e-redesign.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4319;
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
      // erros de rede/recurso que não são do app são filtrados
      if (!/favicon|net::ERR|Failed to load resource/i.test(text)) errs.push(`console: ${text}`);
    }
  });
  return {
    collect: () => errs,
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
  const userDataBase = mkdtempSync(join(tmpdir(), 'nc-e2e-'));

  try {
    // ─────────────────────────── MOBILE ───────────────────────────
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

      // 1. bug clássico: abrir o drawer de filtros não pode derrubar a app
      await page.tap('.filter-btn');
      await page.waitForSelector('.drawer .filter-panel', { timeout: 8000 });
      check('mobile: drawer de filtros abre sem derrubar a app', true);
      check('mobile: app ainda viva após abrir o drawer', (await page.locator('.app').count()) === 1);

      // accordion de facetas + interações
      const triggers = page.locator('.mui-accordion-trigger');
      const nTriggers = await triggers.count();
      check('mobile: facetas em accordion (9 grupos)', nTriggers === 9, `${nTriggers} grupos`);
      await triggers.nth(4).tap(); // abre uma faceta fechada
      await page.waitForTimeout(350);

      // marca uma fonte (persistência deve guardá-la)
      const firstSource = page.locator('.source-item input').first();
      await firstSource.tap();
      await page.waitForTimeout(250);
      const checkedName = await page.locator('.source-item[data-checked] .source-name').first().innerText();

      // CTA "Ver N artigos" fecha o drawer (espera a saída animada terminar)
      await page.tap('.drawer-footer .btn');
      await page
        .waitForSelector('.drawer', { state: 'detached', timeout: 8000 })
        .then(() => check('mobile: "Ver N artigos" fecha o drawer', true))
        .catch(() => check('mobile: "Ver N artigos" fecha o drawer', false, 'drawer continua no DOM'));

      // a lista reflete o filtro (pills + contagem)
      await page.waitForTimeout(700);
      const pillText = await page.locator('.pill').first().innerText().catch(() => '');
      check('mobile: filtro aplicado reflete em pill', pillText.toLowerCase().includes(checkedName.trim().toLowerCase()), `pill="${pillText}"`);

      // rola para baixo e espera o flush throttled do scroll
      await page.evaluate(() => window.scrollTo(0, 1500));
      await page.waitForTimeout(700);
      const yBefore = await page.evaluate(() => Math.round(window.scrollY));
      const stateRaw = await page.evaluate(() => localStorage.getItem('nc-view-state'));
      const saved = JSON.parse(stateRaw || '{}');
      check('mobile: nc-view-state persiste filtro+scroll', (saved.filters?.sourceIds?.length ?? 0) > 0 && saved.scrollY > 200, `scrollY=${saved.scrollY}, fontes=${JSON.stringify(saved.filters?.sourceIds)}`);

      // reload → filtros, paginação e scroll restaurados
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForApp(page);
      await page.waitForTimeout(900);
      const yAfter = await page.evaluate(() => Math.round(window.scrollY));
      const stillChecked = await page.locator('.source-item input').first().isChecked().catch(() => false);
      check('mobile: filtro sobrevive ao reload', (await page.locator('.pill').count()) > 0 || stillChecked);
      check('mobile: scroll restaurado após reload', yAfter > 200 && Math.abs(yAfter - yBefore) < Math.max(600, yBefore * 0.5), `antes=${yBefore} depois=${yAfter}`);

      w.assertClean();
      await ctx.close();
    }

    // ─────────────────────────── DESKTOP ───────────────────────────
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'pt-BR' });
      const page = await ctx.newPage();
      const w = watch(page, 'desktop');
      await page.addInitScript(() => localStorage.setItem('nc-tutorial-seen', '1'));
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await waitForApp(page);

      // hero editorial: 4 tiles de métrica
      const tiles = await page.locator('.editorial-stat-tile').count();
      check('desktop: hero editorial com 4 métricas', tiles === 4, `${tiles} tiles`);
      check('desktop: sidebar de filtros visível', (await page.locator('.sidebar .filter-panel').count()) === 1);

      // Command Palette ⌘K
      await page.keyboard.press('Control+KeyK');
      await page.waitForSelector('.cmdk-dialog', { timeout: 5000 });
      check('desktop: Command Palette abre com ⌘K', true);

      await page.fill('.cmdk-input', 'ferramentas');
      await page.waitForTimeout(300);
      const rows = await page.locator('.cmdk-row').count();
      check('desktop: paleta filtra comandos', rows > 0, `${rows} resultados`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      check('desktop: comando executa (paleta fecha)', (await page.locator('.cmdk-dialog').count()) === 0);
      const segOn = await page.locator('.seg-item[data-on] .seg-label').innerText().catch(() => '');
      check('desktop: comando aplicou filtro de tipo', /ferramentas/i.test(segOn), `segmento ativo="${segOn}"`);

      // resultado deve ter cards (não pode "sumir")
      await page.waitForTimeout(500);
      const cards = await page.locator('.card[data-article-id]').count();
      check('desktop: grade de cards renderiza após comando', cards > 0, `${cards} cards`);

      // abre um artigo (DetailSheet) e fecha
      await page.locator('.card-hit').first().click();
      await page.waitForSelector('.sheet .sheet-title', { timeout: 5000 });
      check('desktop: DetailSheet abre com título do artigo', true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      check('desktop: DetailSheet fecha no Esc', (await page.locator('.sheet .sheet-title').count()) === 0);

      w.assertClean();
      await ctx.close();
    }

    // ─────────────────────────── DARK ───────────────────────────
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', locale: 'pt-BR' });
      const page = await ctx.newPage();
      const w = watch(page, 'dark');
      await page.addInitScript(() => localStorage.setItem('nc-tutorial-seen', '1'));
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await waitForApp(page);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const rgb = bg.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
      const luminance = (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255;
      check('dark: fundo escuro aplicado', luminance < 0.35, `bg=${bg}`);
      w.assertClean();
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    rmSync(userDataBase, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações verdes`);
  if (errors.length) console.log(`ERROS COLETADOS:\n${errors.join('\n')}`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FALHA E2E:', e);
  process.exit(1);
});
