#!/usr/bin/env python3
"""
refresh_details.py
Re-fetch the full Garmin scorecard detail and CT10 shot data for stored rounds
that only carry summary-level data (score + par, but no putts / fairways /
penalties / tee box / shots).

Why this exists
---------------
An earlier `--fix-incomplete` pass used the golf *summary* list as if it were
the scorecard detail. The summary only has strokes per hole, so ~115 rounds
were saved with nothing else even though Garmin holds the rest. This script
matches each stored round to its Garmin scorecard (by date + strokes), pulls
the real detail and the per-hole shot list, and merges them back in.

Where Garmin never recorded putts on the scorecard but the putter sensor was
on for that round, putts are derived from the shot list (count of PUTT shots
per hole) and tagged with `putts_source: "shots"`.

Usage:
    python refresh_details.py             # rounds missing detail only
    python refresh_details.py --all       # re-fetch every stored round
    python refresh_details.py --dry-run   # list what would be refreshed
    python refresh_details.py --limit 10  # stop after N rounds (for testing)

Raw API responses are cached in data/raw_cache/<scorecard_id>.*.json so a
re-run does not hit the API again. Delete a cache file to force a refresh.
After merging, backfill_enrichment.py and strokes_gained.py are run so the
derived fields (course par/yardage, SG, handicap) are recomputed.
"""

import argparse
import json
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import fetch_rounds as fr  # noqa: E402

CACHE_DIR = fr.BASE_DIR / "raw_cache"
SHOT_CALL_PAUSE = 0.25  # seconds between per-hole shot calls
RETRY_DELAYS = (5, 15, 45)


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


def with_retry(fn, what):
    """Call fn(); on failure back off and retry a few times before giving up."""
    last = None
    for i, delay in enumerate((0,) + RETRY_DELAYS):
        if delay:
            print(f"    retry {i} for {what} in {delay}s ({last})")
            time.sleep(delay)
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"{what} failed after retries: {last}")


def fetch_all_summaries(client):
    """Return every scorecard summary on the account."""
    page = with_retry(
        lambda: client.get_golf_summary(start=0, limit=2000), "golf summary"
    )
    if isinstance(page, dict):
        items = page.get("scorecardSummaries") or []
        total = page.get("totalRows")
        if total is not None and total > len(items):
            print(
                f"  Warning: summary returned {len(items)} of {total} scorecards; "
                "older rounds may not be matched."
            )
        return items
    return page or []


def _cache_path(scorecard_id, kind):
    return CACHE_DIR / f"{scorecard_id}.{kind}.json"


def get_detail(client, scorecard_id):
    """Scorecard detail (normalized to a single dict), cached on disk."""
    p = _cache_path(scorecard_id, "detail")
    if p.exists():
        with open(p) as f:
            raw = json.load(f)
    else:
        raw = with_retry(
            lambda: client.get_golf_scorecard(scorecard_id),
            f"scorecard {scorecard_id}",
        )
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(p, "w") as f:
            json.dump(raw, f)
    # The detail response wraps the scorecard with a courseSnapshots list that
    # carries the hole pars ("445534434443455443"); keep them for parse_activity.
    detail = fr._normalize_scorecard_detail(raw)
    if isinstance(detail, dict) and isinstance(raw, dict):
        for snap in raw.get("courseSnapshots") or []:
            if snap.get("holePars"):
                detail.setdefault("holePars", snap["holePars"])
                break
    return detail


def get_shots(client, scorecard_id, shot_counts):
    """
    Per-hole shot responses for a scorecard, cached on disk. Holes whose
    shotCounts entry is 0 are skipped (no sensor data to fetch).
    Returns (parsed_shots, raw_list) in the same shape fetch_rounds uses.
    """
    p = _cache_path(scorecard_id, "shots")
    if p.exists():
        with open(p) as f:
            raw_list = json.load(f)
    else:
        raw_list = []
        for hole_num in range(1, 19):
            if shot_counts and hole_num <= len(shot_counts) and not shot_counts[hole_num - 1]:
                continue
            try:
                raw = with_retry(
                    lambda: client.get_golf_shot_data(scorecard_id, hole_numbers=str(hole_num)),
                    f"shots {scorecard_id} hole {hole_num}",
                )
            except RuntimeError as e:
                print(f"    Warning: {e}")
                continue
            raw_list.append(raw)
            time.sleep(SHOT_CALL_PAUSE)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(p, "w") as f:
            json.dump(raw_list, f)

    shots, club_map = [], {}
    for raw in raw_list:
        if not isinstance(raw, dict):
            continue
        if not club_map:
            for cd in raw.get("clubDetails") or []:
                club_map[cd["id"]] = cd
            if club_map:
                fr.upsert_clubs(club_map)
        for hole_entry in raw.get("holeShots") or []:
            h_num = hole_entry.get("holeNumber")
            for shot in hole_entry.get("shots") or []:
                parsed = fr.parse_shot(shot, club_map)
                parsed["hole"] = h_num
                shots.append(parsed)
    return shots, raw_list


