#!/usr/bin/env node
// CLI + gate da UI. Sem args num terminal interativo (TTY) -> menu guiado (Ink); senão, faz o
// dispatch direto das flags/comandos (comportamento inalterado). Os comandos vivem em commands.js.
// --help/-h e --version/-V são tratados ANTES de qualquer comando: `crawl --help` mostra a ajuda
// e NÃO inicia um crawl (regressão do acidente real em que --help iniciava a coleta).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { closeBrowser } from './fetch.js';
import { closeParsePool } from './parse-pool.js';
import { openLogFile, log, errorLog } from './util.js';
import { providerInfo, ROOT } from './config.js';
import {
  printStatus, cmdCrawl, cmdAdd, cmdRemove, cmdReset, cmdExport, cmdSearch, cmdKey,
  cmdWeb,
  cmdLimits,
  cmdReclean, cmdInspect, cmdPurge, cmdFinish, cmdDeploy, cmdReextract,
} from './commands.js';

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a === '-V' || a === '--version') {
      flags.version = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

// Versão do package.json p/ --version (fail-open: ausente/inválido não derruba o CLI).
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
})();

function printHelp() {
  // Usage humano (sem timestamp): console direto é apropriado aqui (não é log de execução).
  console.log(
    [
      'newsletter-crawler — uso:',
      '  node src/index.js                 menu guiado (terminal interativo)  [npm start]',
      '  node src/index.js ui | menu       abre o menu guiado                  [npm run ui]',
      '  node src/index.js crawl [--sources "A,B" | --source "Nome" | --only <substr>] [--since <data>]',
      '                          [--max-pages N] [--max-articles N] [--no-aggressive] [--no-refresh]',
      '                          [--no-classify] [--no-summarize] [--no-verify] [--budget USD] [--parallel N]',
      '                          modo agressivo é o DEFAULT (ignora robots.txt + UA de navegador real);',
      '                          --no-aggressive volta ao modo educado. --no-refresh: só drena a fila.',
      '  node src/index.js status',
      '  node src/index.js inspect [--run N] [--url <substr>] [--verbose]   auditoria da run (itens, vereditos, motivos)',
      '  node src/index.js reclean [--limit N]   re-limpa os "suspect" com passe forte (Pro) e re-verifica',
      '  node src/index.js reextract [--url <substr>] [--limit N] [--all]   RE-EXTRAI do zero artigos salvos',
      '                          (re-fetch + re-parse + re-clean + re-verify; conserta release notes',
      '                          do GitHub truncadas em botão e molduras/colagens da captura 2026-08-14;',
      '                          sem --limit, só as primeiras 20 fichas — varredura completa exige --all)',
      '  node src/index.js purge <fonte> --yes [--selectors]   apaga os DADOS de uma fonte p/ refazer do zero',
      '  node src/index.js add <url> [--name "Nome"] [--type index|listing] [--max-index-pages N]',
      '                          (o TIPO é detectado por IA automaticamente; --type força manual)',
      '  node src/index.js remove <fonte> --yes   DESCADASTRA a fonte e APAGA todo o conteúdo dela',
      '  node src/index.js export [--format md|json|web] [--all] [--out DIR]',
      '                          (web: snapshot JSON p/ o webapp em webapp/public/data; --all: acervo todo)',
      '  node src/index.js finish [--budget USD] [--parallel N] [--limit N] [--no-verify|--no-classify|--no-summarize]',
      '                          termina os PENDENTES (verify+classify+summarize) SEM novo crawl; use --budget p/ limitar e retomar',
      '  node src/index.js search <consulta> [--mode A|B] [--limit N] [--yes] [--all] [--budget USD] [--parallel N]',
      '  node src/index.js web [--port N] [--no-open]   buscador web (React) com filtros da base',
      `  node src/index.js key set <CHAVE> [--provider openrouter|deepseek] | key test [--provider …]`,
      `                          valida/salva a chave LLM (${providerInfo().name}; em ~/.newsletter-crawler/.env)`,
      '  node src/index.js limits [show | set --budget USD --parallel N --ram-max-pct P]   limites persistentes',
      '  node src/index.js deploy [--force] [--no-wait] [--dry-run] [--include-code] [--timeout S]',
      '                          publica o site: exporta o snapshot, commita, dá push na main e ESPERA',
      '                          a Vercel publicar (confere o snapshot no ar). --force republica sem',
      '                          dado novo; --no-wait volta no push; --include-code leva o código junto',
      '  node src/index.js reset --yes     APAGA TODOS OS DADOS (slate limpo)',
      '',
      'Global: instale com `npm run link` e use `ncrawl <comando>` de qualquer lugar (dados em NC_HOME=~/.newsletter-crawler).',
      'Flags globais: --no-input (nunca abre a UI). --help/-h (ajuda) e --version/-V (versão) valem em qualquer comando.',
      'Idioma da UI: CRAWLER_LANG=pt|en. NO_COLOR respeitado.',
      'Log de cada execução: NC_HOME/logs/<comando>-<data>-<pid>.log (latest.log aponta p/ a última;',
      'todo o log sai com flush imediato — `tail -f NC_HOME/logs/latest.log` acompanha ao vivo).',
    ].join('\n'),
  );
}

