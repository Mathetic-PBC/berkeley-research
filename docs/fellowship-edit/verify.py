#!/usr/bin/env python3
"""Check actual exported media, not just edit settings; save a QA report."""
import hashlib
import argparse
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="Local Fellowship editing package")
parser.add_argument("--variant", choices=["desktop", "mobile"], default="desktop")
ARGS = parser.parse_args()
ROOT = ARGS.root.resolve()
WIDTH, HEIGHT = (720, 1280) if ARGS.variant == "mobile" else (1920, 1080)
NAME = "fellowship-montage-mobile" if ARGS.variant == "mobile" else "fellowship-montage"


def check(path):
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ]))
    streams = data["streams"]
    assert len(streams) == 1 and streams[0]["codec_type"] == "video", "Unexpected audio/data track"
    assert (streams[0]["width"], streams[0]["height"]) == (WIDTH, HEIGHT)
    assert streams[0]["r_frame_rate"] == "30/1"
    assert abs(float(data["format"]["duration"]) - 18) < 0.04
    subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"], check=True)

    # Decode all 540 frames at small spatial resolution. Inspect actual chroma and
    # luma to catch tint or a stray black slate/fade between selected source cuts.
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-vf", "scale=64:36:flags=area,format=yuv444p",
        "-f", "rawvideo", "-"
    ])
    plane = 64 * 36
    frame_bytes = plane * 3
    assert len(raw) == 540 * frame_bytes, "Wrong decoded frame count"
    min_luma = 255
    max_chroma_error = 0
    for offset in range(0, len(raw), frame_bytes):
        y = raw[offset:offset + plane]
        uv = raw[offset + plane:offset + frame_bytes]
        min_luma = min(min_luma, sum(y) / plane)
        max_chroma_error = max(max_chroma_error, max(abs(c - 128) for c in uv))
    assert max_chroma_error <= 1, f"Visible color remains: {max_chroma_error}"
    assert min_luma > 25, f"Possible black frame or slate: mean luma {min_luma}"

    return {"file": path.name, "duration_seconds": 18, "decoded_frames": 540,
            "width": WIDTH, "height": HEIGHT, "fps": 30, "audio_tracks": 0,
            "size_bytes": path.stat().st_size, "maximum_chroma_error": max_chroma_error,
            "minimum_frame_mean_luma": round(min_luma, 2), "full_decode": "passed"}


def main():
    outputs = [check(ROOT / name) for name in (
        NAME + ".mp4", NAME + ".webm", NAME + "-master.mov"
    )]
    mp4 = (ROOT / (NAME + ".mp4")).read_bytes()
    assert 0 < mp4.index(b"moov") < mp4.index(b"mdat"), "MP4 is not faststart"
    spec = json.loads((ROOT / "edit" / ("sequence-mobile.json" if ARGS.variant == "mobile" else "sequence.json")).read_text())
    sources = {}
    for name in sorted({s["file"] for s in spec["shots"]}):
        with (ROOT / "sources" / name).open("rb") as stream:
            sources[name] = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {"outputs": outputs, "mp4_faststart": True, "source_sha256": sources}
    (ROOT / "review" / ("verification-mobile.json" if ARGS.variant == "mobile" else "verification.json")).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
