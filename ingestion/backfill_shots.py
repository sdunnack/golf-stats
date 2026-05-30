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

BASE_DIR = Path(__file__).parent.parent / "data"
RAW_FILE = BASE_DIR / "raw_garmin_dump.json"
ROUNDS_FILE = BASE_DIR / "rounds.json"
HOLES_FILE = BASE_DIR / "holes.json"
SHOTS_FILE = BASE_DIR / "shots.json"
COURSES_FILE = BASE_DIR / "courses.json"
CLUBS_FILE = BASE_DIR / "clubs.json"


def _load_all_data(rounds_file, holes_file, shots_file):
    with open(rounds_file) as f:
        data = json.load(f)
    holes_by_id = {}
    if holes_file.exists():
        with open(holes_file) as f:
            for h in json.load(f).get("holes", []):
                aid = h.pop("activity_id", None)
                if aid:
                    holes_by_id.setdefault(aid, []).append(h)
    shots_by_id = {}
    if shots_file.exists():
        with open(shots_file) as f:
            for s in json.load(f).get("shots", []):
                aid = s.pop("activity_id", None)
                if aid:
                    shots_by_id.setdefault(aid, []).append(s)
    for r in data["rounds"]:
        aid = r["activity_id"]
        r["holes"] = holes_by_id.get(aid, [])
        r["shots"] = shots_by_id.get(aid, [])
    return data


def _save_all_data(data, rounds_file, holes_file, shots_file):
    all_holes, all_shots = [], []
    for r in data["rounds"]:
        aid = r["activity_id"]
        for h in r.pop("holes", []):
            all_holes.append({"activity_id": aid, **h})
        for s in r.pop("shots", []):
            all_shots.append({"activity_id": aid, **s})
    with open(rounds_file, "w") as f:
        json.dump(data, f, indent=2, default=str)
    with open(holes_file, "w") as f:
        json.dump({"holes": all_holes}, f, indent=2, default=str)
    with open(shots_file, "w") as f:
        json.dump({"shots": all_shots}, f, indent=2, default=str)


def safe_get(d, *keys, default=None):
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k, default)
        if d is None:
            return default
    return d


def load_course_lookup():
    """
    Returns {"by_id": {garmin_course_id: (canonical_name, hole_map)},
             "by_name": {name_or_alias_lower: (canonical_name, hole_map)}}
    Lookup priority: by_id (unambiguous) then by_name/alias (fallback).
    """
    if not COURSES_FILE.exists():
        return {"by_id": {}, "by_name": {}}
    with open(COURSES_FILE) as f:
        data = json.load(f)
    by_id, by_name = {}, {}
    for course in data.get("courses", []):
        name = course.get("name")
        if not name:
            continue
        hole_map = {}
        for h in course.get("holes", []):
            num = h.get("hole")
            if num is not None:
                hole_map[num] = {"par": h.get("par"), "yardage": h.get("yardage")}
        entry = (name, hole_map)
        gid = course.get("garmin_course_id")
        if gid is not None:
            by_id[int(gid)] = entry
        by_name[name.lower()] = entry
        for alias in course.get("aliases") or []:
            by_name[alias.lower()] = entry
    return {"by_id": by_id, "by_name": by_name}


def find_course(course_id, garmin_name, lookup):
    """Returns (canonical_name, hole_map) or (None, {}). Tries by_id first."""
    if course_id is not None:
        result = lookup["by_id"].get(int(course_id))
        if result:
            return result
    if garmin_name:
        result = lookup["by_name"].get(garmin_name.lower())
        if result:
            return result
    return (None, {})


def load_club_type_names():
    """Return {club_type_id (int): type_name_str} from clubs.json."""
    if not CLUBS_FILE.exists():
        return {}
    with open(CLUBS_FILE) as f:
        data = json.load(f)
    return {int(k): v for k, v in data.get("club_type_names", {}).items()}


def _parse_nine_stats(stats):
    if not stats or not isinstance(stats, dict):
        return None
    holes_played = stats.get("holesPlayed", 0)
    if not holes_played:
        return None
    return {
        "holes_played": holes_played,
        "strokes": stats.get("strokes"),
        "putts": stats.get("putts"),
        "gir": stats.get("greensInRegulation"),
        "birdies": stats.get("holesBirdie"),
        "pars": stats.get("holesPar"),
        "bogeys": stats.get("holesBogey"),
        "doubles_plus": stats.get("holesOverBogey"),
        "eagles": stats.get("holesEagle"),
    }


