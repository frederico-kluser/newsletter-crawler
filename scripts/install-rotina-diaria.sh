#!/bin/bash
# =============================================================================
# install-rotina-diaria.sh — instala/remove a rotina diária no launchd do Mac
# =============================================================================
# O job com.nc.daily-crawl corre às 05:00 (hora local) como minim1. Como um job
# de launchd direto NÃO lê /Volumes/Ext2TB (TCC de volume removível), o job abre
# uma sessão SSH local com a chave ~/.ssh/nc-daily_ed25519; o authorized_keys
# dessa chave tem forced command + restrict + from=127.0.0.1,::1. A sessão SSH
# herda a Full Disk Access do sshd-keygen-wrapper.
#
# Uso:
#   scripts/install-rotina-diaria.sh install     # instala (precisa de sudo -n)
#   scripts/install-rotina-diaria.sh check       # verifica sem disparar a rotina
#   scripts/install-rotina-diaria.sh status      # mostra a última execução
#   scripts/install-rotina-diaria.sh uninstall   # remove job + linha do SSH
# =============================================================================
set -euo pipefail

PROJECT=/Volumes/Ext2TB/Projects/newsletter-crawler
HOME_DIR=/Users/minim1
KEY="$HOME_DIR/.ssh/nc-daily_ed25519"
AUTH="$HOME_DIR/.ssh/authorized_keys"
PLIST=/Library/LaunchDaemons/com.nc.daily-crawl.plist
LABEL=com.nc.daily-crawl
LOG_DIR="$HOME_DIR/.newsletter-crawler/logs"
LAUNCH_LOG="$LOG_DIR/launchd-nc-daily.log"
ROTINA="$PROJECT/scripts/rotina-diaria.sh"

usage() {
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    echo
    echo "Uso: $0 {install|check|status|uninstall}"
}

require_sudo() {
    sudo -n true 2>/dev/null || {
        echo "Erro: preciso de sudo sem password (NOPASSWD) para gerir o LaunchDaemon." >&2
        exit 1
    }
}

ensure_key() {
    [ -d "$HOME_DIR/.ssh" ] || { mkdir -p "$HOME_DIR/.ssh"; chmod 700 "$HOME_DIR/.ssh"; }
    if [ ! -f "$KEY" ]; then
        ssh-keygen -q -t ed25519 -N '' -C 'nc-daily' -f "$KEY"
        echo "chave criada: $KEY" >&2
    fi
    chmod 600 "$KEY"
    chmod 644 "$KEY.pub"
    cat "$KEY.pub"
}

install_auth() {
    local pub="$1" line b64
    b64=$(printf '%s' "$pub" | cut -d' ' -f2)
    line="command=\"$ROTINA run\",restrict,from=\"127.0.0.1,::1\" $pub"
    [ -f "$AUTH" ] || { : >"$AUTH"; chmod 600 "$AUTH"; }
    if grep -qF "$b64" "$AUTH" 2>/dev/null; then
        echo "authorized_keys: chave nc-daily já autorizada"
    else
        cp -p "$AUTH" "$AUTH.bak-nc-daily-$(date +%s)"
        printf '%s\n' "$line" >>"$AUTH"
        chmod 600 "$AUTH"
        echo "authorized_keys: entrada nc-daily adicionada (backup criado)"
    fi
}

write_plist() {
    cat <<EOF | sudo tee "$PLIST" >/dev/null
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>UserName</key>
    <string>minim1</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-F</string>
        <string>/dev/null</string>
        <string>-i</string>
        <string>$KEY</string>
        <string>-o</string>
        <string>IdentitiesOnly=yes</string>
        <string>-o</string>
        <string>BatchMode=yes</string>
        <string>-o</string>
        <string>PreferredAuthentications=publickey</string>
        <string>-o</string>
        <string>StrictHostKeyChecking=accept-new</string>
        <string>-o</string>
        <string>ServerAliveInterval=30</string>
        <string>-o</string>
        <string>ServerAliveCountMax=10</string>
        <string>-o</string>
        <string>ConnectTimeout=15</string>
        <string>-T</string>
        <string>minim1@127.0.0.1</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>5</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>WorkingDirectory</key>
    <string>/Users/minim1</string>

    <key>StandardOutPath</key>
    <string>$LAUNCH_LOG</string>

    <key>StandardErrorPath</key>
    <string>$LAUNCH_LOG</string>
</dict>
</plist>
EOF
    sudo chown root:wheel "$PLIST"
    sudo chmod 644 "$PLIST"
    plutil -lint "$PLIST" >/dev/null
}

