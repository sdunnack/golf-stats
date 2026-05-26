#!/usr/bin/env python3
"""
fetch_rounds.py
Pulls golf round data from Garmin Connect and stores it in rounds.json.
Run this after each round (or to backfill history).

Usage:
    python fetch_rounds.py                    # fetch last 30 days
    python fetch_rounds.py --days 365         # fetch last year
    python fetch_rounds.py --dump-raw         # also save raw API response for field inspection
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import garminconnect

BASE_DIR = Path(__file__).parent.parent / "data"
DATA_FILE = BASE_DIR / "rounds.json"
HOLES_FILE = BASE_DIR / "holes.json"
SHOTS_FILE = BASE_DIR / "shots.json"
RAW_DUMP_FILE = BASE_DIR / "raw_garmin_dump.json"
COURSES_FILE = BASE_DIR / "courses.json"
CLUBS_FILE = BASE_DIR / "clubs.json"
CREDS_FILE = Path(__file__).parent.parent / ".garmin_creds.json"
TOKENSTORE_DIR = Path.home() / ".garminconnect"


# ---------------------------------------------------------------------------
# Reference data helpers (courses.json, clubs.json)
# ---------------------------------------------------------------------------


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


def upsert_clubs(club_map):
    """Merge new club details into clubs.json, preserving existing entries."""
    if not club_map or not CLUBS_FILE.exists():
        return
    with open(CLUBS_FILE) as f:
        clubs_data = json.load(f)
    existing = {c["id"]: c for c in clubs_data.get("clubs", [])}
    changed = False
    for cid, cd in club_map.items():
        if cid not in existing:
            existing[cid] = {
                "id": cid,
                "club_type_id": cd.get("clubTypeId"),
                "name": cd.get("name"),
                "model": cd.get("model"),
                "retired": cd.get("retired", False),
            }
            changed = True
        else:
            # Update mutable fields that may have changed
            entry = existing[cid]
            for src_key, dst_key in (
                ("name", "name"),
                ("model", "model"),
                ("retired", "retired"),
            ):
                new_val = cd.get(src_key)
                if new_val is not None and entry.get(dst_key) != new_val:
                    entry[dst_key] = new_val
                    changed = True
    if changed:
        clubs_data["clubs"] = sorted(existing.values(), key=lambda c: c["id"])
        with open(CLUBS_FILE, "w") as f:
            json.dump(clubs_data, f, indent=2)


def _parse_nine_stats(stats):
    """Normalize a frontNine/backNine stats dict from Garmin scorecardStats."""
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


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


def load_credentials():
    """Load saved credentials or prompt interactively."""
    if CREDS_FILE.exists():
        with open(CREDS_FILE) as f:
            creds = json.load(f)
        return creds["email"], creds["password"]

    print("Garmin Connect credentials (saved locally to .garmin_creds.json)")
    email = input("Email: ").strip()
    password = input("Password: ").strip()

    with open(CREDS_FILE, "w") as f:
        json.dump({"email": email, "password": password}, f)
    os.chmod(CREDS_FILE, 0o600)  # owner read/write only

    return email, password


def get_garmin_client():
    email, password = load_credentials()

    def prompt_mfa_code():
        print("MFA required. Enter the code sent by text message.")
        return input("MFA code: ").strip()

    print(f"Authenticating as {email}...")
    client = garminconnect.Garmin(email, password, prompt_mfa=prompt_mfa_code)
    # Reuse saved OAuth tokens when possible; falls back to credential login as needed.
    client.login(str(TOKENSTORE_DIR))
    print("Authenticated.")
    return client


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------


def fetch_golf_activities(client, days=30):
    """Return list of golf activities in the date range."""
    end = datetime.now()
    start = end - timedelta(days=days)
    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    print(f"Fetching golf activities from {start_str} to {end_str}...")
    # Garmin's date-range endpoint does not accept golf as an activityType filter.
    # Fetch the range and filter golf activities locally by typeKey.
    activities = client.get_activities_by_date(start_str, end_str)

    golf_activities = []
    for activity in activities:
        type_key = (
            safe_get(activity, "activityType", "typeKey", default="") or ""
        ).lower()
        parent_type_key = (
            safe_get(activity, "activityType", "parentTypeKey", default="") or ""
        ).lower()

        if "golf" in type_key or "golf" in parent_type_key:
            golf_activities.append(activity)

    print(
        f"Found {len(golf_activities)} golf activity(ies) "
        f"out of {len(activities)} total in range."
    )
    return golf_activities


def _extract_scorecard_id(activity):
    """Best-effort extraction of scorecard ID from an activity payload."""
    candidates = [
        activity.get("scorecardId"),
        activity.get("golfScorecardId"),
        safe_get(activity, "metadataDTO", "scorecardId"),
        safe_get(activity, "metadataDTO", "golfScorecardId"),
    ]
    for candidate in candidates:
        if candidate is not None and str(candidate).strip():
            return str(candidate)
    return None


def _pick_scorecard_id_from_summary(activity, summaries):
    """Find matching scorecard ID from golf summary data."""
    if not summaries:
        return None

    activity_id = str(activity.get("activityId", ""))
    activity_date = (activity.get("startTimeLocal", "") or "")[:10]
    activity_course = (
        (activity.get("locationName") or activity.get("activityName", ""))
        .strip()
        .lower()
    )

    for item in summaries:
        item_activity_id = str(
            item.get("activityId")
            or item.get("activity_id")
            or safe_get(item, "activity", "activityId")
            or ""
        )
        scorecard_id = item.get("scorecardId") or item.get("id")
        if item_activity_id and item_activity_id == activity_id and scorecard_id:
            return str(scorecard_id)

    for item in summaries:
        scorecard_id = item.get("scorecardId") or item.get("id")
        item_date = (
            item.get("startTime")
            or item.get("startTimeLocal")
            or item.get("date")
            or ""
        )[:10]
        item_course = (
            (item.get("courseName") or item.get("golfCourseName") or "").strip().lower()
        )
        if (
            scorecard_id
            and activity_date
            and item_date == activity_date
            and activity_course
            and item_course
            and (
                item_course == activity_course
                or item_course in activity_course
                or activity_course in item_course
            )
        ):
            return str(scorecard_id)

    # If there is exactly one scorecard on the activity date, use it.
    date_matches = []
    for item in summaries:
        scorecard_id = item.get("scorecardId") or item.get("id")
        item_date = (
            item.get("startTime")
            or item.get("startTimeLocal")
            or item.get("date")
            or ""
        )[:10]
        if scorecard_id and activity_date and item_date == activity_date:
            date_matches.append(str(scorecard_id))

    if len(date_matches) == 1:
        return date_matches[0]

    return None


def _normalize_scorecard_detail(scorecard_detail):
    """Unwrap common response envelopes to a single scorecard detail dict."""
    if not scorecard_detail:
        return scorecard_detail

    if isinstance(scorecard_detail, list):
        if scorecard_detail and isinstance(scorecard_detail[0], dict):
            return scorecard_detail[0]
        return None

    if isinstance(scorecard_detail, dict):
        for key in ["scorecardDetails", "details", "items", "scorecardDetail"]:
            v = scorecard_detail.get(key)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v[0]
            if isinstance(v, dict):
                return v

    return scorecard_detail


def fetch_scorecard_detail(client, activity, debug=None):
    """Fetch full scorecard including hole-by-hole and shot data."""
    activity_id = str(activity.get("activityId", ""))
    if debug is not None:
        debug["activity_id"] = activity_id
        debug["lookup"] = {}

    # Older python-garminconnect versions accepted activity_id directly.
    if hasattr(client, "get_golf_scorecard_details"):
        try:
            if debug is not None:
                debug["lookup"]["legacy_method_available"] = True
                debug["lookup"]["legacy_method_attempted"] = True
            return _normalize_scorecard_detail(
                client.get_golf_scorecard_details(activity_id)
            )
        except Exception as e:
            if debug is not None:
                debug["lookup"]["legacy_method_error"] = str(e)
            print(f"  Warning: legacy scorecard fetch failed for {activity_id}: {e}")
    elif debug is not None:
        debug["lookup"]["legacy_method_available"] = False

    # Newer versions use scorecard IDs and get_golf_scorecard().
    scorecard_id = _extract_scorecard_id(activity)
    summary_entry = None
    if debug is not None:
        debug["lookup"]["scorecard_id_from_activity"] = scorecard_id

    if scorecard_id is None and hasattr(client, "get_golf_summary"):
        try:
            summaries = client.get_golf_summary(limit=200)
            if isinstance(summaries, dict):
                summaries = (
                    summaries.get("scorecardSummaries")
                    or summaries.get("scorecardList")
                    or summaries.get("items")
                    or []
                )
            if not isinstance(summaries, list):
                summaries = []

            if debug is not None:
                debug["lookup"]["summary_count"] = len(summaries)

            scorecard_id = _pick_scorecard_id_from_summary(activity, summaries)

            if scorecard_id is not None:
                for item in summaries:
                    item_id = item.get("scorecardId") or item.get("id")
                    if item_id is not None and str(item_id) == str(scorecard_id):
                        summary_entry = item
                        break

            if debug is not None:
                debug["lookup"]["scorecard_id_from_summary"] = scorecard_id
                debug["lookup"]["summary_match_found"] = summary_entry is not None
        except Exception as e:
            if debug is not None:
                debug["lookup"]["summary_error"] = str(e)
            print(
                f"  Warning: could not load golf summary to map scorecard for {activity_id}: {e}"
            )

    if not hasattr(client, "get_golf_scorecard"):
        if debug is not None:
            debug["lookup"]["new_method_available"] = False
            debug["lookup"]["final_scorecard_id"] = scorecard_id
        print(
            f"  Warning: installed garminconnect client has no golf scorecard method for {activity_id}"
        )
        return None
    elif debug is not None:
        debug["lookup"]["new_method_available"] = True

    if scorecard_id is None:
        # Some accounts expose matching IDs between activity and scorecard.
        scorecard_id = activity_id
        if debug is not None:
            debug["lookup"]["scorecard_id_fallback"] = "activity_id"
        print(
            f"  Note: no mapped scorecard ID found for activity {activity_id}; "
            f"trying activity ID as scorecard ID"
        )

    if debug is not None:
        debug["lookup"]["final_scorecard_id"] = scorecard_id

    try:
        detail = _normalize_scorecard_detail(client.get_golf_scorecard(scorecard_id))
        if isinstance(detail, dict) and not detail and summary_entry:
            # Fallback: summary still has hole-level strokes even when detail is empty.
            detail = summary_entry
            if debug is not None:
                debug["lookup"]["detail_fallback"] = "summary_entry"
        if isinstance(detail, dict) and not detail:
            if debug is not None:
                debug["lookup"]["detail_empty"] = True
            detail = None
        if debug is not None:
            debug["lookup"]["detail_found"] = bool(detail)
        return detail
    except Exception as e:
        if debug is not None:
            debug["lookup"]["detail_error"] = str(e)
        print(f"  Warning: could not fetch scorecard detail for {activity_id}: {e}")
        return None


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def safe_get(d, *keys, default=None):
    """Safely traverse nested dicts."""
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k, default)
        if d is None:
            return default
    return d


def parse_course_handicap_str(raw_value):
    """Parse Garmin's compact course handicap string into {hole_number: index}."""
    if not raw_value:
        return {}

    value = str(raw_value).strip()
    if len(value) < 36:
        return {}

    # Garmin commonly returns 18 two-digit values concatenated, e.g. "131101...".
    pairs = [value[i : i + 2] for i in range(0, min(len(value), 36), 2)]
    if len(pairs) != 18:
        return {}

    parsed = {}
    for i, p in enumerate(pairs, start=1):
        if p.isdigit():
            parsed[i] = int(p)
    return parsed


