"""Copy a finished session and a consistent snapshot of the session database to an archive drive, then verify it.

    .venv/bin/python tools/backup_session.py recordings/session_<CODE>_<time> /media/ai/Elements/meridian

The session database is the only copy of the session record the export depends on, and on 22 September recording
folders were deleted from the only disk they lived on. Run this after "Analysis bundle written" and before freeing
any space. Files are verified against the SHA-256 values in manifest.json; --quick checks sizes only. A tasks/ folder cut
afterwards with --extract-tasks is copied like any other file but is not in the manifest, so it is not verified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB_DIR = REPO / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def snapshot_databases(db_dir: Path, target: Path) -> list[str]:
    """sqlite's online backup: consistent even while the dev server is writing, unlike copying the files."""
    target.mkdir(parents=True, exist_ok=True)
    copied = []
    for source in sorted(db_dir.glob("*.sqlite")):
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(target / source.name) as dst:
            src.backup(dst)
        copied.append(source.name)
    return copied


def verify(session: Path, copy: Path, quick: bool) -> list[str]:
    manifest = json.loads((session / "manifest.json").read_text(encoding="utf-8"))
    problems = []
    for item in manifest.get("recordings", []) + manifest.get("auxiliaryFiles", []):
        relative = item.get("relativePath") or item.get("path")
        if not relative:
            continue
        target = copy / relative
        if not target.is_file():
            problems.append(f"missing: {relative}")
        elif item.get("bytes") is not None and target.stat().st_size != int(item["bytes"]):
            problems.append(f"size differs: {relative}")
        elif not quick and item.get("sha256") and len(str(item["sha256"])) == 64 and sha256(target) != item["sha256"]:
            problems.append(f"checksum differs: {relative}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("session", type=Path, help="finished session folder (must contain manifest.json)")
    parser.add_argument("archive", type=Path, help="archive root on the backup drive")
    parser.add_argument("--db-dir", type=Path, default=DEFAULT_DB_DIR, help="folder holding the session database .sqlite files")
    parser.add_argument("--quick", action="store_true", help="verify sizes only, not SHA-256 (much faster)")
    parser.add_argument("--verify-only", type=Path, metavar="COPY",
                        help="check an existing copy (a mounted cloud folder, or a restored download) against manifest.json and copy nothing")
    args = parser.parse_args()

    session = args.session.resolve()
    if not (session / "manifest.json").is_file():
        print(f"{session} has no manifest.json: wait for 'Analysis bundle written' before backing it up", file=sys.stderr)
        return 2
    if args.verify_only:
        if not args.verify_only.is_dir():
            print(f"{args.verify_only} is not a folder. Is the drive mounted, or the download finished?", file=sys.stderr)
            return 2
        problems = verify(session, args.verify_only, args.quick)
        if problems:
            print(f"{args.verify_only} does not match {session / 'manifest.json'}:\n  " + "\n  ".join(problems), file=sys.stderr)
            return 1
        print(f"{args.verify_only} matches the manifest ({'sizes' if args.quick else 'sha256'}).")
        return 0
    if not args.archive.is_dir():
        print(f"Archive folder {args.archive} does not exist. Is the backup drive mounted?", file=sys.stderr)
        return 2
    needed = sum(path.stat().st_size for path in session.rglob("*") if path.is_file())
    free = shutil.disk_usage(args.archive).free
    if free < needed * 1.02:
        print(f"Not enough space on the archive: {needed / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free", file=sys.stderr)
        return 2

    copy = args.archive / session.name
    started = time.time()
    print(f"Copying {needed / 1e9:.1f} GB to {copy} ...", flush=True)
    subprocess.run(["rsync", "-a", "--partial", f"{session}/", f"{copy}/"], check=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    databases = snapshot_databases(args.db_dir, args.archive / f"database_{stamp}")
    print(f"Database snapshot: {', '.join(databases) or 'none found'}", flush=True)
    print("Verifying against manifest.json ...", flush=True)
    problems = verify(session, copy, args.quick)
    report = {"session": session.name, "copiedTo": str(copy), "bytes": needed, "databaseSnapshot": f"database_{stamp}",
              "databases": databases, "verified": "sizes" if args.quick else "sha256", "problems": problems,
              "seconds": round(time.time() - started)}
    (copy / "backup_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if problems:
        print("BACKUP NOT VERIFIED; do not delete the original:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    print(f"Backup verified ({report['verified']}) in {report['seconds']} s. The original may now be removed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