def parse_shot(shot_data, club_map=None, club_type_names=None):
    club_id = shot_data.get("clubId")
    club_info = (club_map or {}).get(club_id, {}) if club_id else {}
    meters = shot_data.get("meters")
    club_type_id = club_info.get("clubTypeId")
    return {
        "shot_number": shot_data.get("shotOrder"),
        "club_id": club_id,
        "club_type_id": club_type_id,
        "club_type_name": (
            (club_type_names or {}).get(club_type_id)
            if club_type_id is not None
            else None
        ),
        "club_name": club_info.get("name"),
        "club_model": club_info.get("model"),
        "distance_yards": round(meters * 1.09361, 1) if meters is not None else None,
        "lie": safe_get(shot_data, "startLoc", "lie"),
        "shot_type": shot_data.get("shotType"),
        "lat": safe_get(shot_data, "startLoc", "lat"),
        "lon": safe_get(shot_data, "startLoc", "lon"),
        "end_lat": safe_get(shot_data, "endLoc", "lat"),
        "end_lon": safe_get(shot_data, "endLoc", "lon"),
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


def parse_shots_from_raw(shot_data_raw, club_map, club_type_names=None):
    """Turn a list of per-hole raw API responses into a flat list of parsed shots."""
    shots = []
    for hole_response in (shot_data_raw or []):
        if not isinstance(hole_response, dict):
            continue
        for hole_entry in (hole_response.get("holeShots") or []):
            h_num = hole_entry.get("holeNumber")
            for shot in (hole_entry.get("shots") or []):
                parsed = parse_shot(shot, club_map, club_type_names)
                parsed["hole"] = h_num
                shots.append(parsed)
    return shots


def main():
    parser = argparse.ArgumentParser(description="Backfill shots from raw dump into rounds.json")
    parser.add_argument("--raw", type=Path, default=RAW_FILE)
    parser.add_argument("--rounds", type=Path, default=ROUNDS_FILE)
    parser.add_argument("--holes", type=Path, default=HOLES_FILE)
    parser.add_argument("--shots", type=Path, default=SHOTS_FILE)
    args = parser.parse_args()

    if not args.raw.exists():
        print(f"Raw dump not found: {args.raw}")
        return
    if not args.rounds.exists():
        print(f"Rounds file not found: {args.rounds}")
        return

    with open(args.raw) as f:
        raw_dump = json.load(f)

    rounds_data = _load_all_data(args.rounds, args.holes, args.shots)
    rounds_by_id = {r["activity_id"]: r for r in rounds_data["rounds"]}

    # Build club map once from all rounds so older rounds resolve clubs added later
    club_map = build_global_club_map(raw_dump)
    club_type_names = load_club_type_names()
    course_lookup = load_course_lookup()
    print(f"Club map: {len(club_map)} clubs across all rounds")

    updated = 0
    skipped_no_match = 0
    skipped_no_shots = 0

    for entry in raw_dump:
        activity_id = str(entry.get("activity_id", ""))
        shot_data_raw = entry.get("shot_data_raw")
        sc_detail = entry.get("scorecard_detail") or {}
        sc = sc_detail.get("scorecard") or {}
        sc_stats = sc_detail.get("scorecardStats") or {}

        if not shot_data_raw:
            skipped_no_shots += 1
            continue

        if activity_id not in rounds_by_id:
            skipped_no_match += 1
            continue

        round_rec = rounds_by_id[activity_id]

        shots = parse_shots_from_raw(shot_data_raw, club_map, club_type_names)
        round_rec["shots"] = shots

        # Backfill round-level tee box & 9-stats if not already present
        if sc:
            round_rec.setdefault("tee_box", sc.get("teeBox"))
            round_rec.setdefault("tee_box_rating", sc.get("teeBoxRating"))
            round_rec.setdefault("tee_box_slope", sc.get("teeBoxSlope"))
        if sc_stats:
            round_rec.setdefault(
                "front_nine", _parse_nine_stats(sc_stats.get("frontNine"))
            )
            round_rec.setdefault(
                "back_nine", _parse_nine_stats(sc_stats.get("backNine"))
            )

        # Backfill hole par / yardage from courses.json
        course_id = round_rec.get("course_id")
        canonical_name, course_holes = find_course(
            course_id, round_rec.get("course"), course_lookup
        )
        if canonical_name:
            round_rec["course"] = canonical_name
        for hole in round_rec.get("holes", []):
            h_num = hole.get("hole")
            if h_num in course_holes:
                ref = course_holes[h_num]
                if hole.get("par") is None:
                    hole["par"] = ref.get("par")
                if hole.get("yardage") is None:
                    hole["yardage"] = ref.get("yardage")

        updated += 1
        print(
            f"  {activity_id}  {round_rec['date']}  {round_rec.get('course', ''):20s}  → {len(shots)} shots"
        )

    rounds_data["last_updated"] = datetime.now().isoformat()
    _save_all_data(rounds_data, args.rounds, args.holes, args.shots)

    print(f"\nDone. Updated {updated} round(s), {skipped_no_shots} raw entries had no shot data, {skipped_no_match} had no matching round.")


if __name__ == "__main__":
    main()