def parse_hole(hole_data):
    """Parse a single hole from scorecard detail."""
    fairway_outcome = safe_get(hole_data, "fairwayShotOutcome")
    fairway_hit = safe_get(hole_data, "fairwayHit")
    fairway_missed_direction = safe_get(hole_data, "fairwayMissDirection")

    # Newer golf payloads provide fairwayShotOutcome instead of fairwayHit/fairwayMissDirection.
    if fairway_outcome:
        outcome = str(fairway_outcome).upper()
        if outcome == "HIT":
            fairway_hit = True
            fairway_missed_direction = None
        elif outcome in {"LEFT", "RIGHT"}:
            fairway_hit = False
            fairway_missed_direction = outcome

    return {
        "hole": safe_get(hole_data, "holeNumber") or safe_get(hole_data, "number"),
        "hole_handicap_index": safe_get(hole_data, "holeHandicapIndex")
        or safe_get(hole_data, "handicapIndex"),
        "par": safe_get(hole_data, "par"),
        "yardage": safe_get(hole_data, "yardage"),
        "score": safe_get(hole_data, "strokes") or safe_get(hole_data, "totalStrokes"),
        "handicap_score": safe_get(hole_data, "handicapScore"),
        "putts": safe_get(hole_data, "putts"),
        "gir": safe_get(hole_data, "greenInRegulation"),  # bool or None
        "fairway_hit": fairway_hit,  # bool or None
        "fairway_missed_direction": fairway_missed_direction,  # "LEFT"/"RIGHT"/None
        "penalties": safe_get(hole_data, "penalties"),
        "sand_shots": safe_get(hole_data, "sandShots"),
    }