// Comandos que abrem o log persistente do processo e fazem dispatch (o resto é erro de uso).
const KNOWN_COMMANDS = new Set([
  'crawl', 'status', 'inspect', 'reclean', 'reextract', 'purge', 'add', 'remove', 'export',
  'finish', 'search', 'web', 'key', 'limits', 'deploy', 'reset', 'clean',
]);

// ---------------- entrypoint ----------------
const { flags, rest } = parseFlags(process.argv.slice(2));

// Ajuda/versão SEMPRE antes de qualquer comando/UI — nunca disparam efeito colateral.
if (flags.help === true) {
  printHelp();
  db.close();
  process.exit(0);
}
if (flags.version === true) {
  console.log(`newsletter-crawler ${VERSION}`);
  db.close();
  process.exit(0);
}

const explicit = rest[0]; // só espia (não shift): precisamos saber se é "sem comando"
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const noInput = flags['no-input'] === true || /^(1|true)$/i.test(process.env.NO_INPUT || '');
const wantUI = explicit === 'ui' || explicit === 'menu';
const bareInteractive = explicit === undefined && interactive && !noInput;

try {
  if (wantUI || bareInteractive) {
    if (!interactive) {
      errorLog('o menu (ui) requer um terminal interativo (TTY). Use os comandos/flags diretos.');
      process.exit(1);
    }
    // Log persistente também no menu: as runs da TUI ficam em NC_HOME/logs/ui-*.log (sem
    // anúncio — o feed da UI já mostra o log ao vivo).
    openLogFile({ command: 'ui' });
    // Import dinâmico: o caminho CLI nunca carrega ink/react. launchUI() é dona do teardown.
    const { launchUI } = await import('./ui/index.js');
    await launchUI();
  } else {
    const cmd = rest.shift();
    if (cmd === undefined) {
      printHelp(); // sem args e não-TTY (ou --no-input): ajuda, NÃO crawl
      db.close();
    } else if (!KNOWN_COMMANDS.has(cmd)) {
      errorLog(
        `comando desconhecido: ${cmd} ` +
          '(use: crawl | status | inspect | reclean | reextract | purge | add | remove | export | finish | search | web | key | limits | deploy | reset | ui)',
      );
      process.exit(1);
    } else {
      // Log persistente por processo: NC_HOME/logs/<comando>-<timestamp>-<pid>.log (latest.log
      // aponta p/ ele). TODO o log do comando (log/warn/errorLog/debug) é gravado ali com flush
      // imediato — `tail -f` acompanha ao vivo mesmo com o stdout do npm buferizado num pipe.
      const logFile = openLogFile({ command: cmd });
      if (logFile) log(`log do run: ${logFile}`);
      if (cmd === 'crawl') {
        await cmdCrawl(flags);
        db.close();
        // Backstop duro contra zumbi de teardown (ex.: chrome filho órfão com pipes segura
        // o event loop — o nodo fica vivo "para sempre" sem o extrato ser o fim). Timer
        // unref'd: se o processo já saiu naturalmente, ele nunca dispara; se algo segurar,
        // força a saída 150ms depois. Tudo do run já está commitado (writes síncronas).
        setTimeout(() => process.exit(0), 150);
      } else if (cmd === 'status') {
        printStatus();
        db.close();
      } else if (cmd === 'inspect') {
        cmdInspect(flags);
        db.close();
      } else if (cmd === 'reclean') {
        await cmdReclean(flags);
        db.close();
      } else if (cmd === 'reextract') {
        await cmdReextract(flags);
        db.close();
      } else if (cmd === 'purge') {
        cmdPurge(rest, flags);
        db.close();
      } else if (cmd === 'add') {
        await cmdAdd(rest, flags);
        db.close();
      } else if (cmd === 'remove') {
        cmdRemove(rest, flags);
        db.close();
      } else if (cmd === 'export') {
        cmdExport(flags);
        db.close();
      } else if (cmd === 'finish') {
        await cmdFinish(flags);
        db.close();
      } else if (cmd === 'search') {
        await cmdSearch(rest, flags);
        db.close();
      } else if (cmd === 'web') {
        await cmdWeb(flags);
        db.close();
      } else if (cmd === 'key') {
        await cmdKey(rest, flags);
        db.close();
      } else if (cmd === 'limits') {
        cmdLimits(rest, flags);
        db.close();
      } else if (cmd === 'deploy') {
        await cmdDeploy(flags);
        db.close();
      } else if (cmd === 'reset' || cmd === 'clean') {
        cmdReset(flags);
        db.close();
      }
    }
  }
} catch (e) {
  errorLog(e.stack || e.message);
  await closeBrowser();
  await closeParsePool();
  process.exit(1);
}
