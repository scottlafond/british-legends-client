from __future__ import annotations

import os
from pathlib import Path

from PyInstaller.__main__ import run as pyinstaller_run


ROOT = Path(__file__).resolve().parent
APP_NAME = "BritishLegends"
ENTRYPOINT = ROOT / "web_server.py"

STATIC_FILES = [
    "index.html",
    "index.js",
    "index.css",
    "manifest.webmanifest",
    "curated_map_layout.json",
    "strategy.json",
    "world_map_static.json",
]

STATIC_PATTERNS = [
    "*.gif",
    "*.jpg",
    "*.png",
]


def data_arg(path: Path, destination: str = ".") -> str:
    return f"{path}{os.pathsep}{destination}"


def collect_static_files() -> list[Path]:
    files: list[Path] = []
    seen: set[Path] = set()

    for relative_path in STATIC_FILES:
        path = ROOT / relative_path
        if path.exists() and path not in seen:
            files.append(path)
            seen.add(path)

    for pattern in STATIC_PATTERNS:
        for path in sorted(ROOT.glob(pattern)):
            if path.is_file() and path not in seen:
                files.append(path)
                seen.add(path)

    return files


def main() -> None:
    args = [
        "--clean",
        "--noconfirm",
        "--noconsole",
        "--onefile",
        "--name",
        APP_NAME,
        "--hidden-import",
        "webview",
    ]

    for path in collect_static_files():
        args.extend(["--add-data", data_arg(path)])

    args.append(str(ENTRYPOINT))
    pyinstaller_run(args)


if __name__ == "__main__":
    main()