# ---------------------------------------------------------------------------
# Matching stored rounds to Garmin scorecards
# ---------------------------------------------------------------------------


def _shift(date_str, days):
    return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def build_summary_index(summaries):
    by_date = defaultdict(list)
    for s in summaries:
        d = (s.get("startTime") or "")[:10]
        if d:
            by_date[d].append(s)
    return by_date


def match_summary(round_rec, by_date, used_ids):
    """
    Find the Garmin scorecard for a stored round. Summary startTime is UTC while
    the stored date is local, so the day after is also considered. Strokes must
    match the stored score; course name breaks ties.
    """
    date = round_rec.get("date")
    score = fr.safe_get(round_rec, "totals", "score")
    course = (round_rec.get("course") or "").strip().lower()
    if not date:
        return None

    for day in (date, _shift(date, 1)):
        cands = [
            s for s in by_date.get(day, [])
            if s.get("id") not in used_ids and s.get("strokes") == score
        ]
        if len(cands) == 1:
            return cands[0]
        if len(cands) > 1:
            named = [
                s for s in cands
                if course and (s.get("courseName") or "").strip().lower() in course
                or course in (s.get("courseName") or "").strip().lower()
            ]
            if len(named) == 1:
                return named[0]
            return cands[0]
    return None


def needs_refresh(round_rec):
    """True when the stored round has only summary-level data."""
    holes = round_rec.get("holes") or []
    has_detail = any(
        h.get("putts") is not None
        or h.get("fairway_hit") is not None
        or h.get("penalties") is not None
        or h.get("handicap_score") is not None
        for h in holes
    )
    missing_par = any(h.get("par") is None for h in holes if h.get("score") is not None)
    return not has_detail or missing_par


# ---------------------------------------------------------------------------
# Derivations
# ---------------------------------------------------------------------------


def derive_putts_from_shots(round_rec, scorecard, shots):
    """
    Fill hole putts from PUTT shots when the scorecard has none but the putter
    sensor was on. A hole with zero PUTT shots is only trusted when the sensor
    captured every stroke on that hole.
    """
    if not scorecard.get("sensorOnPutter"):
        return 0
    by_hole = defaultdict(list)
    for s in shots:
        by_hole[s.get("hole")].append(s)
    filled = 0
    for h in round_rec.get("holes") or []:
        if h.get("putts") is not None or h.get("score") is None:
            continue
        hs = by_hole.get(h.get("hole"))
        if not hs:
            continue
        putts = sum(1 for s in hs if s.get("shot_type") == "PUTT")
        if putts == 0 and len(hs) < h["score"]:
            continue  # incomplete capture, can't tell chip-in from missing data
        h["putts"] = putts
        h["putts_source"] = "shots"
        filled += 1
    return filled


MIN_GIR_HOLES = 5  # holes with a known GIR outcome before a round-level GIR % is stored


