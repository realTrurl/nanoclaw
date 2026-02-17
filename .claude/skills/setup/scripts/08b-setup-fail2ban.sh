#!/bin/bash
set -euo pipefail

# 08b-setup-fail2ban.sh — Install and configure fail2ban for SSH protection (Linux only)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-fail2ban] $*" >> "$LOG_FILE"; }

# Only run on Linux
case "$(uname -s)" in
  Linux*) ;;
  *)
    cat <<EOF
=== NANOCLAW SETUP: SETUP_FAIL2BAN ===
STATUS: skipped
REASON: not_linux
=== END ===
EOF
    exit 0
    ;;
esac

log "Installing fail2ban"
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban >> "$LOG_FILE" 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y fail2ban >> "$LOG_FILE" 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y fail2ban >> "$LOG_FILE" 2>&1
  else
    log "No supported package manager found"
    cat <<EOF
=== NANOCLAW SETUP: SETUP_FAIL2BAN ===
STATUS: failed
ERROR: no_package_manager
LOG: logs/setup.log
=== END ===
EOF
    exit 1
  fi
fi

log "Configuring fail2ban for SSH"
cat > /etc/fail2ban/jail.local <<JAILEOF
[sshd]
enabled = true
port = ssh
backend = systemd
maxretry = 3
findtime = 600
bantime = 3600
JAILEOF

log "Enabling and starting fail2ban"
systemctl enable fail2ban >> "$LOG_FILE" 2>&1 || true
systemctl restart fail2ban >> "$LOG_FILE" 2>&1 || true

# Verify
FAIL2BAN_ACTIVE="false"
if systemctl is-active fail2ban >/dev/null 2>&1; then
  FAIL2BAN_ACTIVE="true"
  log "fail2ban verified as active"
else
  log "fail2ban not active"
fi

SSHD_JAIL="false"
if fail2ban-client status sshd >/dev/null 2>&1; then
  SSHD_JAIL="true"
  log "sshd jail verified as active"
fi

cat <<EOF
=== NANOCLAW SETUP: SETUP_FAIL2BAN ===
FAIL2BAN_ACTIVE: $FAIL2BAN_ACTIVE
SSHD_JAIL: $SSHD_JAIL
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
