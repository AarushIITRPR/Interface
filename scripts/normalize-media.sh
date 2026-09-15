#!/usr/bin/env bash
# Re-encode protocol stimuli to one presentation format and one loudness so that picture size, frame rate, and volume
# do not vary with the emotion being elicited. Clip content and duration are unchanged.
#
#   video: H.264 High, 1280x720 (aspect preserved, black letterbox/pillarbox), 30 fps constant, CRF 18, faststart
#   audio: AAC 48 kHz stereo 192 kb/s, two-pass EBU R128 loudness normalization to -23 LUFS, true peak -2 dBTP
#
# Usage: scripts/normalize-media.sh SOURCE_DIR OUTPUT_DIR
set -euo pipefail

source_dir=${1:?source directory}
output_dir=${2:?output directory}
mkdir -p "$output_dir"

target_i=-23
target_tp=-2
target_lra=11

for input in "$source_dir"/*.mp4; do
  name=$(basename "$input")
  output="$output_dir/$name"

  # Pass 1: measure loudness.
  measured=$(ffmpeg -hide_banner -nostats -i "$input" -vn \
    -af "loudnorm=I=$target_i:TP=$target_tp:LRA=$target_lra:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
  value() { printf '%s' "$measured" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
  loudnorm="loudnorm=I=$target_i:TP=$target_tp:LRA=$target_lra:measured_I=$(value input_i):measured_TP=$(value input_tp):measured_LRA=$(value input_lra):measured_thresh=$(value input_thresh):offset=$(value target_offset):linear=true,aresample=48000"

  # Pass 2: encode.
  if ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "$input" | grep -q video; then
    ffmpeg -hide_banner -v error -y -i "$input" -map 0:v:0 -map 0:a:0 \
      -vf "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30" \
      -c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -crf 18 \
      -af "$loudnorm" -c:a aac -b:a 192k -ac 2 \
      -movflags +faststart "$output"
  else
    ffmpeg -hide_banner -v error -y -i "$input" -map 0:a:0 \
      -af "$loudnorm" -c:a aac -b:a 192k -ac 2 \
      -movflags +faststart "$output"
  fi
  echo "normalized $name (source $(value input_i) LUFS)"
done