def recompute_putt_and_gir_totals(round_rec, keep_garmin_gir=True):
    """
    Totals for putts / GIR with null (not zero) when nothing usable was recorded.

    - putts: only when every played hole has a putt count. A partial sum (e.g.
      one hole of 18) would read as a miraculous round on the dashboard.
    - GIR: from explicit hole GIR or derived from score/putts/par, and only
      when at least MIN_GIR_HOLES holes are known.
    Returns True when anything changed.
    """
    holes = [h for h in round_rec.get("holes") or [] if h.get("score") is not None]
    t = round_rec.setdefault("totals", {})
    before = (t.get("putts"), t.get("gir_count"), t.get("gir_pct"))

    with_putts = [h for h in holes if h.get("putts") is not None]
    complete = bool(holes) and len(with_putts) == len(holes)
    t["putts"] = sum(h["putts"] for h in with_putts) if complete else None

    known = []
    for h in holes:
        g = h.get("gir")
        if g is None and h.get("par") is not None and h.get("putts") is not None:
            g = (h["score"] - h["putts"]) <= (h["par"] - 2)
        if g is not None:
            known.append(bool(g))
    garmin_has_gir = keep_garmin_gir and t.get("gir_pct") is not None and any(
        h.get("gir") is not None for h in holes
    )
    if not garmin_has_gir:
        if len(known) >= MIN_GIR_HOLES:
            t["gir_count"] = sum(known)
            t["gir_pct"] = round(sum(known) / len(known) * 100, 1)
        else:
            t["gir_count"] = None
            t["gir_pct"] = None
    return (t.get("putts"), t.get("gir_count"), t.get("gir_pct")) != before


# ---------------------------------------------------------------------------
# Raw dump merge (keeps backfill_enrichment.py working for refreshed rounds)
# ---------------------------------------------------------------------------


def upsert_raw_dump(entries):
    existing = []
    if fr.RAW_DUMP_FILE.exists():
        try:
            with open(fr.RAW_DUMP_FILE) as f:
                existing = json.load(f) or []
        except json.JSONDecodeError:
            existing = []
    by_id = {str(e.get("activity_id")): i for i, e in enumerate(existing)}
    for e in entries:
        aid = str(e.get("activity_id"))
        if aid in by_id:
            existing[by_id[aid]] = e
        else:
            existing.append(e)
            by_id[aid] = len(existing) - 1
    with open(fr.RAW_DUMP_FILE, "w") as f:
        json.dump(existing, f, indent=2, default=str)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def refresh_round(client, existing_round, summary):
    """Fetch detail + shots for one round and return (round_record, raw_entry)."""
    scorecard_id = summary["id"]
    detail = get_detail(client, scorecard_id)
    if not detail or not detail.get("scorecard"):
        return None, None

    activity = {
        "activityId": existing_round["activity_id"],
        "startTimeLocal": existing_round.get("date", ""),
        "locationName": existing_round.get("course", ""),
        "duration": existing_round.get("duration_seconds"),
        "distance": existing_round.get("distance_meters"),
    }
    record = fr.parse_activity(activity, detail)
    for field in ("course", "date", "duration_seconds", "distance_meters", "hcap_index"):
        if record.get(field) is None and existing_round.get(field) is not None:
            record[field] = existing_round[field]
    # Keep par / yardage already known for the stored round when the detail lacks it.
    old_holes = {h.get("hole"): h for h in existing_round.get("holes") or []}
    for h in record.get("holes") or []:
        old = old_holes.get(h.get("hole"))
        if not old:
            continue
        for key in ("par", "yardage", "hole_handicap_index"):
            if h.get(key) is None and old.get(key) is not None:
                h[key] = old[key]

    shots, shot_raw = get_shots(client, scorecard_id, detail.get("shotCounts"))
    record["shots"] = shots
    derived = derive_putts_from_shots(record, detail["scorecard"], shots)
    recompute_putt_and_gir_totals(record)

    raw_entry = {
        "activity_id": existing_round["activity_id"],
        "activity_meta": activity,
        "lookup": {"source": "refresh_details", "scorecard_id": scorecard_id},
        "scorecard_detail": detail,
        "shot_data_raw": shot_raw,
    }
    record["_refresh"] = {"scorecard_id": scorecard_id, "putts_from_shots": derived}
    return record, raw_entry