def parse_shot(shot_data, club_map=None):
    """Parse a single shot record from the Garmin golf shot API."""
    club_id = shot_data.get("clubId")
    club_info = (club_map or {}).get(club_id, {}) if club_id else {}
    meters = shot_data.get("meters")
    return {
        "shot_number": shot_data.get("shotOrder"),
        "club_id": club_id,
        "club_type_id": club_info.get("clubTypeId"),  # numeric Garmin club type
        "club_name": club_info.get("name"),  # custom name e.g. "The Avenger"
        "club_model": club_info.get("model"),  # e.g. "Taylormade Qi35"
        "distance_yards": round(meters * 1.09361, 1) if meters is not None else None,
        "lie": safe_get(
            shot_data, "startLoc", "lie"
        ),  # "TeeBox", "Fairway", "Rough", "Green", etc.
        "shot_type": shot_data.get(
            "shotType"
        ),  # "TEE", "APPROACH", "CHIP", "PUTT", etc.
        "lat": safe_get(shot_data, "startLoc", "lat"),
        "lon": safe_get(shot_data, "startLoc", "lon"),
        "end_lat": safe_get(shot_data, "endLoc", "lat"),
        "end_lon": safe_get(shot_data, "endLoc", "lon"),
    }


def extract_scorecard_id_from_detail(detail):
    return safe_get(detail, "scorecard", "id")


