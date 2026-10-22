#!/usr/bin/env bash
# Golden audio fixtures for the codec tests (WP-11; FO-10-02). SYNTHETIC tones only (no speech, no person).
# Generated with the system ffmpeg (6.1, libsoxr, libopus); the committed outputs are what the tests read, so this
# script only documents how they were made. Re-run from this directory: bash generate.sh
set -euo pipefail
FF="ffmpeg -hide_banner -loglevel error -y"
# 0.5 s, three partials inside the telephone band (300-3400 Hz), mono s16 48 kHz.
$FF -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.5" \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=0.5" \
    -f lavfi -i "sine=frequency=2200:sample_rate=48000:duration=0.5" \
    -filter_complex "[0][1][2]amix=inputs=3:normalize=0,volume=0.6" -ac 1 -ar 48000 -c:a pcm_s16le tone-48k.wav
for r in 8000 16000 24000; do
  $FF -i tone-48k.wav -af "aresample=resampler=soxr:precision=28" -ar "$r" -c:a pcm_s16le "tone-$((r / 1000))k.wav"
done
# G.711 encodings of the 8 kHz reference by ffmpeg's encoders (raw bytes, no container).
$FF -i tone-8k.wav -f mulaw -c:a pcm_mulaw tone-8k.ulaw
$FF -i tone-8k.wav -f alaw -c:a pcm_alaw tone-8k.alaw
# Opus at 48 kHz in Ogg (as WebRTC carries it), 64 kbit/s.
$FF -i tone-48k.wav -c:a libopus -b:a 64k -application voip tone-48k.opus
sha256sum tone-* > SHA256SUMS
