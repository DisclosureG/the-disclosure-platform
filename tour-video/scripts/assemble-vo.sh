#!/usr/bin/env bash
# Assemble the per-line ElevenLabs takes (public/voiceover/lines/*.mp3) into a
# single narration track (public/voiceover/tour.mp3) with calm gaps between
# beats, and print each scene's total duration in seconds so the video config
# can stay perfectly in sync. Picks the NEWEST take per scene prefix, so it is
# safe to re-run after regenerating any individual line.
set -euo pipefail

cd "$(dirname "$0")/.."
LINES="public/voiceover/lines"
OUT="public/voiceover/tour.mp3"
WORK="$(mktemp -d)"

GAP=0.5        # silence after each beat
LEAD=0.4       # silence before the very first word
OUTRO_TAIL=2.0 # extra hold so the closing brand card breathes

# scene id  ->  filename prefix produced by the TTS step
ids=(open method taxonomy tiers lifecycle voting wallet canon-not-proof peers capture refusals map cta outro)
globs=("tts_Some_" "tts_It_wo_" "tts_The_a_" "tts_Not_a_" "tts_Every_" "tts_Here'" "tts_But_w" "tts_Being_" "tts_And_n_" "tts_Proje_" "tts_No_li_" "tts_A_mon_" "tts_So,_c_" "tts_Kept_")

# Lead-in silence
ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t "$LEAD" -q:a 9 "$WORK/lead.mp3" >/dev/null 2>&1
echo "file '$WORK/lead.mp3'" > "$WORK/list.txt"

echo "SCENE_DURATIONS_BEGIN"
n=${#ids[@]}
for i in "${!ids[@]}"; do
  id="${ids[$i]}"
  glob="${globs[$i]}"
  # newest matching take
  src=$(ls -t "$LINES/$glob"*.mp3 2>/dev/null | head -1)
  if [[ -z "${src:-}" ]]; then echo "MISSING $id ($glob)"; exit 1; fi
  raw=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$src")
  pad="$GAP"
  if [[ "$id" == "outro" ]]; then pad=$(echo "$GAP + $OUTRO_TAIL" | bc); fi
  ffmpeg -y -i "$src" -af "apad=pad_dur=$pad" -ac 1 -ar 44100 -q:a 4 "$WORK/p_$i.mp3" >/dev/null 2>&1
  echo "file '$WORK/p_$i.mp3'" >> "$WORK/list.txt"
  # scene duration = raw + trailing pad (+ lead-in on first scene)
  dur=$(echo "$raw + $pad" | bc)
  if [[ "$i" == "0" ]]; then dur=$(echo "$dur + $LEAD" | bc); fi
  printf '%s %.3f\n' "$id" "$dur"
done
echo "SCENE_DURATIONS_END"

ffmpeg -y -f concat -safe 0 -i "$WORK/list.txt" -c:a libmp3lame -q:a 2 "$OUT" >/dev/null 2>&1
total=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")
printf 'TOTAL %.3f\n' "$total"
rm -rf "$WORK"
