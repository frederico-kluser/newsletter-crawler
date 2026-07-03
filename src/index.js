#!/usr/bin/env node
// CLI + gate da UI. Sem args num terminal interativo (TTY) -> menu guiado (Ink); senão, faz o
// dispatch direto das flags/comandos (comportamento inalterado). Os comandos vivem em commands.js.
import { db } from './db.js';
import { closeBrowser } from './fetch.js';
import { closeParsePool } from './parse-pool.js';
import { errorLog } from './util.js';
import {
  printStatus, cmdCrawl, cmdAdd, cmdReset, cmdExport, cmdClassify, cmdSummarize, cmdSearch, cmdKey,
  cmdWeb,
  cmdLimits,
  cmdVerify, cmdReclean, cmdInspect, cmdPurge, cmdFinish,
} from './commands.js';

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
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
      '  node src/index.js verify [--limit N] [--force]   verificação pós-cadastro (ok|suspect|junk) sob demanda',
      '  node src/index.js reclean [--limit N]   re-limpa os "suspect" com passe forte (Pro) e re-verifica',
      '  node src/index.js purge <fonte> --yes [--selectors]   apaga os DADOS de uma fonte p/ refazer do zero',
      '  node src/index.js add <url> [--name "Nome"] [--type index|listing] [--max-index-pages N]',
      '  node src/index.js export [--format md|json] [--all]   (--all: acervo todo, não só a última run)',
      '  node src/index.js classify [--limit N] [--force] [--budget USD] [--parallel N]',
      '  node src/index.js summarize [--limit N] [--force] [--budget USD] [--parallel N]   resumo/título PT-BR',
      '  node src/index.js finish [--budget USD] [--parallel N] [--limit N] [--no-verify|--no-classify|--no-summarize]',
      '                          termina os PENDENTES (verify+classify+summarize) SEM novo crawl; use --budget p/ limitar e retomar',
      '  node src/index.js search <consulta> [--mode A|B] [--limit N] [--yes] [--all] [--budget USD] [--parallel N]',
      '  node src/index.js web [--port N] [--no-open]   buscador web (React) com filtros da base',
      '  node src/index.js key set <chave> | key test   valida/salva a chave OpenRouter (em ~/.newsletter-crawler/.env)',
      '  node src/index.js limits [show | set --budget USD --parallel N --ram-max-pct P]   limites persistentes',
      '  node src/index.js reset --yes     APAGA TODOS OS DADOS (slate limpo)',
      '',
      'Global: instale com `npm run link` e use `ncrawl <comando>` de qualquer lugar (dados em NC_HOME=~/.newsletter-crawler).',
      'Flags globais: --no-input (nunca abre a UI). Idioma da UI: CRAWLER_LANG=pt|en. NO_COLOR respeitado.',
    ].join('\n'),
  );
}

// ---------------- entrypoint ----------------
const { flags, rest } = parseFlags(process.argv.slice(2));
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
    // Import dinâmico: o caminho CLI nunca carrega ink/react. launchUI() é dona do teardown.
    const { launchUI } = await import('./ui/index.js');
    await launchUI();
  } else {
    const cmd = rest.shift();
    if (cmd === undefined) {
      printHelp(); // sem args e não-TTY (ou --no-input): ajuda, NÃO crawl
      db.close();
    } else if (cmd === 'crawl') {
      await cmdCrawl(flags);
      db.close();
    } else if (cmd === 'status') {
      printStatus();
      db.close();
    } else if (cmd === 'inspect') {
      cmdInspect(flags);
      db.close();
    } else if (cmd === 'verify') {
      await cmdVerify(flags);
      db.close();
    } else if (cmd === 'reclean') {
      await cmdReclean(flags);
      db.close();
    } else if (cmd === 'purge') {
      cmdPurge(rest, flags);
      db.close();
    } else if (cmd === 'add') {
      cmdAdd(rest, flags);
      db.close();
    } else if (cmd === 'export') {
      cmdExport(flags);
      db.close();
    } else if (cmd === 'classify') {
      await cmdClassify(flags);
      db.close();
    } else if (cmd === 'summarize') {
      await cmdSummarize(flags);
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
    } else if (cmd === 'reset' || cmd === 'clean') {
      cmdReset(flags);
      db.close();
    } else {
      errorLog(
        `comando desconhecido: ${cmd} ` +
          '(use: crawl | status | inspect | verify | purge | add | export | classify | summarize | finish | search | web | key | limits | reset | ui)',
      );
      process.exit(1);
    }
  }
} catch (e) {
  errorLog(e.stack || e.message);
  await closeBrowser();
  await closeParsePool();
  process.exit(1);
}
