#!/bin/bash
# =============================================================================
# rotina-diaria.sh — rotina diária do newsletter-crawler no Mac mini (minim1)
# =============================================================================
# Instalada por scripts/install-rotina-diaria.sh como LaunchDaemon
# com.nc.daily-crawl (05:00, hora local), que abre uma sessão SSH local com uma
# chave dedicada e forced command:
#
#   command="/Volumes/Ext2TB/Projects/newsletter-crawler/scripts/rotina-diaria.sh run",restrict
#
# A sessão SSH herda a Full Disk Access do sshd-keygen-wrapper; um job de
# launchd direto NÃO consegue ler/escrever em /Volumes/Ext2TB (TCC de volume
# removível) — ver docs/rotina-diaria/dossie-pesquisa.md.
#
# Uso:
#   rotina-diaria.sh run [--force]   # coleta + finish + deploy + Pages + alerta
#   rotina-diaria.sh status          # última execução, lock, saldo, site
#   rotina-diaria.sh preflight       # só checagens (não gasta)
#   rotina-diaria.sh send-test       # alerta local + e-mail de teste (se configurado)
#
# Artefactos:
#   log:       ~/.newsletter-crawler/logs/rotina-diaria.log (rotação 5 MiB)
#   estado:    ~/.local/state/nc-daily/last-run.json
#   lock:      ~/.local/state/newsletter-crawler/coletar-e-publicar.lock
#              (o MESMO lock do comando manual `npm run atualizar`)
# =============================================================================
set -uo pipefail

export HOME=/Users/minim1
export USER=minim1
export LOGNAME=minim1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
umask 077

PROJECT="${NC_PROJECT:-/Volumes/Ext2TB/Projects/newsletter-crawler}"
NC_HOME="${NC_HOME:-$HOME/.newsletter-crawler}"
NODE="${NODE:-$HOME/.local/bin/node}"
PYTHON="${PYTHON:-$(command -v python3 2>/dev/null || echo /usr/bin/python3)}"
GH="${GH:-$(command -v gh 2>/dev/null || echo /opt/homebrew/bin/gh)}"
SQLITE="${SQLITE:-/usr/bin/sqlite3}"

NC_LOGS="$NC_HOME/logs"
STATE="$HOME/.local/state/nc-daily"
SHARED_STATE="$HOME/.local/state/newsletter-crawler"
LOCK="$SHARED_STATE/coletar-e-publicar.lock"
LOG="$NC_LOGS/rotina-diaria.log"
DB="$NC_HOME/crawler.db"

SINCE="${NC_SINCE:-2026-01-01}"
SITE_URL="${NC_SITE_URL:-https://frederico-kluser.github.io}"
SITE_META="${SITE_URL%/}/data/meta.json"
PAGES_REPO="${NC_PAGES_REPO:-frederico-kluser/frederico-kluser.github.io}"
PAGES_WORKFLOW="${NC_PAGES_WORKFLOW:-deploy.yml}"
FRESH_HOURS="${NC_FRESH_HOURS:-12}"
DEPLOY_WAIT="${NC_DEPLOY_WAIT:-${NC_DEPLOY_TIMEOUT:-900}}"
MIN_OPENROUTER_USD="${NC_MIN_OPENROUTER_USD:-3}"
LOG_ROTATE_BYTES="${NC_LOG_ROTATE_BYTES:-5242880}"

START_EPOCH=0
END_EPOCH=0
DURATION=0
NEW_ARTICLES=0
TOTAL_ARTICLES=0
TOTAL_BEFORE=0
TOTAL_AFTER=0
SNAPSHOT=""
OPENROUTER_REMAINING="unknown"
MAIL_STATUS=""
REPORT_BODY=""
PAGES_RUN_URL=""
FAIL_STAGE=""
FAIL_CODE=0
LOCK_HELD=0

