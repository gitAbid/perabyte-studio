#!/usr/bin/env python3
"""Pre-render the fixed example assets so the landing page and the seeded
History load instantly instead of waiting ~40s per provider call.

Run once:  python3 scripts/prerender_examples.py
"""
from __future__ import annotations

import concurrent.futures as futures
import pathlib
import time
import sys
import urllib.parse
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "demo"

# name, prompt, width, height, seed
TARGETS = [
    ("mountain-lake", "A serene mountain landscape with a lake, sunrise, and pine trees, photorealistic, natural lighting, sharp focus, high detail", 1280, 800, 4821),
    ("fantasy-forest", "A glowing fantasy forest with floating lights and ancient mossy trees, digital painting, painterly brushwork, rich colour grading", 640, 640, 3390),
    ("city-night", "A neon city street at night in the rain, reflections on the road, cinematic lighting, film grain, dramatic composition, depth of field", 640, 640, 7712),
    ("ocean-sunset", "A calm ocean sunset with soft clouds and a distant sailboat, photorealistic, natural lighting, sharp focus, high detail", 896, 1120, 9014),
    ("robot-city", "A friendly robot walking through a futuristic city plaza at dusk, cinematic lighting, film grain, dramatic composition", 720, 1280, 2265),
    ("winter-village", "A cosy winter village covered in snow beneath a purple evening sky, watercolour on textured paper, soft bleeding edges, muted washes", 1280, 720, 6120),
]


def url_for(prompt: str, w: int, h: int, seed: int) -> str:
    params = urllib.parse.urlencode(
        {
            "width": w,
            "height": h,
            "seed": seed,
            "model": "flux",
            "nologo": "true",
            "enhance": "true",
        }
    )
    return f"https://image.pollinations.ai/prompt/{urllib.parse.quote(prompt)}?{params}"


def fetch(target) -> tuple[str, str]:
    name, prompt, w, h, seed = target
    dest = OUT / f"{name}.jpg"
    if dest.exists() and dest.stat().st_size > 5000:
        return name, "cached"

    last = ""
    for attempt in range(1, 6):
        try:
            req = urllib.request.Request(
                url_for(prompt, w, h, seed),
                headers={"User-Agent": "PeraByteStudio/0.1 (+prerender)"},
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            if len(data) < 5000:
                last = f"too small ({len(data)}B)"
                time.sleep(5)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return name, f"ok {len(data) // 1024}KB"
        except Exception as exc:  # noqa: BLE001
            last = f"attempt {attempt}: {exc}"
            # The free tier rate-limits aggressively; back off before retrying.
            time.sleep(10 * attempt)
    return name, f"FAILED {last}"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failures = 0
    # One worker only: the provider returns 429 as soon as we parallelise.
    with futures.ThreadPoolExecutor(max_workers=1) as pool:
        for name, status in pool.map(fetch, TARGETS):
            print(f"{name:16} {status}", flush=True)
            if status.startswith("FAILED"):
                failures += 1
            time.sleep(3)
    print("done", "with failures" if failures else "cleanly")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
