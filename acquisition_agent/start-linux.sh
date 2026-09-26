#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: ./start-linux.sh SESSION_CODE ACQUISITION_TOKEN [CSI_PORT] [EMG_PORT] [GSR_PORT] [ECG_PORT]"
  exit 2
fi

agent_root="$(cd "$(dirname "$0")" && pwd)"
# The local server unless MERIDIAN_URL says otherwise; the agent's own default is the hosted site.
"$agent_root/.venv/bin/python" -m meridian_agent --server "${MERIDIAN_URL:-http://localhost:3000}" --output "$agent_root/recordings" --code "$1" --token "$2" --camera auto --face-width 1920 --face-height 1080 --face-fps 25 --face-exposure-on-body --face2-width 1280 --face2-height 720 --face2-fps 30 --face2-input-format mjpg --face2-gain 48 --power-line-hz 50 --min-free-gb 150 --audio auto --oximeter auto --csi "${3:-auto}" --emg "${4:-auto}" --gsr "${5:-auto}" --ecg "${6:-none}"
