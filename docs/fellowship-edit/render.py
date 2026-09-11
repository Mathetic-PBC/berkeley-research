#!/usr/bin/env python3
"""Rebuild the silent archival montage. Requires Python 3 and FFmpeg.

Run: python3 edit/render.py
All paths resolve relative to this script, not the working directory.
"""
import argparse
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="Local Fellowship editing package")
parser.add_argument("--spec", type=Path, default=Path(__file__).with_name("sequence.json"), help="Shot manifest")
ARGS = parser.parse_args()
ROOT = ARGS.root.resolve()
EDIT = ROOT / "edit"
SPEC = json.loads(ARGS.spec.read_text())
NAME = SPEC.get("output_name", "fellowship-montage")
POSTER = SPEC.get("poster_name", "fellowship-poster.jpg")
VARIANT = SPEC.get("variant", "desktop")
W, H, FPS = SPEC["width"], SPEC["height"], SPEC["fps"]


def run(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def main():
    clips = EDIT / ("rendered-" + VARIANT)
    clips.mkdir(exist_ok=True)
    for i, shot in enumerate(SPEC["shots"]):
        source = ROOT / "sources" / shot["file"]
        if not source.is_file():
            raise FileNotFoundError(f"Missing source: {source}. See SOURCES.md.")
        frames = round(shot["duration"] * FPS)
        if abs(frames / FPS - shot["duration"]) > 1e-8:
            raise ValueError("Every cut must fall on a frame boundary.")
        filters = []
        if shot.get("deinterlace"):
            filters.append("bwdif=mode=send_frame:parity=auto:deint=all")
        filters += [
            "crop=" + ":".join(map(str, shot["crop"])),
            *(["hqdn3d=" + shot["denoise"]] if shot.get("denoise") else []),
            *([f"unsharp=3:3:{shot['sharpen']}:3:3:0"] if shot.get("sharpen") else []),
            f"scale={W}:{H}:flags=lanczos",
            "setsar=1",
            "tpad=stop_mode=clone:stop_duration=0.1",
            f"fps={FPS}",
            "setpts=PTS-STARTPTS",
            f"eq=contrast={shot['contrast']}:gamma={shot['gamma']}:saturation=0",
            "format=yuv420p",
            "lutyuv=u=128:v=128",
        ]
        print(f"Rendering {i + 1}/{len(SPEC['shots'])}: {shot['name']}", flush=True)
        run("-ss", shot["start"], "-i", source, "-map", "0:v:0", "-an",
            "-vf", ",".join(filters), "-frames:v", frames,
            "-c:v", "libx264", "-preset", "slow", "-crf", "12",
            "-video_track_timescale", "30000", clips / f"{i:02}.mp4")

    concat = clips / "concat.txt"
    concat.write_text("".join(f"file '{i:02}.mp4'\n" for i in range(len(SPEC["shots"]))))
    joined = EDIT / ("assembled-" + VARIANT + ".mp4")
    run("-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", "-an", joined)

    run("-i", joined, "-an", "-vf", "lutyuv=u=128:v=128", "-c:v", "libx264", "-preset", "slow", "-crf", "19",
        "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-metadata", "title=" + SPEC["title"],
        ROOT / (NAME + ".mp4"))
    run("-i", joined, "-an", "-vf", "lutyuv=u=128:v=128", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "27",
        "-row-mt", "1", "-deadline", "good", "-cpu-used", "3",
        ROOT / (NAME + ".webm"))
    run("-i", joined, "-an", "-c:v", "prores_ks", "-profile:v", "2",
        "-pix_fmt", "yuv422p10le", ROOT / (NAME + "-master.mov"))
    run("-ss", "0.5", "-i", ROOT / (NAME + ".mp4"), "-frames:v", "1",
        "-q:v", "2", ROOT / POSTER)
    print("Finished: 18-second MP4, WebM, editing master, and poster.", flush=True)


if __name__ == "__main__":
    main()
