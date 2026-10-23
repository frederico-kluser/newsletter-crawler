#!/bin/bash
# =============================================================================
# coletar-e-publicar.sh — O COMANDO ÚNICO
# =============================================================================
#   npm run atualizar        (ou: bash scripts/coletar-e-publicar.sh)
#
# Faz tudo, por esta ordem, e SÓ TERMINA quando o deploy está concluído
# (site a servir o novo snapshot) — ou com exit ≠ 0 se algo falhar:
#
#   1. COLETAR   — `crawl --since 2026-01-01` em TODAS as newsletters cadastradas.
#                  Incremental: dedup por URL + cursores por fonte ⇒ traz apenas as
#                  notícias NOVAS (nunca reprocessa nem sobrescreve o acervo).
#   2. BASE      — `finish` drena os pendentes de qualidade (verify/classify/summarize);
#                  fica tudo pronto no SQLite antes de publicar.
#   3. DEPLOY    — `deploy` exporta o snapshot com guard anti-encolhimento, publica via
#                  PR + squash merge e faz polling até o SITE estar no ar com os dados
#                  novos (sai daqui só com `live`, ou `timeout`/erro com exit ≠ 0).
#
# Logs: ~/.newsletter-crawler/logs/coletar-e-publicar.log (com rotação por tamanho).
# Lock: uma execução de cada vez (mkdir atómico + PID); run anterior morto é assumido
#       de imediato. Cada run do crawler é retomável (resetInProgress no seguinte).
# =============================================================================
set -uo pipefail

export HOME=/Users/minim1
export USER=minim1
export LOGNAME=minim1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8
umask 077

PROJECT=/Volumes/Ext2TB/Projects/newsletter-crawler
NODE="$HOME/.local/bin/node"
STATE="$HOME/.local/state/newsletter-crawler"
NC_LOGS="$HOME/.newsletter-crawler/logs"
LOG="$NC_LOGS/coletar-e-publicar.log"
LOCK="$STATE/coletar-e-publicar.lock"
SINCE="${NC_SINCE:-2026-01-01}"                 # janela: desde 2026-01-01 até hoje
DEPLOY_TIMEOUT="${NC_DEPLOY_TIMEOUT:-900}"      # teto do polling do deploy (s)
LOG_ROTATE_BYTES="${NC_LOG_ROTATE_BYTES:-5242880}"

mkdir -p "$STATE" "$NC_LOGS" 2>/dev/null && chmod 700 "$STATE" 2>/dev/null
touch "$LOG" 2>/dev/null && chmod 600 "$LOG" 2>/dev/null

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG" 2>&1; }

rotate_log() {
    local sz
    sz=$(wc -c <"$LOG" 2>/dev/null || echo 0)
    if [ "${sz:-0}" -gt "$LOG_ROTATE_BYTES" ]; then mv -f "$LOG" "$LOG.1" 2>/dev/null; fi
}

# ---- instância única (mkdir atómico + PID; dono morto ⇒ assumir) -------------
if ! mkdir "$LOCK" 2>/dev/null; then
    old=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        echo "já existe uma execução em curso (pid $old) — nada a fazer." >&2
        exit 1
    fi
    rm -rf "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { echo "não consegui criar o lock" >&2; exit 1; }
fi
printf '%s\n' "$$" >"$LOCK/pid"
cleanup() { rm -rf "$LOCK" 2>/dev/null; }
trap cleanup EXIT
trap 'log "interrompido (sinal)"; exit 130' TERM INT

rotate_log
cd "$PROJECT" || { echo "projeto inacessível: $PROJECT" >&2; exit 1; }

etapa() {
    echo ""
    echo "── $1 ──────────────────────────────────────────"
    log "── $1 ──"
}

etapa "1/3 COLETAR — notícias novas de todas as newsletters (desde $SINCE)"
log "crawl --since $SINCE (todas as fontes)"
"$NODE" --env-file-if-exists=.env src/index.js crawl --since "$SINCE" 2>&1 | tee -a "$LOG"
crawl_exit=${PIPESTATUS[0]}
if [ "$crawl_exit" != "0" ]; then
    echo "FALHA na coleta (exit $crawl_exit) — nada foi publicado." >&2
    log "FALHA crawl exit=$crawl_exit"
    exit "$crawl_exit"
fi

etapa "2/3 BASE — drenar pendentes de qualidade (verify/classify/summarize)"
log "finish"
"$NODE" --env-file-if-exists=.env src/index.js finish 2>&1 | tee -a "$LOG"
finish_exit=${PIPESTATUS[0]}
if [ "$finish_exit" != "0" ]; then
    echo "FALHA ao atualizar a base (exit $finish_exit) — nada foi publicado." >&2
    log "FALHA finish exit=$finish_exit"
    exit "$finish_exit"
fi

etapa "3/3 DEPLOY — publicar e esperar que o site fique NO AR"
log "deploy --timeout $DEPLOY_TIMEOUT"
"$NODE" --env-file-if-exists=.env src/index.js deploy --timeout "$DEPLOY_TIMEOUT" 2>&1 | tee -a "$LOG"
deploy_exit=${PIPESTATUS[0]}
log "deploy exit=$deploy_exit"

echo ""
if [ "$deploy_exit" = "0" ]; then
    echo "✔ CONCLUÍDO — notícias coletadas, base atualizada e site NO AR (deploy terminado)."
    log "concluído: coletado + base atualizada + deploy live"
else
    echo "✖ O deploy NÃO terminou como esperado (exit $deploy_exit) — ver log: $LOG" >&2
    log "terminou com erro deploy_exit=$deploy_exit"
fi
exit "$deploy_exit"
