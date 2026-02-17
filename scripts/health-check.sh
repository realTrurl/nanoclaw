#!/bin/bash
# NanoClaw health check - restarts the service if it's not running properly
# Intended to run via cron every hour

LOG_TAG="nanoclaw-health"

# Check 1: Is the systemd service active?
if ! systemctl is-active --quiet nanoclaw; then
  logger -t "$LOG_TAG" "Service not active, restarting..."
  systemctl restart nanoclaw
  sleep 10
  if systemctl is-active --quiet nanoclaw; then
    logger -t "$LOG_TAG" "Service restarted successfully"
  else
    logger -t "$LOG_TAG" "ERROR: Service failed to restart"
  fi
  exit 0
fi

# Check 2: Is the node process actually running?
if ! pgrep -f "node.*nanoclaw.*dist/index.js" > /dev/null; then
  logger -t "$LOG_TAG" "Node process not found, restarting service..."
  systemctl restart nanoclaw
  sleep 10
  if pgrep -f "node.*nanoclaw.*dist/index.js" > /dev/null; then
    logger -t "$LOG_TAG" "Service restarted successfully"
  else
    logger -t "$LOG_TAG" "ERROR: Service failed to restart"
  fi
  exit 0
fi

# Check 3: Is at least one container running?
if ! docker ps --filter "name=nanoclaw-" --format "{{.Names}}" | grep -q .; then
  logger -t "$LOG_TAG" "No containers running, restarting service..."
  systemctl restart nanoclaw
  sleep 10
  logger -t "$LOG_TAG" "Service restarted (no containers were running)"
  exit 0
fi

logger -t "$LOG_TAG" "OK - service active, process running, container(s) up"