def fetch_shot_data(client, scorecard_id):
    shots = []
    raw_all = []
    club_map = {}  # clubId → clubDetails dict; same bag appears on every hole response

    for hole_num in range(1, 19):
        try:
            raw = client.get_golf_shot_data(scorecard_id, hole_numbers=str(hole_num))
        except Exception as e:
            print(f"  Warning: shot data failed for scorecard {scorecard_id} hole {hole_num}: {e}")
            continue
        raw_all.append(raw)

        if isinstance(raw, dict):
            # clubDetails is the player's bag — populate once, reuse for all holes
            if not club_map:
                for cd in (raw.get("clubDetails") or []):
                    club_map[cd["id"]] = cd
                upsert_clubs(club_map)
            hole_entries = raw.get("holeShots") or []
        elif isinstance(raw, list):
            hole_entries = raw
        else:
            hole_entries = []

        for hole_entry in hole_entries:
            h_num = hole_entry.get("holeNumber") or hole_num
            for shot in (hole_entry.get("shots") or []):
                parsed = parse_shot(shot, club_map)
                parsed["hole"] = h_num
                shots.append(parsed)

    return shots, raw_all


def parse_activity(activity, scorecard_detail):
    """
    Combine top-level activity metadata with parsed scorecard detail
    into a clean round record.
    """
    activity_id = str(activity.get("activityId", ""))
    date_str = activity.get("startTimeLocal", "")[:10]  # "YYYY-MM-DD"

    round_record = {
        "activity_id": activity_id,
        "date": date_str,
        "course": activity.get("locationName")
        or activity.get("activityName", "Unknown"),
        "duration_seconds": activity.get("duration"),
        "distance_meters": activity.get("distance"),
        "course_id": None,
        "tee_box": None,
        "tee_box_rating": None,
        "tee_box_slope": None,
        "front_nine": None,
        "back_nine": None,
        "totals": {},
        "holes": [],
        "shots": [],  # shot-by-shot club data (populated if CT10 data present)
        "_raw_available": bool(scorecard_detail),
    }

    if not scorecard_detail:
        return round_record

    # Some versions nest data differently — handle both common shapes
    # Try shape 1: top-level keys
    holes_raw = (
        scorecard_detail.get("holes")
        or scorecard_detail.get("holeDetails")
        or scorecard_detail.get("holeScores")
        or safe_get(scorecard_detail, "scorecard", "holes")
        or safe_get(scorecard_detail, "scorecardData", "holes")
        or safe_get(scorecard_detail, "scorecard", "holeDetails")
        or []
    )
    if isinstance(holes_raw, dict):
        holes_raw = list(holes_raw.values())

    shots_raw = (
        scorecard_detail.get("shots") or safe_get(scorecard_detail, "shotData") or []
    )
    if isinstance(shots_raw, dict):
        flattened = []
        for value in shots_raw.values():
            if isinstance(value, list):
                flattened.extend(value)
        shots_raw = flattened

    # Parse holes
    course_handicap_map = parse_course_handicap_str(
        safe_get(scorecard_detail, "scorecard", "courseHandicapStr")
        or safe_get(scorecard_detail, "scorecard", "courseHandicap")
    )

    parsed_holes = []
    for hole in holes_raw:
        parsed_hole = parse_hole(hole)
        hole_number = parsed_hole.get("hole")
        if (
            isinstance(hole_number, int)
            and parsed_hole.get("hole_handicap_index") is None
            and hole_number in course_handicap_map
        ):
            parsed_hole["hole_handicap_index"] = course_handicap_map[hole_number]
        parsed_holes.append(parsed_hole)

    round_record["holes"] = parsed_holes

    # Compute totals from hole data
    valid_holes = [h for h in parsed_holes if h["score"] is not None]
    if valid_holes:
        round_record["totals"] = {
            "holes_played": len(valid_holes),
            "score": sum(h["score"] for h in valid_holes),
            "putts": sum(h["putts"] or 0 for h in valid_holes),
            "gir_count": sum(1 for h in valid_holes if h["gir"] is True),
            "gir_pct": round(
                sum(1 for h in valid_holes if h["gir"] is True)
                / len(valid_holes)
                * 100,
                1,
            ),
            "fairways_hit": sum(1 for h in valid_holes if h["fairway_hit"] is True),
            "fairways_possible": sum(
                1
                for h in valid_holes
                if h["fairway_hit"] is not None  # par 3s are None
            ),
        }
        fwy_poss = round_record["totals"]["fairways_possible"]
        if fwy_poss > 0:
            round_record["totals"]["fairway_pct"] = round(
                round_record["totals"]["fairways_hit"] / fwy_poss * 100, 1
            )

    # Prefer Garmin's round-level stats when available (more reliable than inferring).
    stats_round = (
        safe_get(scorecard_detail, "scorecardStats", "round")
        or safe_get(scorecard_detail, "scorecardStats", "total")
        or {}
    )
    if stats_round and isinstance(stats_round, dict):
        totals = round_record.setdefault("totals", {})

        greens_in_reg = stats_round.get("greensInRegulation")
        greens_recorded = stats_round.get("greensRecorded")
        fairways_recorded = stats_round.get("fairwaysRecorded")
        fairways_hit = stats_round.get("fairwaysHit")

        if greens_in_reg is not None:
            totals["gir_count"] = greens_in_reg
        if greens_recorded is not None and greens_recorded > 0:
            totals["holes_played"] = totals.get("holes_played") or greens_recorded
            totals["gir_pct"] = round(
                (totals.get("gir_count", 0) / greens_recorded) * 100, 1
            )

        if fairways_recorded is not None:
            totals["fairways_possible"] = fairways_recorded
        if fairways_hit is not None:
            totals["fairways_hit"] = fairways_hit
        if (
            totals.get("fairways_possible", 0) > 0
            and totals.get("fairways_hit") is not None
        ):
            totals["fairway_pct"] = round(
                totals["fairways_hit"] / totals["fairways_possible"] * 100, 1
            )

    # Parse shot data (CT10)
    if shots_raw:
        round_record["shots"] = [parse_shot(s) for s in shots_raw]

    # ── Tee box, course ID & round stats ──────────────────────────────────────
    sc = scorecard_detail.get("scorecard") or {}
    course_id = sc.get("courseGlobalId")
    round_record["course_id"] = course_id
    round_record["tee_box"] = sc.get("teeBox")
    round_record["tee_box_rating"] = sc.get("teeBoxRating")
    round_record["tee_box_slope"] = sc.get("teeBoxSlope")

    sc_stats = scorecard_detail.get("scorecardStats") or {}
    round_record["front_nine"] = _parse_nine_stats(sc_stats.get("frontNine"))
    round_record["back_nine"] = _parse_nine_stats(sc_stats.get("backNine"))

    # ── Par / yardage from courses.json (by ID first, then name/alias) ────────
    cl = load_course_lookup()
    canonical_name, course_holes = find_course(course_id, round_record["course"], cl)
    if canonical_name:
        round_record["course"] = canonical_name
    for hole in round_record["holes"]:
        h_num = hole.get("hole")
        if h_num in course_holes:
            ref = course_holes[h_num]
            if hole.get("par") is None:
                hole["par"] = ref.get("par")
            if hole.get("yardage") is None:
                hole["yardage"] = ref.get("yardage")

    return round_record