do_install() {
    require_sudo
    [ -x "$ROTINA" ] || { echo "Erro: $ROTINA não está executável." >&2; exit 1; }
    mkdir -p "$LOG_DIR"
    chmod 700 "$LOG_DIR" 2>/dev/null || true
    touch "$LAUNCH_LOG"
    chmod 600 "$LAUNCH_LOG" 2>/dev/null || true
    local pub
    pub=$(ensure_key)
    install_auth "$pub"
    write_plist
    sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
    sudo launchctl bootstrap system "$PLIST"
    sudo launchctl enable "system/$LABEL" 2>/dev/null || true
    echo "instalado: $LABEL (05:00 local, RunAtLoad)"
    echo "log do launchd: $LAUNCH_LOG"
    echo "status: $ROTINA status"
    echo
    echo "NOTA: RunAtLoad pode disparar agora; se a última run estiver fresca (<${NC_FRESH_HOURS:-12}h),"
    echo "      o wrapper salta pela guarda de frescura (não coleta de novo)."
}

do_check() {
    local ok=1
    if [ -f "$KEY" ]; then echo "✓ chave: $KEY"; else echo "✗ chave ausente"; ok=0; fi
    if [ -f "$KEY.pub" ] && grep -qF "$(cut -d' ' -f2 "$KEY.pub")" "$AUTH" 2>/dev/null; then
        echo "✓ authorized_keys com a chave nc-daily"
    else
        echo "✗ authorized_keys sem a chave nc-daily"
        ok=0
    fi
    if [ -f "$PLIST" ]; then
        if plutil -lint "$PLIST" >/dev/null 2>&1; then echo "✓ plist válido"; else echo "✗ plist inválido"; ok=0; fi
        echo "-- agendamento --"
        plutil -p "$PLIST" | grep -A4 'StartCalendarInterval' || true
    else
        echo "✗ plist ausente"
        ok=0
    fi
    if sudo -n launchctl print "system/$LABEL" >/dev/null 2>&1; then
        echo "✓ job carregado no launchd"
        sudo -n launchctl print "system/$LABEL" 2>/dev/null | grep -E 'state =|last exit code|runs =' | head -5 || true
    else
        echo "✗ job não carregado"
        ok=0
    fi
    echo
    echo "-- última execução --"
    "$ROTINA" status 2>/dev/null | head -35 || true
    echo
    if [ "$ok" = 1 ]; then echo "TUDO CONFORME"; else echo "HÁ PENDÊNCIAS"; fi
    [ "$ok" = 1 ]
}

do_uninstall() {
    require_sudo
    sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
    sudo rm -f "$PLIST"
    if [ -f "$AUTH" ]; then
        cp -p "$AUTH" "$AUTH.bak-nc-daily-$(date +%s)"
        grep -v 'nc-daily' "$AUTH" >"$AUTH.tmp" 2>/dev/null || true
        mv "$AUTH.tmp" "$AUTH"
        chmod 600 "$AUTH"
        echo "authorized_keys: linha nc-daily removida"
    fi
    echo "desinstalado: $LABEL (chave, logs e estado preservados)"
}

case "${1:-}" in
    install|--install) do_install ;;
    check|--check) do_check ;;
    status|--status) "$ROTINA" status ;;
    uninstall|--uninstall) do_uninstall ;;
    -h|--help|help|"") usage; exit 0 ;;
    *) usage; exit 2 ;;
esac
