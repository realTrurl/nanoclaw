#!/bin/bash
set -euo pipefail

# 08-setup-service.sh — Generate and load service manager config

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-service] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
PLATFORM=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Auto-detect platform
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac
fi

NODE_PATH=$(which node)
PROJECT_PATH="$PROJECT_ROOT"
HOME_PATH="$HOME"

log "Setting up service: platform=$PLATFORM node=$NODE_PATH project=$PROJECT_PATH"

# Build first
log "Building TypeScript"
if ! npm run build >> "$LOG_FILE" 2>&1; then
  log "Build failed"
  cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: unknown
NODE_PATH: $NODE_PATH
PROJECT_PATH: $PROJECT_PATH
STATUS: failed
ERROR: build_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Create logs directory
mkdir -p "$PROJECT_PATH/logs"

case "$PLATFORM" in

  macos)
    PLIST_PATH="$HOME_PATH/Library/LaunchAgents/com.nanoclaw.plist"
    log "Generating launchd plist at $PLIST_PATH"

    mkdir -p "$HOME_PATH/Library/LaunchAgents"

    cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
PLISTEOF

    log "Loading launchd service"
    if launchctl load "$PLIST_PATH" >> "$LOG_FILE" 2>&1; then
      log "launchctl load succeeded"
    else
      log "launchctl load failed (may already be loaded)"
    fi

    # Verify
    SERVICE_LOADED="false"
    if launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
      SERVICE_LOADED="true"
      log "Service verified as loaded"
    else
      log "Service not found in launchctl list"
    fi

    cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: launchd
NODE_PATH: $NODE_PATH
PROJECT_PATH: $PROJECT_PATH
PLIST_PATH: $PLIST_PATH
SERVICE_LOADED: $SERVICE_LOADED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
    ;;

  linux)
    UNIT_PATH="/etc/systemd/system/nanoclaw.service"
    log "Generating system-level systemd unit at $UNIT_PATH"

    cat > "$UNIT_PATH" <<UNITEOF
[Unit]
Description=NanoClaw - Personal Claude Assistant
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${PROJECT_PATH}
ExecStart=${NODE_PATH} ${PROJECT_PATH}/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=${PROJECT_PATH}/.env

[Install]
WantedBy=multi-user.target
UNITEOF

    # Clean up old user-level service if it exists
    if systemctl --user is-enabled nanoclaw >/dev/null 2>&1; then
      log "Removing old user-level service"
      systemctl --user stop nanoclaw >> "$LOG_FILE" 2>&1 || true
      systemctl --user disable nanoclaw >> "$LOG_FILE" 2>&1 || true
      rm -f "$HOME_PATH/.config/systemd/user/nanoclaw.service"
      systemctl --user daemon-reload >> "$LOG_FILE" 2>&1 || true
    fi

    log "Enabling and starting systemd service (system-level)"
    systemctl daemon-reload >> "$LOG_FILE" 2>&1 || true
    systemctl enable nanoclaw >> "$LOG_FILE" 2>&1 || true
    systemctl start nanoclaw >> "$LOG_FILE" 2>&1 || true

    # Install hourly health check cron job
    HEALTH_SCRIPT="${PROJECT_PATH}/scripts/health-check.sh"
    HEALTH_CRON="0 * * * * ${HEALTH_SCRIPT}"
    HEALTH_INSTALLED="false"
    if [ -f "$HEALTH_SCRIPT" ]; then
      chmod +x "$HEALTH_SCRIPT"
      # Add cron entry if not already present
      if ! crontab -l 2>/dev/null | grep -qF "$HEALTH_SCRIPT"; then
        (crontab -l 2>/dev/null; echo "$HEALTH_CRON") | crontab -
        log "Health check cron job installed"
      else
        log "Health check cron job already installed"
      fi
      HEALTH_INSTALLED="true"
    else
      log "Health check script not found at $HEALTH_SCRIPT, skipping cron setup"
    fi

    # Verify
    SERVICE_LOADED="false"
    if systemctl is-active nanoclaw >/dev/null 2>&1; then
      SERVICE_LOADED="true"
      log "Service verified as active"
    else
      log "Service not active"
    fi

    cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: systemd
NODE_PATH: $NODE_PATH
PROJECT_PATH: $PROJECT_PATH
UNIT_PATH: $UNIT_PATH
SERVICE_LOADED: $SERVICE_LOADED
HEALTH_CHECK: $HEALTH_INSTALLED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
    ;;

  *)
    log "Unsupported platform: $PLATFORM"
    cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: unknown
NODE_PATH: $NODE_PATH
PROJECT_PATH: $PROJECT_PATH
STATUS: failed
ERROR: unsupported_platform
LOG: logs/setup.log
=== END ===
EOF
    exit 1
    ;;
esac
