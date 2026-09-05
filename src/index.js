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
import { openLogFile, log, warn, errorLog } from './util.js';
import { providerInfo, ROOT } from './config.js';
import {
  printStatus, cmdCrawl, cmdAdd, cmdRemove, cmdReset, cmdExport, cmdSearch, cmdKey,
  cmdWeb,
  cmdLimits,
  cmdReclean, cmdInspect, cmdPurge, cmdFinish, cmdDeploy, cmdReextract,
} from './commands.js';
import { bootstrapFromCli, cmdBackup, cmdRestore } from './cli-restore.js';

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
      '                          [--ram-free-pct P] [--cpu-free-pct P]',
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
      '  node src/index.js export [--format md|json|web] [--all] [--out DIR] [--allow-shrink [wipe]]',
      '                          (web: snapshot JSON p/ o webapp em webapp/public/data; --all: acervo todo)',
      '                          --allow-shrink: publica um snapshot MENOR que o já publicado (redução',
      '                          INTENCIONAL, ex.: depois de `remove`/`purge`); --allow-shrink wipe libera',
      '                          até zerar o acervo do site. Sem eles o guard anti-encolhimento bloqueia.',
      '  node src/index.js finish [--budget USD] [--parallel N] [--limit N] [--no-verify|--no-classify|--no-summarize]',
      '                          termina os PENDENTES (verify+classify+summarize) SEM novo crawl; use --budget p/ limitar e retomar',
      '                          --force --yes: RE-PROCESSA o acervo INTEIRO por LLM e APAGA tags/',
      '                          classificações/resumos/vereditos antes (destrutivo e caro — o --yes',
      '                          é obrigatório junto do --force; faz BACKUP antes)',
      '  node src/index.js search <consulta> [--mode A|B] [--limit N] [--yes] [--all] [--budget USD] [--parallel N]',
      '  node src/index.js web [--port N] [--no-open]   buscador web (React) com filtros da base',
      `  node src/index.js key set <CHAVE> [--provider openrouter|deepseek] | key test [--provider …]`,
      `                          valida/salva a chave LLM (${providerInfo().name}; em ~/.newsletter-crawler/.env)`,
      '  node src/index.js limits [show | set --budget USD --parallel N --ram-max-pct P --ram-free-pct P --cpu-free-pct P]   limites persistentes',
      '  node src/index.js deploy [--force] [--no-wait] [--dry-run] [--include-code] [--timeout S]',
      '                          [--allow-shrink [wipe]]',
      '                          publica o site: exporta o snapshot, commita, dá push na main e ESPERA',
      '                          a Vercel publicar (confere o snapshot no ar). --force republica sem',
      '                          dado novo; --no-wait volta no push; --include-code leva o código junto;',
      '                          --allow-shrink publica um snapshot MENOR que o no ar (redução',
      '                          INTENCIONAL) e --allow-shrink wipe libera até zerar o site',
      '',
      'RECUPERAÇÃO (o acervo mora no git: webapp/public/data é a base de registro, não o SQLite local)',
      '  node src/index.js restore [--dry-run] [--limit N] [--ref <ref>] [--since <data>]',
      '                          [--body-policy best|first|longest] [--no-marker] [--yes]',
      '                          RECONSTRÓI o acervo a partir do HISTÓRICO DO GIT (a união de todos os',
      '                          snapshots commitados é maior que qualquer um isolado). --dry-run só',
      '                          mostra o que faria; --no-marker ignora a fronteira do wipe (é a',
      '                          escotilha de quem deu `reset` sem querer e QUER o acervo de volta);',
      '                          sobre base NÃO-vazia exige --yes e faz BACKUP antes.',
      '  node src/index.js backup [list | restore <arquivo|latest|best> --yes]',
      '                          cópia CONSISTENTE do banco (VACUUM INTO) em NC_HOME/backups; `list`',
      '                          mostra nº de artigos/tamanho/data; `restore` fecha a conexão, apaga',
      '                          o .db E os sidecars -wal/-shm (um -wal sobrevivente reaplicaria o',
      '                          banco velho por cima) e copia a cópia escolhida no lugar.',
      '  BOOTSTRAP: com a base VAZIA, crawl/finish/search/web/export/status/ui já restauram sozinhos',
      '  do git no início do comando — um clone novo do repositório vem com os dados. Desligue com',
      '  --no-restore ou CRAWLER_AUTO_RESTORE=false.',
      '',
      '  node src/index.js reset --yes --confirm <nº de artigos>   APAGA TODOS OS DADOS (slate limpo)',
      '                          o número a digitar é o de ARTIGOS que serão perdidos (sai no aviso);',
      '                          faz BACKUP antes E MEXE NO REPOSITÓRIO GIT em ROOT (o diretório do',
      '                          CÓDIGO, não o cwd): remove e COMMITA webapp/public/data + api/v1 (o',
      '                          snapshot do site) e grava .nc-wipe.json — rodar isto de dentro do repo',
      '                          altera o git do projeto e o site publica o acervo vazio no próximo',
      '                          deploy. Para voltar: ncrawl backup restore latest --yes, ou',
      '                          ncrawl restore --no-marker --yes.',
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
  'finish', 'search', 'web', 'key', 'limits', 'deploy', 'reset', 'clean', 'restore', 'backup',
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
    // BOOTSTRAP antes do render: a TUI mostra o status já no primeiro quadro, então uma base
    // vazia precisa ter voltado ANTES — senão a tela abre com "0 artigos" e o usuário manda
    // coletar tudo de novo. Este caminho NÃO passa por commands.js, por isso o gancho é aqui.
    bootstrapFromCli('ui', flags);
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
          '(use: crawl | status | inspect | reclean | reextract | purge | add | remove | export | finish | search | web | key | limits | deploy | restore | backup | reset | ui)',
      );
      process.exit(1);
    } else {
      // Log persistente por processo: NC_HOME/logs/<comando>-<timestamp>-<pid>.log (latest.log
      // aponta p/ ele). TODO o log do comando (log/warn/errorLog/debug) é gravado ali com flush
      // imediato — `tail -f` acompanha ao vivo mesmo com o stdout do npm buferizado num pipe.
      const logFile = openLogFile({ command: cmd });
      if (logFile) log(`log do run: ${logFile}`);
      // BOOTSTRAP: ponto ÚNICO de decisão (a allowlist e as condições vivem em cli-restore.js;
      // aqui só há a chamada). Base vazia + snapshot no histórico do git ⇒ o acervo volta antes
      // do comando rodar — "nunca recomece do zero". NUNCA fiado em printStatus() (o cmdReset o
      // chama no fim: o restore desfaria o reset no mesmo processo) nem em reset/key/limits/
      // add/remove/deploy. Depois do openLogFile p/ o relato do restore entrar no log da run.
      bootstrapFromCli(cmd, flags);
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
      } else if (cmd === 'restore') {
        cmdRestore(flags);
        db.close();
      } else if (cmd === 'backup') {
        const out = cmdBackup(rest, flags);
        if (!out?.closed) db.close(); // `backup restore` já fechou a conexão p/ trocar o arquivo
      } else if (cmd === 'reset' || cmd === 'clean') {
        // GUARD (o gesto é barato demais para o estrago): o reset age sobre ROOT — a raiz do
        // CÓDIGO, não o cwd. Rodado de dentro do repositório ele remove E COMMITA o snapshot do
        // site. Dizer isso ANTES da confirmação é o que transforma um reflexo em decisão.
        warn(
          `reset também MEXE NO REPOSITÓRIO GIT em ${ROOT} (a raiz do CÓDIGO, não o diretório atual): ` +
            'remove e COMMITA webapp/public/data + webapp/public/api/v1 e grava .nc-wipe.json — o site ' +
            'publicará o acervo VAZIO no próximo deploy. Para desfazer: ncrawl backup restore latest --yes.',
        );
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
