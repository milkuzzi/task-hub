#!/usr/bin/env bash
set -euo pipefail
# Perimeter firewall: expose only SSH + HTTP(S). DB/Redis stay on internal net.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
