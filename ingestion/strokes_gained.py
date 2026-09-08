#!/usr/bin/env python3
"""
strokes_gained.py
One-shot enrichment: estimate Strokes Gained by category per round, plus a
WHS-style handicap index per round. No API calls — reads the existing data
files and writes the results back into rounds.json.

Strokes Gained (simplified, estimate)
-------------------------------------
True shot-by-shot Strokes Gained needs the full tee-to-cup shot sequence for
every hole. This dataset's CT10 shot capture is incomplete (most rounds record
no putts), so per-shot SG is not viable. Instead we estimate SG **by category**
from round-level stats against a fixed scratch-golfer baseline:

    off_tee    from fairways-hit %      (vs BASE_FWY)
    approach   from greens-in-reg %     (vs BASE_GIR)
    putting    from total putts         (vs BASE_PUTTS)
    short_game from scrambling %        (vs BASE_SCR)   — needs hole data

Each category is computed independently and signed so positive = better than
scratch. They are NOT forced to sum to score − rating; the value is the
*relative* picture (which part of the game is leaking the most strokes). A
category is omitted when its source stat is unavailable. This is a deliberate
estimate — see the per-shot note above for why.

Handicap index
--------------
Per 18-hole round with rating + slope we compute a score differential and a
rolling WHS-style index (best N of the most recent 20, with the low-count
adjustment table). Written to round["hcap_index"].

Usage:
    python strokes_gained.py
    python strokes_gained.py --rounds rounds.json --holes holes.json --courses courses.json
"""

import argparse
import json
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent / "data"
ROUNDS_FILE = BASE_DIR / "rounds.json"
HOLES_FILE = BASE_DIR / "holes.json"
COURSES_FILE = BASE_DIR / "courses.json"

# ---------------------------------------------------------------------------
# Simplified SG model — scratch-golfer baselines (per 18 holes) and the strokes
# each stat unit is worth. Reference constants, not fitted to this user; tuned
# so a typical amateur profile yields a believable category breakdown with
# approach as the dominant leak. Easy to retune in one place.
# ---------------------------------------------------------------------------
BASE_FWY = 60.0     # % fairways hit
BASE_GIR = 64.0     # % greens in regulation
BASE_PUTTS = 30.0   # total putts (18 holes)
BASE_SCR = 58.0     # % scrambling (up-and-down after missed GIR)

DRIVING_HOLES = 14  # ~holes per 18 with a driver/3w tee shot
GREEN_HOLES = 18

W_FWY = 0.45        # strokes per fairway vs baseline
W_GIR = 1.00        # strokes per green vs baseline
W_PUTT = 0.60       # strokes per putt vs baseline
W_SCR = 0.50        # strokes per successful scramble vs baseline
MIN_PUTT_HOLES = 5  # holes with a putt count needed before estimating putting SG


def _g(round_rec, key):
    return (round_rec.get("totals") or {}).get(key)


def derive_gir(hole):
    """Match the dashboard: GIR when explicit, else (score - putts) <= (par - 2)."""
    if hole.get("gir") is not None:
        return hole["gir"]
    par, score, putts = hole.get("par"), hole.get("score"), hole.get("putts")
    if None in (par, score, putts):
        return None
    return (score - putts) <= (par - 2)


def scrambling_pct(holes):
    """% of missed-GIR holes saved for par-or-better. None if not computable."""
    missed = saved = 0
    for h in holes:
        gir = derive_gir(h)
        par, score = h.get("par"), h.get("score")
        if gir is False and par is not None and score is not None:
            missed += 1
            if score - par <= 0:
                saved += 1
    if not missed:
        return None, 0
    return saved / missed * 100.0, missed


def compute_simplified_sg(round_rec, holes):
    """Return the category SG block for a round, or None if nothing computable."""
    holes_played = _g(round_rec, "holes_played") or 18
    scale = holes_played / 18.0
    block = {"off_tee": None, "approach": None, "putting": None, "short_game": None}

    fwy = _g(round_rec, "fairway_pct")
    if fwy is not None:
        block["off_tee"] = round((fwy - BASE_FWY) / 100.0 * DRIVING_HOLES * scale * W_FWY, 2)

    gir = _g(round_rec, "gir_pct")
    if gir is not None:
        block["approach"] = round((gir - BASE_GIR) / 100.0 * GREEN_HOLES * scale * W_GIR, 2)

    # Putting: use the holes that actually have a putt count so a round with
    # partial putt data (e.g. sensor dropouts) is scaled by its own coverage
    # instead of by holes played. Needs a handful of holes to be meaningful.
    putt_holes = [h for h in holes if h.get("putts") is not None and h.get("score") is not None]
    if len(putt_holes) >= MIN_PUTT_HOLES:
        putts = sum(h["putts"] for h in putt_holes)
        putt_scale = len(putt_holes) / 18.0
        block["putting"] = round((BASE_PUTTS * putt_scale - putts) * W_PUTT, 2)

    scr, missed = scrambling_pct(holes)
    if scr is not None:
        block["short_game"] = round((scr - BASE_SCR) / 100.0 * missed * W_SCR, 2)

    present = [v for v in block.values() if v is not None]
    if not present:
        return None
    block["total"] = round(sum(present), 2)
    block["basis"] = "estimate"
    return block


