#!/usr/bin/env python3
"""
One-shot migration: split rounds.json into three flat files.

  data/rounds.json  — round-level fields only (no holes/shots)
  data/holes.json   — all holes, with activity_id foreign key
  data/shots.json   — all shots, with activity_id foreign key
"""

import json
from pathlib import Path
from datetime import datetime

DATA_DIR = Path(__file__).parent.parent / "data"
ROUNDS_FILE = DATA_DIR / "rounds.json"
HOLES_FILE = DATA_DIR / "holes.json"
SHOTS_FILE = DATA_DIR / "shots.json"


def main():
    with open(ROUNDS_FILE) as f:
        data = json.load(f)

    all_holes = []
    all_shots = []

    for r in data["rounds"]:
        activity_id = r["activity_id"]
        for h in r.pop("holes", []):
            all_holes.append({"activity_id": activity_id, **h})
        for s in r.pop("shots", []):
            all_shots.append({"activity_id": activity_id, **s})

    with open(ROUNDS_FILE, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"rounds.json : {len(data['rounds'])} rounds")

    with open(HOLES_FILE, "w") as f:
        json.dump({"holes": all_holes}, f, indent=2, default=str)
    print(f"holes.json  : {len(all_holes)} holes")

    with open(SHOTS_FILE, "w") as f:
        json.dump({"shots": all_shots}, f, indent=2, default=str)
    print(f"shots.json  : {len(all_shots)} shots")


if __name__ == "__main__":
    main()
