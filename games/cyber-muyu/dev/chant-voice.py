"""Chant voice for the wooden fish: 南无阿弥陀佛, one syllable per strike.

Needs the local Qwen3-TTS Gradio demo (~/qwen3-tts/serve.sh, CustomVoice model) and a
Python with gradio_client, numpy and soundfile (the demo's own venv has all three).

  python dev/chant-voice.py takes [count]   # candidates + slow-strike previews in /tmp/chant-takes
  python dev/chant-voice.py pick <n>        # writes assets/chant.wav and the slices in assets/chant.json

The whole phrase is generated in one utterance, so the six syllables share a voice and
intonation; the punctuation forces short pauses that make the syllables easy to cut.
The text is the homophone 拿摩 (ná mó): the model reads 南无 as nán wú. The game still
shows 南无. Syllables keep their natural length; only the tail is capped and faded.
The endpoint has no seed: the committed WAV, not this script, is the reproducible artifact.
"""
import json, os, shutil, sys
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
TAKES = Path(os.environ.get("CHANT_TAKES", "/tmp/chant-takes"))
SERVER = os.environ.get("QWEN_TTS_URL", "http://127.0.0.1:8010/")
TEXT = "拿，摩，阿，弥，陀，佛。"
SPEAKER = "Uncle Fu"
INSTRUCT = ("一位五六十岁的汉传佛教老僧人在大殿里念佛号。中低音，浑厚沉稳，带胸腔和鼻腔共鸣。"
            "用寺庙念经的腔调：六个字都在同一个低沉的音高上平直地念，不按普通话声调上扬或起伏，像诵经一样单调、平稳、虔诚。"
            "吐字清晰、字正腔圆，每个字短而饱满、自然收住，不拖长音，一字一顿。全句读作 ná mó ā mí tuó fó。不要唱成歌，不要朗读腔。")
SYLLABLES = 6
PRE_ROLL, POST_ROLL, MAX_LENGTH = 0.03, 0.04, 0.6  # seconds
FADE_IN, FADE_OUT, GAP = 0.004, 0.08, 0.05


def segments(samples, rate):
    """Voiced runs separated by at least 60 ms of quiet, as (start, end) seconds."""
    hop = rate // 100
    rms = np.array([np.sqrt(np.mean(samples[i:i + hop] ** 2)) for i in range(0, len(samples) - hop, hop)])
    db = 20 * np.log10(rms + 1e-9)
    voiced = db > db.max() - 35
    runs, start, quiet, end = [], None, 0, 0
    for i, v in enumerate(voiced):
        if v:
            start = i if start is None else start
            quiet, end = 0, i + 1
        elif start is not None:
            quiet += 1
            if quiet >= 6:
                runs.append((start / 100, end / 100))
                start = None
    if start is not None:
        runs.append((start / 100, end / 100))
    return [run for run in runs if run[1] - run[0] >= 0.08]  # drop clicks and breaths


def cut(samples, rate, start, end):
    a = max(0, int((start - PRE_ROLL) * rate))
    b = min(len(samples), int((end + POST_ROLL) * rate), a + int(MAX_LENGTH * rate))
    piece = samples[a:b].copy()
    fade_in, fade_out = int(FADE_IN * rate), int(FADE_OUT * rate)
    piece[:fade_in] *= np.linspace(0, 1, fade_in)
    piece[-fade_out:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade_out))
    return piece


def pack(samples, rate, runs):
    """Syllables back to back with short silences; returns the mono track and [start, duration] slices."""
    gap = np.zeros(int(GAP * rate))
    track, slices, position = [gap], [], len(gap)
    for start, end in runs:
        piece = cut(samples, rate, start, end)
        slices.append([round(position / rate, 4), round(len(piece) / rate, 4)])
        track += [piece, gap]
        position += len(piece) + len(gap)
    track = np.concatenate(track)
    return track * (0.9 / np.abs(track).max()), slices


def takes(count):
    from gradio_client import Client
    client = Client(SERVER, verbose=False)
    TAKES.mkdir(parents=True, exist_ok=True)
    kept = 0
    for attempt in range(count * 4):
        if kept == count:
            break
        path, _ = client.predict(TEXT, "中文", SPEAKER, INSTRUCT, api_name="/run_instruct")
        samples, rate = sf.read(path)
        runs = segments(samples, rate)
        if len(runs) != SYLLABLES:
            print(f"attempt {attempt}: {len(runs)} syllables, skipped")
            continue
        kept += 1
        shutil.copy(path, TAKES / f"take-{kept}.wav")
        (TAKES / f"take-{kept}.json").write_text(json.dumps(runs))
        # Slow strikes: every syllable as the game will play it, 0.6 s apart.
        track, slices = pack(samples, rate, runs)
        rest = np.zeros(int(0.6 * rate))
        preview = np.concatenate([np.concatenate([track[int(s * rate):int((s + d) * rate)], rest]) for s, d in slices])
        sf.write(TAKES / f"take-{kept}-preview.wav", preview, rate, subtype="PCM_16")
        print(f"take {kept}: {[f'{b - a:.2f}s' for a, b in runs]}")
    print(f"{kept} takes in {TAKES}; listen to take-N-preview.wav, then run: pick N")


def pick(number):
    samples, rate = sf.read(TAKES / f"take-{number}.wav")
    runs = json.loads((TAKES / f"take-{number}.json").read_text())
    track, slices = pack(samples, rate, runs)
    sf.write(ROOT / "assets/chant.wav", track, rate, subtype="PCM_16")
    manifest = ROOT / "assets/chant.json"
    data = json.loads(manifest.read_text()) if manifest.exists() else {}
    data["text"] = "南无阿弥陀佛"
    data["slices"] = slices
    manifest.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"assets/chant.wav: {len(track) / rate:.2f}s at {rate} Hz; slices {slices}")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "takes":
        takes(int(sys.argv[2]) if len(sys.argv) > 2 else 4)
    elif command == "pick" and len(sys.argv) > 2:
        pick(int(sys.argv[2]))
    else:
        sys.exit(__doc__)
