"""Record what each local session holds, and where a copy of it went, before anything is deleted.

    .venv/bin/python tools/archive_ledger.py                                  # refresh recordings/ARCHIVE.tsv
    .venv/bin/python tools/archive_ledger.py --note session_0047AYVT_x gdrive:meridian/... verified

Two things have already gone wrong and this is the memory of both: session 0101JUMR lost its database row and can
never be exported again, and recording folders were deleted from the only disk they lived on. The ledger says, for
every session folder, whether it is self-describing (manifest, export, task folders) and whether its database row
still exists, so a session is only ever deleted once a copy is verified.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

AGENT = Path(__file__).resolve().parents[1]
REPO = AGENT.parent
DEFAULT_DB_DIR = REPO / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
COLUMNS = ["folder", "code", "bytes", "files", "manifest", "export", "tasks", "dbRow", "destination", "checkedAt", "status"]


def database_codes(db_dir: Path) -> dict[str, str]:
    """Session code -> status, from whichever D1 file holds a sessions table."""
    codes: dict[str, str] = {}
    for path in sorted(db_dir.glob("*.sqlite")):
        try:
            with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as con:
                codes.update({code: status for code, status in con.execute("select code, status from sessions")})
        except sqlite3.Error:
            continue
    return codes


def scan(recordings: Path, codes: dict[str, str]) -> list[dict]:
    rows = []
    for folder in sorted(recordings.glob("session_*")):
        if not folder.is_dir():
            continue
        files = [path for path in folder.rglob("*") if path.is_file()]
        code = folder.name.split("_")[1]
        rows.append({"folder": folder.name, "code": code, "bytes": sum(path.stat().st_size for path in files),
                     "files": len(files), "manifest": (folder / "manifest.json").is_file(),
                     "export": (folder / "export" / "qa_report.md").is_file(), "tasks": (folder / "tasks").is_dir(),
                     "dbRow": codes.get(code, "missing")})
    return rows


def read_ledger(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    lines = path.read_text(encoding="utf-8").splitlines()
    header = lines[0].split("\t") if lines else []
    return {row["folder"]: row for row in (dict(zip(header, line.split("\t"))) for line in lines[1:]) if row.get("folder")}


def write_ledger(path: Path, rows: list[dict]) -> None:
    body = ["\t".join(COLUMNS)]
    for row in rows:
        body.append("\t".join(str(row.get(column, "")) for column in COLUMNS))
    path.write_text("\n".join(body) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--recordings", type=Path, default=AGENT / "recordings")
    parser.add_argument("--db-dir", type=Path, default=DEFAULT_DB_DIR)
    parser.add_argument("--note", nargs=3, metavar=("FOLDER", "DESTINATION", "STATUS"),
                        help="record where a session was copied and how it was checked, e.g. gdrive:meridian/... verified")
    args = parser.parse_args()

    ledger_path = args.recordings / "ARCHIVE.tsv"
    previous = read_ledger(ledger_path)
    rows = scan(args.recordings, database_codes(args.db_dir))
    known = {row["folder"] for row in rows}
    for row in rows:  # keep the destination a previous run recorded; the scan cannot know it
        old = previous.get(row["folder"], {})
        row["destination"] = old.get("destination", "")
        row["checkedAt"] = old.get("checkedAt", "")
        row["status"] = old.get("status", "on disk only")
    # Sessions no longer on disk stay in the ledger: that is the whole point of writing it down.
    for folder, old in previous.items():
        if folder not in known:
            old["status"] = old.get("status", "") or "gone from disk"
            rows.append(old)

    if args.note:
        folder, destination, status = args.note
        match = next((row for row in rows if row["folder"] == folder), None)
        if not match:
            # A folder already deleted from disk can still be recorded, which is how a session that left before the
            # ledger existed gets written down at all.
            match = {"folder": folder, "code": folder.split("_")[1] if "_" in folder else "", "bytes": "", "files": "",
                     "manifest": "", "export": "", "tasks": "", "dbRow": ""}
            rows.append(match)
        match.update(destination=destination, status=status, checkedAt=time.strftime("%Y-%m-%dT%H:%M:%S"))

    rows.sort(key=lambda row: str(row.get("folder")))
    write_ledger(ledger_path, rows)
    print(f"{ledger_path}: {len(rows)} sessions")
    for row in rows:
        flags = [name for name in ("manifest", "export", "tasks") if str(row.get(name)) not in ("True", "true")]
        warn = f"  MISSING {', '.join(flags)}" if flags else ""
        if str(row.get("dbRow")) == "missing":
            warn += "  NO DATABASE ROW (cannot be re-exported)"
        print(f"  {row['folder']:<42} {int(row.get('bytes') or 0) / 1e9:8.1f} GB  {row.get('status','')}{warn}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