def has_recorded_score(round_record):
    """Return True when a round has a recorded score at round or hole level."""
    totals_score = safe_get(round_record, "totals", "score")
    if totals_score is not None:
        return True

    for hole in round_record.get("holes", []):
        if safe_get(hole, "score") is not None:
            return True

    return False


def prune_rounds_without_scores(data):
    """Remove rounds with no recorded score from persisted data."""
    rounds = data.get("rounds", [])
    kept = [r for r in rounds if has_recorded_score(r)]
    removed_count = len(rounds) - len(kept)
    data["rounds"] = kept
    return data, removed_count


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def load_existing_rounds():
    if DATA_FILE.exists():
        data = {}
        with open(DATA_FILE) as f:
            data = json.load(f)
        holes_by_id = {}
        if HOLES_FILE.exists():
            with open(HOLES_FILE) as f:
                for h in json.load(f).get("holes", []):
                    aid = h.pop("activity_id", None)
                    if aid:
                        holes_by_id.setdefault(aid, []).append(h)
        shots_by_id = {}
        if SHOTS_FILE.exists():
            with open(SHOTS_FILE) as f:
                for s in json.load(f).get("shots", []):
                    aid = s.pop("activity_id", None)
                    if aid:
                        shots_by_id.setdefault(aid, []).append(s)
        for r in data["rounds"]:
            aid = r["activity_id"]
            r["holes"] = holes_by_id.get(aid, [])
            r["shots"] = shots_by_id.get(aid, [])
        return data
    return {"rounds": [], "last_updated": None}


