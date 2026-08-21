#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: ./start-linux.sh SESSION_CODE ACQUISITION_TOKEN [CSI_PORT] [EMG_PORT] [GSR_PORT] [ECG_PORT]"
  exit 2
fi

agent_root="$(cd "$(dirname "$0")" && pwd)"
"$agent_root/.venv/bin/python" -m meridian_agent --code "$1" --token "$2" --camera auto --audio auto --oximeter auto --csi "${3:-auto}" --emg "${4:-auto}" --gsr "${5:-auto}" --ecg "${6:-none}"