def main():
    parser = argparse.ArgumentParser(description="Re-fetch Garmin scorecard detail for stored rounds")
    parser.add_argument("--all", action="store_true", help="refresh every round, not just incomplete ones")
    parser.add_argument("--dry-run", action="store_true", help="only report what would be refreshed")
    parser.add_argument("--limit", type=int, default=None, help="stop after N rounds")
    parser.add_argument("--no-post", action="store_true", help="skip backfill_enrichment / strokes_gained afterwards")
    args = parser.parse_args()

    data = fr.load_existing_rounds()
    rounds = data["rounds"]

    # Normalise putt / GIR totals on every stored round (no API calls) so the
    # same coverage rules apply to rounds fetched before this script existed.
    normalised = sum(recompute_putt_and_gir_totals(r) for r in rounds)
    if normalised:
        print(f"Normalised putt/GIR totals on {normalised} round(s)")

    targets = [r for r in rounds if args.all or needs_refresh(r)]
    print(f"{len(rounds)} stored rounds, {len(targets)} to refresh")
    if not targets:
        if normalised and not args.dry_run:
            fr.save_rounds(data)
            if not args.no_post:
                here = Path(__file__).parent
                subprocess.run([sys.executable, str(here / "strokes_gained.py")], check=True)
        return

    client = fr.get_garmin_client()
    summaries = fetch_all_summaries(client)
    print(f"Garmin has {len(summaries)} scorecards")
    by_date = build_summary_index(summaries)

    used_ids = set()
    plan = []
    unmatched = []
    for r in sorted(targets, key=lambda x: x["date"]):
        s = match_summary(r, by_date, used_ids)
        if s is None:
            unmatched.append(r)
            continue
        used_ids.add(s["id"])
        plan.append((r, s))

    print(f"Matched {len(plan)} round(s) to scorecards; {len(unmatched)} unmatched")
    for r in unmatched:
        print(f"  unmatched: {r['date']} {r.get('course')} score={fr.safe_get(r, 'totals', 'score')}")
    if args.dry_run:
        for r, s in plan:
            print(f"  {r['date']} {r.get('course')} score={fr.safe_get(r, 'totals', 'score')} -> scorecard {s['id']}")
        return

    if args.limit:
        plan = plan[: args.limit]

    new_rounds, raw_entries = [], []
    stats = {"detail": 0, "shots": 0, "putts_shots": 0, "putts_field": 0, "fairways": 0}
    for i, (r, s) in enumerate(plan, 1):
        print(f"[{i}/{len(plan)}] {r['date']} {r.get('course')} score={fr.safe_get(r, 'totals', 'score')} scorecard={s['id']}")
        try:
            record, raw_entry = refresh_round(client, r, s)
        except RuntimeError as e:
            print(f"    giving up on this round: {e}")
            continue
        if record is None:
            print("    no detail returned")
            continue
        holes = record.get("holes") or []
        n_putt_field = sum(1 for h in holes if h.get("putts") is not None and h.get("putts_source") is None)
        n_putt_shots = record["_refresh"]["putts_from_shots"]
        n_fwy = sum(1 for h in holes if h.get("fairway_hit") is not None)
        stats["detail"] += 1
        stats["shots"] += bool(record.get("shots"))
        stats["putts_shots"] += bool(n_putt_shots)
        stats["putts_field"] += bool(n_putt_field)
        stats["fairways"] += bool(n_fwy)
        t = record.get("totals", {})
        print(
            f"    holes={len(holes)} shots={len(record.get('shots') or [])} "
            f"putts={t.get('putts')} (field:{n_putt_field} derived:{n_putt_shots}) "
            f"gir={t.get('gir_count')} fwy={t.get('fairways_hit')}/{t.get('fairways_possible')} "
            f"tee={record.get('tee_box')}"
        )
        record.pop("_refresh", None)
        new_rounds.append(record)
        raw_entries.append(raw_entry)

    if not new_rounds:
        print("Nothing refreshed.")
        return

    merged, added, updated = fr.merge_rounds(data, new_rounds)
    fr.save_rounds(merged)
    upsert_raw_dump(raw_entries)
    print(
        f"\nRefreshed {stats['detail']} round(s): {stats['shots']} with shots, "
        f"{stats['fairways']} with fairways, {stats['putts_field']} with recorded putts, "
        f"{stats['putts_shots']} with putts derived from the putter sensor."
    )

    if args.no_post:
        return
    here = Path(__file__).parent
    print("\nRunning backfill_enrichment...")
    subprocess.run([sys.executable, str(here / "backfill_enrichment.py")], check=True)
    print("\nRunning strokes_gained...")
    subprocess.run([sys.executable, str(here / "strokes_gained.py")], check=True)


if __name__ == "__main__":
    main()
