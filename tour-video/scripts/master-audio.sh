#!/usr/bin/env bash
# Finishing pass for the rendered film: a two-pass EBU R128 loudnorm on the
# mixed audio (VO + music bed + SFX) to web-standard loudness with a safe
# true-peak ceiling, re-muxed in place (video stream copied, not re-encoded).
# Run after `npm run render`. Relative balance is set in the Remotion mix
# (src/videos/tour.audio.ts) — this only sets the absolute master level.
set -euo pipefail
cd "$(dirname "$0")/.."

IN="${1:-out/tour.mp4}"
TMP="out/.tour.master.tmp.mp4"
I=-14; TP=-1.5; LRA=11

echo "Pass 1 — measuring $IN ..."
JSON=$(ffmpeg -i "$IN" -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:print_format=json" -f null /dev/null 2>&1 | sed -n '/{/,/}/p')

read -r MI MTP MLRA MTHRESH OFFSET <<EOF
$(printf '%s' "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['input_i'], d['input_tp'], d['input_lra'], d['input_thresh'], d['target_offset'])")
EOF

echo "  measured: I=$MI TP=$MTP LRA=$MLRA thresh=$MTHRESH offset=$OFFSET"
echo "Pass 2 — normalising to ${I} LUFS / ${TP} dBTP ..."
ffmpeg -y -i "$IN" \
  -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:measured_I=$MI:measured_TP=$MTP:measured_LRA=$MLRA:measured_thresh=$MTHRESH:offset=$OFFSET:linear=true" \
  -c:v copy -c:a aac -b:a 256k -ar 48000 "$TMP"
mv -f "$TMP" "$IN"

echo "Done. Verifying:"
ffmpeg -i "$IN" -af loudnorm=print_format=summary -f null /dev/null 2>&1 | grep -E "Input (Integrated|True Peak|LRA)"