mkdir -p "$STATE" "$NC_LOGS" "$SHARED_STATE" 2>/dev/null || true
chmod 700 "$STATE" "$SHARED_STATE" 2>/dev/null || true
touch "$LOG" 2>/dev/null || true
chmod 600 "$LOG" 2>/dev/null || true

iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() {
    local line
    line="$(date '+%F %T') $*"
    printf '%s\n' "$line" >>"$LOG" 2>&1
    printf '%s\n' "$line"
}

rotate_log() {
    local sz
    sz=$(wc -c <"$LOG" 2>/dev/null || echo 0)
    if [ "${sz:-0}" -gt "$LOG_ROTATE_BYTES" ]; then
        mv -f "$LOG" "$LOG.1" 2>/dev/null || true
        : >"$LOG"
        chmod 600 "$LOG" 2>/dev/null || true
    fi
}

state_set() {
    "$PYTHON" - "$STATE/last-run.json" "$@" <<'PY'
import json, os, sys, time
p = sys.argv[1]
d = {}
try:
    with open(p, encoding='utf-8') as f:
        d = json.load(f)
except Exception:
    pass
for arg in sys.argv[2:]:
    k, _, v = arg.partition('=')
    if k:
        d[k] = v
d['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
tmp = p + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
os.replace(tmp, p)
PY
}

state_get() {
    "$PYTHON" -c 'import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    print(d.get(sys.argv[2], ""))
except Exception:
    print("")' "$STATE/last-run.json" "$1" 2>/dev/null
}

fresh_enough() {
    [ "$(state_get status)" = "ok" ] || return 1
    local ended age
    ended=$(state_get ended_epoch)
    [ -n "$ended" ] || return 1
    age=$(( $(date +%s) - ended ))
    [ "$age" -ge 0 ] && [ "$age" -lt $((FRESH_HOURS * 3600)) ]
}

acquire_lock() {
    if mkdir "$LOCK" 2>/dev/null; then
        printf '%s\n' "$$" >"$LOCK/pid"
        LOCK_HELD=1
        return 0
    fi
    local old
    old=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        log "lock ocupado por pid $old — saltando esta execução"
        return 1
    fi
    rm -rf "$LOCK" 2>/dev/null || true
    if mkdir "$LOCK" 2>/dev/null; then
        printf '%s\n' "$$" >"$LOCK/pid"
        LOCK_HELD=1
        return 0
    fi
    log "não consegui criar o lock $LOCK"
    return 1
}

cleanup() {
    if [ "$LOCK_HELD" = 1 ]; then
        rm -rf "$LOCK" 2>/dev/null || true
        LOCK_HELD=0
    fi
}

db_count() {
    local n
    n=$("$SQLITE" "$DB" 'select count(*) from articles;' 2>/dev/null) || n=0
    printf '%s' "${n:-0}"
}

openrouter_remaining() {
    "$PYTHON" - "$NC_HOME/.env" "$PROJECT/.env" <<'PY'
import json, os, sys, urllib.request

key = os.environ.get('OPENROUTER_API_KEY', '')

def load(path):
    global key
    try:
        for line in open(path, encoding='utf-8', errors='replace'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            if k.strip() == 'OPENROUTER_API_KEY':
                key = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass

# NC_HOME/.env vence o .env do repo (mesma ordem do config.js)
load(sys.argv[2])
load(sys.argv[1])
if not key:
    print('unknown')
    raise SystemExit
req = urllib.request.Request(
    'https://openrouter.ai/api/v1/credits',
    headers={'Authorization': 'Bearer ' + key},
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r).get('data', {})
    print('%.2f' % (float(d.get('total_credits', 0)) - float(d.get('total_usage', 0))))
except Exception:
    print('error')
PY
}

preflight() {
    local fail=0 avail
    log "preflight: projeto, TCC, node, gh, site, banco, chaves, espaço"
    if [ ! -d "$PROJECT" ]; then
        log "  ✗ projeto ausente: $PROJECT"
        fail=1
    fi
    if [ -d "$PROJECT" ] && ! head -c 1 "$PROJECT/package.json" >/dev/null 2>&1; then
        log "  ✗ projeto ilegível (TCC/FDA?)"
        fail=1
    fi
    if ! command -v "$NODE" >/dev/null 2>&1; then
        log "  ✗ node ausente: $NODE"
        fail=1
    elif ! "$NODE" -e 'const fs=require("fs");process.exit(fs.readFileSync(process.argv[1],"utf8").length>0?0:1)' "$PROJECT/package.json" >/dev/null 2>&1; then
        log "  ✗ node não consegue ler o projeto (TCC/FDA?)"
        fail=1
    fi
    if ! command -v "$GH" >/dev/null 2>&1; then
        log "  ✗ gh ausente"
        fail=1
    elif ! "$GH" auth status >/dev/null 2>&1; then
        log "  ✗ gh não autenticado"
        fail=1
    fi
    if [ ! -f "$DB" ]; then
        log "  ✗ banco ausente: $DB"
        fail=1
    fi
    if ! curl -fsS --max-time 20 "$SITE_META" >/dev/null 2>&1; then
        log "  ✗ site não respondeu: $SITE_META"
        fail=1
    fi
    if [ "$(git -C "$PROJECT" branch --show-current 2>/dev/null)" != "main" ]; then
        log "  ✗ repo não está na main"
        fail=1
    fi
    if [ ! -f "$PROJECT/webapp/package-lock.json" ]; then
        log "  ✗ webapp/package-lock.json ausente"
        fail=1
    fi
    if [ ! -d "$PROJECT/webapp/node_modules" ]; then
        log "  ! webapp/node_modules ausente (o build do site roda no GitHub; ok)"
    fi
    local key_ok=0
    if [ -n "${OPENROUTER_API_KEY:-}" ] || [ -n "${DEEPSEEK_API_KEY:-}" ]; then
        key_ok=1
    fi
    if grep -qE '^OPENROUTER_API_KEY=.+' "$NC_HOME/.env" "$PROJECT/.env" 2>/dev/null; then
        key_ok=1
    fi
    if grep -qE '^DEEPSEEK_API_KEY=.+' "$NC_HOME/.env" "$PROJECT/.env" 2>/dev/null; then
        key_ok=1
    fi
    if [ "$key_ok" = 0 ]; then
        log "  ✗ nenhuma chave LLM (OPENROUTER_API_KEY/DEEPSEEK_API_KEY)"
        fail=1
    fi
    avail=$(df -k /Volumes/Ext2TB 2>/dev/null | awk 'NR==2{print $4}')
    if [ -n "${avail:-}" ] && [ "$avail" -lt 10485760 ]; then
        log "  ✗ pouco espaço em /Volumes/Ext2TB (< 10 GiB livres)"
        fail=1
    fi
    if [ "$fail" = 0 ]; then
        log "  ✓ preflight ok"
    else
        log "  ✗ preflight falhou"
    fi
    return "$fail"
}

build_report() {
    local outcome="$1"
    REPORT_BODY="$STATE/report.txt"
    {
        echo "Rotina diária — newsletter-crawler"
        echo "Data: $(date '+%F %T %Z')"
        echo "Resultado: $outcome"
        if [ -n "$FAIL_STAGE" ]; then
            echo "Etapa da falha: $FAIL_STAGE (exit $FAIL_CODE)"
        fi
        echo "Duração: ${DURATION}s"
        echo "Novos artigos: $NEW_ARTICLES"
        echo "Total no banco: $TOTAL_ARTICLES"
        echo "Snapshot: ${SNAPSHOT:-—}"
        echo "Site: $SITE_URL"
        if [ -n "$PAGES_RUN_URL" ]; then
            echo "Deploy Pages: $PAGES_RUN_URL"
        fi
        echo "OpenRouter restante: US$ ${OPENROUTER_REMAINING}"
        echo "Log: $LOG"
        if [ "$outcome" != "sucesso" ]; then
            echo
            echo "Últimas 40 linhas do log:"
            tail -40 "$LOG" 2>/dev/null
        fi
    } >"$REPORT_BODY"
    chmod 600 "$REPORT_BODY" 2>/dev/null || true
}

local_alert() {
    local title="$1" msg="$2"
    if command -v terminal-notifier >/dev/null 2>&1; then
        terminal-notifier -title "$title" -message "$msg" >/dev/null 2>&1 || true
    elif command -v osascript >/dev/null 2>&1; then
        perl -e 'alarm 5; exec @ARGV' osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$title" "$msg" >/dev/null 2>&1 || true
    fi
}

send_alerts() {
    local outcome="$1" subject="$2" mail="not-configured"
    build_report "$outcome"
    if grep -qE '^NC_SMTP_URL=' "$NC_HOME/.env" 2>/dev/null; then
        if "$PYTHON" "$PROJECT/scripts/notify-email.py" --subject "$subject" --body-file "$REPORT_BODY" >>"$LOG" 2>&1; then
            mail="sent"
        else
            mail="error"
        fi
    else
        log "e-mail não configurado (NC_SMTP_URL ausente) — alerta local apenas"
    fi
    MAIL_STATUS="$mail"
    state_set "mail=$mail"
    local_alert "newsletter-crawler" "$subject"
}

finish_ok() {
    END_EPOCH=$(date +%s)
    DURATION=$((END_EPOCH - START_EPOCH))
    state_set "status=ok" "stage=done" "exit_code=0" \
        "ended_at=$(iso)" "ended_epoch=$END_EPOCH" \
        "new_articles=$NEW_ARTICLES" "total_articles=$TOTAL_ARTICLES" \
        "snapshot=$SNAPSHOT" "openrouter_remaining=$OPENROUTER_REMAINING" \
        "site_url=$SITE_URL" "pages_run=$PAGES_RUN_URL" "log=$LOG"
    send_alerts "sucesso" "newsletter-crawler OK — $NEW_ARTICLES novos, site no ar"
    log "=== rotina terminou OK (${DURATION}s, $NEW_ARTICLES novos) ==="
    exit 0
}

finish_fail() {
    local rc="${1:-1}"
    FAIL_CODE="$rc"
    END_EPOCH=$(date +%s)
    DURATION=$((END_EPOCH - START_EPOCH))
    state_set "status=error" "stage=${FAIL_STAGE:-erro}" "exit_code=$rc" \
        "ended_at=$(iso)" "ended_epoch=$END_EPOCH" \
        "new_articles=$NEW_ARTICLES" "total_articles=$TOTAL_ARTICLES" \
        "snapshot=$SNAPSHOT" "openrouter_remaining=$OPENROUTER_REMAINING" \
        "site_url=$SITE_URL" "pages_run=$PAGES_RUN_URL" "log=$LOG"
    send_alerts "falha" "newsletter-crawler FALHOU — ${FAIL_STAGE:-erro}"
    log "=== rotina terminou com ERRO (stage=${FAIL_STAGE:-erro} rc=$rc, ${DURATION}s) ==="
    exit "$rc"
}

run_crawl() {
    log "1/4 crawl --since $SINCE (todas as fontes)"
    cd "$PROJECT" || return 1
    "$NODE" --env-file-if-exists=.env src/index.js crawl --since "$SINCE" >>"$LOG" 2>&1
    local rc=$?
    log "crawl exit=$rc"
    return "$rc"
}

run_finish() {
    log "2/4 finish (drena verify/classify/summarize)"
    cd "$PROJECT" || return 1
    "$NODE" --env-file-if-exists=.env src/index.js finish >>"$LOG" 2>&1
    local rc=$?
    log "finish exit=$rc"
    return "$rc"
}

run_deploy() {
    log "3/4 deploy --no-wait (export + PR + squash; site=$SITE_URL)"
    cd "$PROJECT" || return 1
    NC_SITE_URL="$SITE_URL" "$NODE" --env-file-if-exists=.env src/index.js deploy --no-wait >>"$LOG" 2>&1
    local rc=$?
    log "deploy exit=$rc"
    return "$rc"
}

dispatch_pages() {
    log "4/4 disparar o workflow de publicação no GitHub Pages"
    if ! "$GH" api "repos/$PAGES_REPO/dispatches" -X POST -f event_type=nc-deploy >/dev/null 2>&1; then
        log "falha ao disparar o workflow do Pages ($PAGES_REPO)"
        return 1
    fi
    sleep 5
    PAGES_RUN_URL=$("$GH" run list -R "$PAGES_REPO" --workflow "$PAGES_WORKFLOW" --limit 1 --json url --jq '.[0].url' 2>/dev/null || true)
    log "Pages run: ${PAGES_RUN_URL:-aguardando}"
    return 0
}

poll_pages() {
    local target deadline live gen
    target=$("$PYTHON" -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8")).get("generatedAt",""))' "$PROJECT/webapp/public/data/meta.json" 2>/dev/null)
    if [ -z "$target" ]; then
        log "não consegui ler o generatedAt local"
        return 1
    fi
    log "à espera do site servir o snapshot $target (limite ${DEPLOY_WAIT}s)"
    deadline=$(( $(date +%s) + DEPLOY_WAIT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        live=$(curl -fsS --max-time 20 "${SITE_META}?t=$(date +%s)" 2>/dev/null || true)
        gen=$(printf '%s' "$live" | "$PYTHON" -c 'import json,sys
try:
    print(json.load(sys.stdin).get("generatedAt",""))
except Exception:
    print("")' 2>/dev/null || true)
        if [ "$gen" = "$target" ]; then
            SNAPSHOT="$target"
            log "site no ar com o snapshot $target"
            return 0
        fi
        sleep 10
    done
    log "timeout à espera do site ($target)"
    return 1
}

cmd_run() {
    local force=0 rc
    [ "${1:-}" = "--force" ] && force=1
    rotate_log

    if [ "$force" = 0 ] && fresh_enough; then
        log "guarda de frescura: última run OK há menos de ${FRESH_HOURS}h — saltando"
        exit 0
    fi

    trap cleanup EXIT
    trap 'log "interrompida por sinal"; cleanup; exit 130' TERM INT

    if ! acquire_lock; then
        exit 0
    fi

    START_EPOCH=$(date +%s)
    state_set "status=running" "stage=preflight" "started_at=$(iso)" "started_epoch=$START_EPOCH" \
        "ended_at=" "ended_epoch=" "exit_code=" "mail=" "log=$LOG" "site_url=$SITE_URL"
    log "=== rotina diária iniciada (pid $$, force=$force) ==="

    preflight || { FAIL_STAGE="preflight"; finish_fail 1; }

    TOTAL_BEFORE=$(db_count)
    OPENROUTER_REMAINING=$(openrouter_remaining)
    log "OpenRouter restante antes: US$ $OPENROUTER_REMAINING"
    case "$OPENROUTER_REMAINING" in
        ''|unknown|error) log "AVISO: saldo OpenRouter desconhecido" ;;
        *)
            if awk "BEGIN{exit !($OPENROUTER_REMAINING < $MIN_OPENROUTER_USD)}"; then
                log "AVISO: saldo OpenRouter abaixo de US$ $MIN_OPENROUTER_USD"
            fi
            ;;
    esac

    run_crawl; rc=$?
    if [ "$rc" -ne 0 ]; then FAIL_STAGE="crawl"; finish_fail "$rc"; fi

    run_finish; rc=$?
    if [ "$rc" -ne 0 ]; then FAIL_STAGE="finish"; finish_fail "$rc"; fi

    TOTAL_AFTER=$(db_count)
    NEW_ARTICLES=$((TOTAL_AFTER - TOTAL_BEFORE))
    if [ "$NEW_ARTICLES" -lt 0 ]; then NEW_ARTICLES=0; fi
    TOTAL_ARTICLES="$TOTAL_AFTER"
    log "novos artigos: $NEW_ARTICLES (total $TOTAL_ARTICLES)"

    OPENROUTER_REMAINING=$(openrouter_remaining)
    log "OpenRouter restante depois: US$ $OPENROUTER_REMAINING"

    run_deploy; rc=$?
    if [ "$rc" -ne 0 ]; then FAIL_STAGE="deploy"; finish_fail "$rc"; fi

    SNAPSHOT=$("$PYTHON" -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8")).get("generatedAt",""))' "$PROJECT/webapp/public/data/meta.json" 2>/dev/null)
    log "snapshot local: ${SNAPSHOT:-?}"

    dispatch_pages || { FAIL_STAGE="pages-dispatch"; finish_fail 1; }
    poll_pages || { FAIL_STAGE="pages-poll"; finish_fail 1; }

    finish_ok
}

cmd_status() {
    echo "== rotina diária newsletter-crawler =="
    echo "site: $SITE_URL"
    local gen
    gen=$(curl -fsS --max-time 20 "$SITE_META" 2>/dev/null | "$PYTHON" -c 'import json,sys
try:
    print(json.load(sys.stdin).get("generatedAt",""))
except Exception:
    print("")' 2>/dev/null || true)
    echo "snapshot no ar: ${gen:-indisponível}"
    echo "OpenRouter restante: US$ $(openrouter_remaining)"
    echo
    echo "-- última execução (last-run.json) --"
    if [ -f "$STATE/last-run.json" ]; then cat "$STATE/last-run.json"; else echo "nunca rodou"; fi
    echo
    echo "-- lock --"
    if [ -d "$LOCK" ]; then echo "ATIVO: pid $(cat "$LOCK/pid" 2>/dev/null)"; else echo "livre"; fi
    echo
    echo "-- launchd --"
    sudo -n launchctl print "system/com.nc.daily-crawl" 2>/dev/null | grep -E 'state =|last exit code|runs =' | head -5 || echo "job não instalado"
    echo
    echo "-- log (últimas 25 linhas) --"
    tail -25 "$LOG" 2>/dev/null || true
}

cmd_preflight() {
    if preflight; then
        echo "preflight OK"
    else
        echo "preflight FALHOU — ver $LOG"
        exit 1
    fi
}

cmd_send_test() {
    local body="$STATE/test-email.txt" mail="not-configured"
    {
        echo "Teste da rotina diária — newsletter-crawler"
        echo "Data: $(date '+%F %T %Z')"
        echo "Site: $SITE_URL"
        echo "Este é um teste do canal de alerta."
    } >"$body"
    chmod 600 "$body" 2>/dev/null || true
    if grep -qE '^NC_SMTP_URL=' "$NC_HOME/.env" 2>/dev/null; then
        if "$PYTHON" "$PROJECT/scripts/notify-email.py" --subject "newsletter-crawler — teste de e-mail" --body-file "$body"; then
            mail="sent"
        else
            mail="error"
        fi
    else
        echo "NC_SMTP_URL ausente em $NC_HOME/.env — e-mail não configurado."
    fi
    local_alert "newsletter-crawler" "Teste de alerta local"
    echo "alerta local disparado; e-mail: $mail"
}

usage() {
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
    echo
    echo "Uso: $0 {run [--force]|status|preflight|send-test}"
}

case "${1:-}" in
    run) shift; cmd_run "$@" ;;
    status) cmd_status ;;
    preflight) cmd_preflight ;;
    send-test) cmd_send_test ;;
    -h|--help|help|"") usage; exit 0 ;;
    *) usage; exit 2 ;;
esac