# ---------------------------------------------------------------------------
# Course rating/slope lookup (handicap fallback when round lacks tee rating)
# ---------------------------------------------------------------------------
def load_course_lookup(courses_file):
    by_id, by_name = {}, {}
    if not courses_file.exists():
        return by_id, by_name
    with open(courses_file) as f:
        data = json.load(f)
    for c in data.get("courses", []):
        meta = {"rating": c.get("rating"), "slope": c.get("slope")}
        if c.get("garmin_course_id") is not None:
            by_id[int(c["garmin_course_id"])] = meta
        if c.get("name"):
            by_name[c["name"].lower()] = meta
        for a in c.get("aliases") or []:
            by_name[a.lower()] = meta
    return by_id, by_name


def find_rating_slope(round_rec, by_id, by_name):
    rating, slope = round_rec.get("tee_box_rating"), round_rec.get("tee_box_slope")
    if rating and slope:
        return rating, slope
    cid = round_rec.get("course_id")
    meta = None
    if cid is not None and int(cid) in by_id:
        meta = by_id[int(cid)]
    else:
        nm = (round_rec.get("course") or "").lower()
        meta = by_name.get(nm)
        if meta is None:
            for k, m in by_name.items():
                if k and (k in nm or nm in k):
                    meta = m
                    break
    if meta:
        rating = rating or meta.get("rating")
        slope = slope or meta.get("slope")
    return rating, slope


# ---------------------------------------------------------------------------
# WHS-style handicap index
# (num_differentials) -> (count_of_lowest_used, adjustment)
# ---------------------------------------------------------------------------
WHS_TABLE = {
    3: (1, -2.0), 4: (1, -1.0), 5: (1, 0.0), 6: (2, -1.0),
    7: (2, 0.0), 8: (2, 0.0), 9: (3, 0.0), 10: (3, 0.0), 11: (3, 0.0),
    12: (4, 0.0), 13: (4, 0.0), 14: (4, 0.0), 15: (5, 0.0), 16: (5, 0.0),
    17: (6, 0.0), 18: (6, 0.0), 19: (7, 0.0), 20: (8, 0.0),
}


def whs_index(differentials):
    recent = differentials[-20:]
    n = len(recent)
    if n < 3:
        return None
    count, adj = WHS_TABLE[min(n, 20)]
    lowest = sorted(recent)[:count]
    return round(sum(lowest) / len(lowest) + adj, 1)


def annotate_handicap(rounds, by_id, by_name):
    ordered = sorted(rounds, key=lambda r: r.get("date") or "")
    diffs = []
    for r in ordered:
        r.pop("hcap_index", None)
        if _g(r, "holes_played") != 18 or not _g(r, "score"):
            continue
        rating, slope = find_rating_slope(r, by_id, by_name)
        if not rating or not slope:
            continue
        diffs.append((_g(r, "score") - rating) * 113.0 / slope)
        idx = whs_index(diffs)
        if idx is not None:
            r["hcap_index"] = idx


# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Estimate strokes gained + handicap index")
    p.add_argument("--rounds", type=Path, default=ROUNDS_FILE)
    p.add_argument("--holes", type=Path, default=HOLES_FILE)
    p.add_argument("--courses", type=Path, default=COURSES_FILE)
    args = p.parse_args()

    with open(args.rounds) as f:
        rounds_data = json.load(f)
    holes_by_round = {}
    if args.holes.exists():
        with open(args.holes) as f:
            for h in json.load(f).get("holes", []):
                holes_by_round.setdefault(h.get("activity_id"), []).append(h)

    by_id, by_name = load_course_lookup(args.courses)

    sg_rounds = 0
    for r in rounds_data["rounds"]:
        r.pop("strokes_gained", None)
        block = compute_simplified_sg(r, holes_by_round.get(r["activity_id"], []))
        if block:
            r["strokes_gained"] = block
            sg_rounds += 1

    annotate_handicap(rounds_data["rounds"], by_id, by_name)
    hcap_rounds = sum(1 for r in rounds_data["rounds"] if r.get("hcap_index") is not None)
    latest = next((r.get("hcap_index") for r in
                   sorted(rounds_data["rounds"], key=lambda x: x.get("date") or "", reverse=True)
                   if r.get("hcap_index") is not None), None)

    rounds_data["last_updated"] = datetime.now().isoformat()
    with open(args.rounds, "w") as f:
        json.dump(rounds_data, f, indent=2, default=str)

    print(f"Strokes-gained estimate written for {sg_rounds} round(s).")
    print(f"Handicap index computed for {hcap_rounds} round(s). Latest index: {latest}")


if __name__ == "__main__":
    main()
