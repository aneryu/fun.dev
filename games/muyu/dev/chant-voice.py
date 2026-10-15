"""Chant voice for the wooden fish: 南无阿弥陀佛, one syllable per strike.

The input is a 清念 (plain) recitation of 南无阿弥陀佛.

The recording repeats one phrase every 4.36 s. 南无 and 阿弥 are each sung as one breath, so the
syllables are split by hand where the vowel changes (the spectral centroid of the voice drops
from about 400–480 Hz to about 230 Hz); 陀 starts just before its vowel (the breath before it
would make it sound a beat late) and 佛 near the end of its f.

Each syllable keeps its natural timbre and gets a light chorus: a copy delayed about 15 ms
with a slowly drifting delay, as if two voices chanted together. The echo and the hall that
give the chant its space are added live in sound.js, so their tails outlast a cut syllable.
Set CHORUS to 0 for the plain voice.

  uv run --with numpy --with soundfile python dev/chant-voice.py <recording.mp3>

Keep the recording outside the repository.
"""
import json, sys
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
# (start, end) seconds of 南 无 阿 弥 陀 佛 in the second phrase of the source.
SYLLABLES = [(4.41, 4.755), (4.755, 5.34), (5.54, 5.835), (5.835, 6.37), (6.60, 6.85), (6.91, 7.33)]
FADE_IN, FADE_OUT, GAP = 0.008, 0.04, 0.05
CHORUS, CHORUS_DELAY, CHORUS_DEPTH, CHORUS_RATE = 0.3, 0.015, 0.003, 0.8  # mix, s, s, Hz


def chorus(piece, rate):
    """Mixes in a copy read through a slowly wobbling delay line."""
    n = np.arange(len(piece))
    delay = (CHORUS_DELAY + CHORUS_DEPTH * np.sin(2 * np.pi * CHORUS_RATE * n / rate)) * rate
    copy = np.interp(n - delay, n, piece, left=0)
    return piece * (1 - CHORUS * 0.5) + copy * CHORUS

def main(source):
    data, rate = sf.read(source, always_2d=True)
    samples = data.mean(axis=1)
    gap = np.zeros(int(GAP * rate))
    track, slices, position = [gap], [], len(gap)
    for start, end in SYLLABLES:
        piece = chorus(samples[int(start * rate):int(end * rate)].copy(), rate)
        fade_in, fade_out = int(FADE_IN * rate), int(FADE_OUT * rate)
        piece[:fade_in] *= np.linspace(0, 1, fade_in)
        piece[-fade_out:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade_out))
        slices.append([round(position / rate, 4), round(len(piece) / rate, 4)])
        track += [piece, gap]
        position += len(piece) + len(gap)
    track = np.concatenate(track)
    track *= 0.9 / np.abs(track).max()
    sf.write(ROOT / "assets/chant.wav", track, rate, subtype="PCM_16")
    manifest = {"text": "南无阿弥陀佛", "slices": slices}
    (ROOT / "assets/chant.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"assets/chant.wav: {len(track) / rate:.2f}s at {rate} Hz; slices {slices}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
