#!/usr/bin/env python3
"""
backfill_shots.py
Re-parses shot/club data from an existing raw_garmin_dump.json and writes
it into rounds.json, without making any API calls.

Usage:
    python backfill_shots.py
    python backfill_shots.py --raw raw_garmin_dump.json --rounds rounds.json
"""

import argparse
import json
from datetime import datetime
from pathlib import Path

RAW_FILE = Path(__file__).parent.parent / "data" / "raw_garmin_dump.json"
ROUNDS_FILE = Path(__file__).parent.parent / "data" / "rounds.json"


def safe_get(d, *keys, default=None):
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k, default)
        if d is None:
            return default
    return d


def parse_shot(shot_data, club_map=None):
    club_id = shot_data.get("clubId")
    club_info = (club_map or {}).get(club_id, {}) if club_id else {}
    meters = shot_data.get("meters")
    return {
        "shot_number": shot_data.get("shotOrder"),
        "club_id": club_id,
        "club_type_id": club_info.get("clubTypeId"),
        "club_name": club_info.get("name"),
        "club_model": club_info.get("model"),
        "distance_yards": round(meters * 1.09361, 1) if meters is not None else None,
        "lie": safe_get(shot_data, "startLoc", "lie"),
        "shot_type": shot_data.get("shotType"),
        "lat": safe_get(shot_data, "startLoc", "lat"),
        "lon": safe_get(shot_data, "startLoc", "lon"),
    }


def build_global_club_map(raw_dump):
    """Build a single club map from clubDetails across all rounds in the dump."""
    club_map = {}
    for entry in raw_dump:
        for hole_response in (entry.get("shot_data_raw") or []):
            if not isinstance(hole_response, dict):
                continue
            for cd in (hole_response.get("clubDetails") or []):
                club_map[cd["id"]] = cd
    return club_map


def parse_shots_from_raw(shot_data_raw, club_map):
    """Turn a list of per-hole raw API responses into a flat list of parsed shots."""
    shots = []
    for hole_response in (shot_data_raw or []):
        if not isinstance(hole_response, dict):
            continue
        for hole_entry in (hole_response.get("holeShots") or []):
            h_num = hole_entry.get("holeNumber")
            for shot in (hole_entry.get("shots") or []):
                parsed = parse_shot(shot, club_map)
                parsed["hole"] = h_num
                shots.append(parsed)
    return shots


def main():
    parser = argparse.ArgumentParser(description="Backfill shots from raw dump into rounds.json")
    parser.add_argument("--raw", type=Path, default=RAW_FILE)
    parser.add_argument("--rounds", type=Path, default=ROUNDS_FILE)
    args = parser.parse_args()

    if not args.raw.exists():
        print(f"Raw dump not found: {args.raw}")
        return
    if not args.rounds.exists():
        print(f"Rounds file not found: {args.rounds}")
        return

    with open(args.raw) as f:
        raw_dump = json.load(f)

    with open(args.rounds) as f:
        rounds_data = json.load(f)

    rounds_by_id = {r["activity_id"]: r for r in rounds_data["rounds"]}

    # Build club map once from all rounds so older rounds resolve clubs added later
    club_map = build_global_club_map(raw_dump)
    print(f"Club map: {len(club_map)} clubs across all rounds")

    updated = 0
    skipped_no_match = 0
    skipped_no_shots = 0

    for entry in raw_dump:
        activity_id = str(entry.get("activity_id", ""))
        shot_data_raw = entry.get("shot_data_raw")

        if not shot_data_raw:
            skipped_no_shots += 1
            continue

        if activity_id not in rounds_by_id:
            skipped_no_match += 1
            continue

        shots = parse_shots_from_raw(shot_data_raw, club_map)
        rounds_by_id[activity_id]["shots"] = shots
        updated += 1
        print(f"  {activity_id}  {rounds_by_id[activity_id]['date']}  {rounds_by_id[activity_id]['course']:20s}  → {len(shots)} shots")

    rounds_data["last_updated"] = datetime.now().isoformat()
    with open(args.rounds, "w") as f:
        json.dump(rounds_data, f, indent=2, default=str)

    print(f"\nDone. Updated {updated} round(s), {skipped_no_shots} raw entries had no shot data, {skipped_no_match} had no matching round.")


if __name__ == "__main__":
    main()
