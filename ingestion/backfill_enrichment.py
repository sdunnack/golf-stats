#!/usr/bin/env python3
"""
backfill_enrichment.py
One-shot script to enrich all existing rounds in rounds.json from
raw_garmin_dump.json + courses.json + clubs.json without making any API calls.

Adds (where raw data is available):
  Round-level: tee_box, tee_box_rating, tee_box_slope, front_nine, back_nine
  Hole-level:  par, yardage (from courses.json), end_lat, end_lon (last shot of hole)
  Shot-level:  end_lat, end_lon, club_type_name

Usage:
    python backfill_enrichment.py
    python backfill_enrichment.py --raw raw_garmin_dump.json --rounds rounds.json
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
    """Read the 3 split files and reconstitute nested round structure."""
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
    """Split nested round structure into 3 files and write them."""
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


def load_course_lookup(courses_file):
    """
    Returns {"by_id": {garmin_course_id: (canonical_name, hole_map)},
             "by_name": {name_or_alias_lower: (canonical_name, hole_map)}}
    Lookup priority: by_id (unambiguous) then by_name/alias (fallback).
    """
    if not courses_file.exists():
        return {"by_id": {}, "by_name": {}}
    with open(courses_file) as f:
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


def load_club_type_names(clubs_file):
    """Return {club_type_id (int): type_name_str} from clubs.json."""
    if not clubs_file.exists():
        return {}
    with open(clubs_file) as f:
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


def build_hole_end_locs(shot_data_raw):
    """Return {hole_num: (end_lat, end_lon)} using the last shot of each hole."""
    hole_ends = {}
    for hole_resp in shot_data_raw or []:
        if not isinstance(hole_resp, dict):
            continue
        for hole_entry in hole_resp.get("holeShots") or []:
            h_num = hole_entry.get("holeNumber")
            shots = hole_entry.get("shots") or []
            if shots and h_num is not None:
                last = shots[-1]
                end = last.get("endLoc") or {}
                lat = end.get("lat")
                lon = end.get("lon")
                if lat is not None:
                    hole_ends[h_num] = (lat, lon)
    return hole_ends


def build_shot_end_locs(shot_data_raw):
    """Return {(hole_num, shot_order): (end_lat, end_lon)}."""
    ends = {}
    for hole_resp in shot_data_raw or []:
        if not isinstance(hole_resp, dict):
            continue
        for hole_entry in hole_resp.get("holeShots") or []:
            h_num = hole_entry.get("holeNumber")
            for shot in hole_entry.get("shots") or []:
                order = shot.get("shotOrder")
                end = shot.get("endLoc") or {}
                lat = end.get("lat")
                lon = end.get("lon")
                if h_num is not None and order is not None and lat is not None:
                    ends[(h_num, order)] = (lat, lon)
    return ends


def main():
    parser = argparse.ArgumentParser(
        description="Enrich rounds.json from raw dump + reference files"
    )
    parser.add_argument("--raw", type=Path, default=RAW_FILE)
    parser.add_argument("--rounds", type=Path, default=ROUNDS_FILE)
    parser.add_argument("--holes", type=Path, default=HOLES_FILE)
    parser.add_argument("--shots", type=Path, default=SHOTS_FILE)
    parser.add_argument("--courses", type=Path, default=COURSES_FILE)
    parser.add_argument("--clubs", type=Path, default=CLUBS_FILE)
    args = parser.parse_args()

    for p in (args.raw, args.rounds):
        if not p.exists():
            print(f"File not found: {p}")
            return

    with open(args.raw) as f:
        raw_dump = json.load(f)

    rounds_data = _load_all_data(args.rounds, args.holes, args.shots)

    course_lookup = load_course_lookup(args.courses)
    club_type_names = load_club_type_names(args.clubs)

    # Index raw entries by activity_id for fast lookup
    raw_by_id = {str(e.get("activity_id", "")): e for e in raw_dump}

    rounds_by_id = {r["activity_id"]: r for r in rounds_data["rounds"]}

    updated = 0
    for activity_id, round_rec in rounds_by_id.items():
        raw_entry = raw_by_id.get(activity_id)
        sc_detail = (raw_entry or {}).get("scorecard_detail") or {}
        sc = sc_detail.get("scorecard") or {}
        sc_stats = sc_detail.get("scorecardStats") or {}
        shot_data_raw = (raw_entry or {}).get("shot_data_raw")

        changed = False

        # ── Round-level enrichment ────────────────────────────────────────────
        # Backfill course_id from raw scorecard (durable key for future lookups)
        course_id = sc.get("courseGlobalId")
        if round_rec.get("course_id") is None and course_id is not None:
            round_rec["course_id"] = course_id
            changed = True

        if sc:
            if round_rec.get("tee_box") is None and sc.get("teeBox"):
                round_rec["tee_box"] = sc["teeBox"]
                changed = True
            if (
                round_rec.get("tee_box_rating") is None
                and sc.get("teeBoxRating") is not None
            ):
                round_rec["tee_box_rating"] = sc["teeBoxRating"]
                changed = True
            if (
                round_rec.get("tee_box_slope") is None
                and sc.get("teeBoxSlope") is not None
            ):
                round_rec["tee_box_slope"] = sc["teeBoxSlope"]
                changed = True

        if sc_stats:
            if round_rec.get("front_nine") is None:
                fn = _parse_nine_stats(sc_stats.get("frontNine"))
                if fn:
                    round_rec["front_nine"] = fn
                    changed = True
            if round_rec.get("back_nine") is None:
                bn = _parse_nine_stats(sc_stats.get("backNine"))
                if bn:
                    round_rec["back_nine"] = bn
                    changed = True

        # ── Hole-level enrichment ─────────────────────────────────────────────
        course_id = round_rec.get("course_id") or sc.get("courseGlobalId")
        canonical_name, course_holes = find_course(
            course_id, round_rec.get("course"), course_lookup
        )
        if canonical_name and round_rec.get("course") != canonical_name:
            round_rec["course"] = canonical_name
            changed = True
        hole_ends = build_hole_end_locs(shot_data_raw) if shot_data_raw else {}

        for hole in round_rec.get("holes", []):
            h_num = hole.get("hole")

            # par / yardage from courses.json
            if h_num in course_holes:
                ref = course_holes[h_num]
                if hole.get("par") is None and ref.get("par") is not None:
                    hole["par"] = ref["par"]
                    changed = True
                if hole.get("yardage") is None and ref.get("yardage") is not None:
                    hole["yardage"] = ref["yardage"]
                    changed = True

            # end location from last shot of hole
            if h_num in hole_ends:
                lat, lon = hole_ends[h_num]
                if hole.get("end_lat") is None and lat is not None:
                    hole["end_lat"] = lat
                    hole["end_lon"] = lon
                    changed = True

        # ── Shot-level enrichment ─────────────────────────────────────────────
        if shot_data_raw:
            shot_ends = build_shot_end_locs(shot_data_raw)
            for shot in round_rec.get("shots", []):
                h_num = shot.get("hole")
                order = shot.get("shot_number")
                key = (h_num, order)
                if key in shot_ends and shot.get("end_lat") is None:
                    lat, lon = shot_ends[key]
                    shot["end_lat"] = lat
                    shot["end_lon"] = lon
                    changed = True

                # club_type_name
                if (
                    shot.get("club_type_name") is None
                    and shot.get("club_type_id") is not None
                ):
                    type_name = club_type_names.get(shot["club_type_id"])
                    if type_name:
                        shot["club_type_name"] = type_name
                        changed = True

        if changed:
            updated += 1
            print(
                f"  {activity_id}  {round_rec['date']}  {round_rec.get('course', '')}"
            )

    rounds_data["last_updated"] = datetime.now().isoformat()
    _save_all_data(rounds_data, args.rounds, args.holes, args.shots)

    print(f"\nDone. Enriched {updated} round(s).")


if __name__ == "__main__":
    main()
