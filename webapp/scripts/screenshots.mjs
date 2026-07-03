// Screenshots de verificação do webapp: sobe `vite preview`, fotografa desktop (1440) e
// mobile (390) em dark+light, mais o preview (sheet) e o drawer de filtros no mobile.
// Usa o playwright/chromium do repo RAIZ (resolução de módulo sobe a árvore de diretórios).
// Saída: webapp/scripts/out/*.png (gitignorado). Rode: `npm run screenshots` em webapp/.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webappDir = path.resolve(here, '..');
const outDir = path.join(here, 'out');
mkdirSync(outDir, { recursive: true });

const PORT = 4318;
const BASE = `http://127.0.0.1:${PORT}`;

// --host 127.0.0.1 força IPv4: sem ele o preview faz bind só em [::1] e o poll abaixo falha
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: webappDir,
  stdio: 'ignore',
});
const kill = () => {
  try {
    server.kill('SIGTERM');
  } catch {
    /* já morreu */
  }
};
process.on('exit', kill);

// espera o preview responder (até ~15s)
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    const r = await fetch(BASE);
    up = r.ok;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (!up) {
  console.error('vite preview não subiu em', BASE);
  kill();
  process.exit(1);
}

const browser = await chromium.launch();
const shots = [
  { name: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
];

for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height } });
  const page = await ctx.newPage();
  await page.addInitScript((theme) => localStorage.setItem('nc-theme', theme), s.theme);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.waitForTimeout(900); // stagger de entrada assentar
  await page.screenshot({ path: path.join(outDir, `${s.name}.png`) });

  if (s.name === 'desktop-dark') {
    await page.click('.card-hit');
    await page.waitForSelector('.sheet-content p', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, 'desktop-dark-sheet.png') });
  }
  if (s.name === 'mobile-dark') {
    await page.click('.fab');
    await page.waitForSelector('.drawer', { timeout: 15000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, 'mobile-dark-drawer.png') });
  }
  await ctx.close();
}

await browser.close();
kill();
console.log('screenshots em', outDir);