def save_rounds(data):
    data["last_updated"] = datetime.now().isoformat()
    all_holes, all_shots = [], []
    rounds_clean = []
    for r in data["rounds"]:
        aid = r["activity_id"]
        for h in r.pop("holes", []):
            all_holes.append({"activity_id": aid, **h})
        for s in r.pop("shots", []):
            all_shots.append({"activity_id": aid, **s})
        rounds_clean.append(r)
    data["rounds"] = rounds_clean
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2, default=str)
    with open(HOLES_FILE, "w") as f:
        json.dump({"holes": all_holes}, f, indent=2, default=str)
    with open(SHOTS_FILE, "w") as f:
        json.dump({"shots": all_shots}, f, indent=2, default=str)
    print(f"Saved {len(rounds_clean)} round(s) to {DATA_FILE}")


def merge_rounds(existing_data, new_rounds):
    """Upsert rounds by activity_id; replace stale/incomplete existing entries."""
    existing_index = {
        r["activity_id"]: i for i, r in enumerate(existing_data["rounds"])
    }
    added = 0
    updated = 0
    for r in new_rounds:
        activity_id = r["activity_id"]
        if activity_id in existing_index:
            existing_data["rounds"][existing_index[activity_id]] = r
            updated += 1
        else:
            existing_data["rounds"].append(r)
            existing_index[activity_id] = len(existing_data["rounds"]) - 1
            added += 1
    # Sort by date descending
    existing_data["rounds"].sort(key=lambda x: x["date"], reverse=True)
    return existing_data, added, updated


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Fetch Garmin golf data")
    parser.add_argument(
        "--days", type=int, default=30, help="Days of history to fetch (default: 30)"
    )
    parser.add_argument(
        "--dump-raw", action="store_true", help="Save raw API responses for inspection"
    )
    args = parser.parse_args()

    client = get_garmin_client()
    activities = fetch_golf_activities(client, days=args.days)

    if not activities:
        print("No golf activities found in that range.")
        sys.exit(0)

    existing_data = load_existing_rounds()
    existing_data, pruned_count = prune_rounds_without_scores(existing_data)
    if pruned_count:
        print(f"Pruned {pruned_count} existing round(s) with no recorded score.")
    existing_by_id = {r["activity_id"]: r for r in existing_data["rounds"]}

    new_rounds = []
    raw_dump = []

    for activity in activities:
        activity_id = str(activity.get("activityId", ""))
        date = activity.get("startTimeLocal", "")[:10]
        course = activity.get("locationName") or activity.get("activityName", "")

        existing_round = existing_by_id.get(activity_id)
        if existing_round:
            has_detail = bool(existing_round.get("holes")) or bool(
                existing_round.get("_raw_available")
            )
            holes = existing_round.get("holes") or []
            has_handicap_fields = bool(holes) and all(
                isinstance(h, dict)
                and "hole_handicap_index" in h
                and "handicap_score" in h
                for h in holes
            )

            existing_shots = existing_round.get("shots") or []
            has_shots = bool(existing_shots) and any(
                s.get("club_type_id") is not None for s in existing_shots
            )
            if has_detail and has_handicap_fields and has_shots:
                print(f"  Skipping {date} {course} (already stored with detail and shots)")
                continue
            print(f"  Refreshing detail: {date} {course} (id={activity_id})")
        else:
            print(f"  Fetching detail: {date} {course} (id={activity_id})")
        debug_entry = {
            "activity_id": activity_id,
            "activity_meta": activity,
        }
        scorecard = fetch_scorecard_detail(client, activity, debug=debug_entry)

        if args.dump_raw:
            debug_entry["scorecard_detail"] = scorecard

        round_record = parse_activity(activity, scorecard)
        if not has_recorded_score(round_record):
            print("    - Skipping (no score recorded)")
            continue

        # Fetch per-shot club data if we have a scorecard ID
        shot_raw = None
        if scorecard:
            scorecard_id = extract_scorecard_id_from_detail(scorecard)
            if scorecard_id:
                shots, shot_raw = fetch_shot_data(client, scorecard_id)
                round_record["shots"] = shots
                print(f"    → Shot/club data: {len(shots)} shots")
            else:
                print("    → No scorecard ID; skipping shot data")

        if args.dump_raw:
            debug_entry["shot_data_raw"] = shot_raw
            raw_dump.append(debug_entry)

        new_rounds.append(round_record)

        # Print quick summary
        t = round_record.get("totals", {})
        if t:
            print(
                f"    → Score: {t.get('score')}  Putts: {t.get('putts')}  "
                f"GIR: {t.get('gir_count')}/{t.get('holes_played')}  "
                f"FWY: {t.get('fairways_hit')}/{t.get('fairways_possible')}  "
                f"Shots w/club data: {len(round_record.get('shots', []))}"
            )

    merged_data, added, updated = merge_rounds(existing_data, new_rounds)
    save_rounds(merged_data)
    print(f"\nDone. Added {added} new round(s), updated {updated} existing round(s).")

    if args.dump_raw:
        with open(RAW_DUMP_FILE, "w") as f:
            json.dump(raw_dump, f, indent=2, default=str)
        print(
            f"Raw API data saved to {RAW_DUMP_FILE} — inspect this to verify field names."
        )


if __name__ == "__main__":
    main()
