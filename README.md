# Golf Stats Tracker

Personal golf stats dashboard — pulls data from Garmin Connect (including CT10 club sensor data)
and visualizes it in a local JavaScript dashboard backed by JSON files you own.

## Setup

```bash
# Create and activate a virtual environment (recommended)
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## First run

```bash
# Fetch your last 30 days of rounds
./.venv/bin/python ingestion/fetch_rounds.py

# Or backfill history (e.g. last 2 years)
./.venv/bin/python ingestion/fetch_rounds.py --days 730

# First time? Also dump raw API responses so you can verify field names
./.venv/bin/python ingestion/fetch_rounds.py --days 90 --dump-raw
```

On first run you'll be prompted for your Garmin Connect email and password.
If Garmin requests multi-factor authentication, you'll also be prompted to enter the SMS code.
Credentials are saved to `.garmin_creds.json` (chmod 600, owner read-only).
OAuth session tokens are cached in `~/.garminconnect` and reused automatically on later runs.
If tokens expire or are revoked, you'll be prompted to authenticate again. MFA is supported.

## Backfill Course Data

Garmin doesn't have all the updated tee boxes present, so you will need to update `data/courses.json` manually to get the most accurate stats. Also, the Garmin pull doesn't send over the course name or `global_course_id`, so we have to fill that ourselves. Still figuring out the best way to represent multiple courses/town and tracks/course.

Example: "Hebron" could mean:

- Tallwood
- Blackledge - Gilead Highlands
- Blackledge - Anderson Glen

Future: Will try to automate this in the future, but for now this is fine.

## Launch dashboard

Serve from the project root (required — the dashboard uses `fetch()` for local JSON files):

```bash
python3 -m http.server 8000
```

Then navigate to http://localhost:8000/dashboard/. Powered by Plotly via CDN.

## Dashboard overview

The dashboard has two top-level views switchable via the pill tabs at the top:

### By Course
Focuses on a single course selected from the sidebar dropdown.

- **Score & Score vs Par Over Visits** — combined trend chart with score (left axis) and strokes vs par (right axis), each with a 3-round moving average
- **Records & Milestones** — personal bests: best round, low vs par, best front/back 9, birdies, fewest putts, and trajectory trend
- **Score by Hole** — best, average, and worst score per hole with a par reference line
- **GIR % by Hole** — green in regulation rate per hole (derived from score/putts when not explicitly recorded)
- **Putts by Hole** — best, average, and worst putts per hole
- **Penalties by Hole** — total penalty strokes by hole
- **This Course vs All Courses** — side-by-side comparison table across score, vs par, putts, GIR %, fairway %, 1-putt %, and 3-putt %
- **Scoring Mix vs All Courses** — grouped bar chart comparing result distribution (Eagle, Birdie, Par, Bogey, Double, Triple+)
- **Scorecards** — full hole-by-hole scorecard for any round at this course

### Overall
Aggregates across all courses in the current filter.

- **Score / Putts / GIR % / Fairway % trends** — time-series trend lines with moving averages
- **Scoring Distribution** — donut chart showing result mix across all rounds
- **Putting Distribution** — donut chart of 1-putt / 2-putt / 3-putt+ breakdown
- **Club Distance** — box plots of distance by club and lie type; club usage frequency
- **Drive Distance Trend** — average tee-shot distance per round over time (requires CT10 data)
- **Course Comparison** — table ranking all played courses by avg score, vs par, putts, GIR %, fairway %

### Filters (sidebar)
- **Course** — select which course to focus on in the By Course view
- **Round Length** — filter to 18-hole, 9-hole, or all rounds
- **Date range** — from/to date pickers
  
Future: will look to add support for tee boxes, as I sometimes need to play
a different tee, but not enough to worry about now.

## After each round

```bash
./.venv/bin/python ingestion/fetch_rounds.py
```

The fetch script upserts by `activity_id`:

- New rounds are added.
- Existing rounds with full detail are skipped.
- Existing rounds missing detail or newer schema fields are refreshed automatically.

## Backfilling shot data

If you have a `raw_garmin_dump.json` from a previous `--dump-raw` run, you can re-parse
shot/club data without making any API calls:

```bash
./.venv/bin/python ingestion/backfill_shots.py

# Or specify custom file paths:
./.venv/bin/python ingestion/backfill_shots.py --raw data/raw_garmin_dump.json --rounds data/rounds.json
```

## Data fields

Each hole record in `data/holes.json` includes:
- `par` — hole par (enriched from `data/courses.json` when missing from Garmin)
- `score`, `putts`, `penalties`, `fairway_hit`, `sand_shots`
- `gir` — green in regulation (stored if Garmin provides it; otherwise derived as `(score - putts) <= (par - 2)`)
- `hole_handicap_index` — course handicap ranking for that hole (1–18)
- `handicap_score` — Garmin's per-hole handicap-adjusted score

## Files

| File | Purpose |
|------|---------|
| `ingestion/fetch_rounds.py` | Pulls data from Garmin Connect API, writes to `data/` |
| `ingestion/backfill_shots.py` | Re-parses shot data from `data/raw_garmin_dump.json` without API calls |
| `ingestion/backfill_enrichment.py` | Enriches existing records from `data/courses.json` |
| `ingestion/split_data.py` | Splits raw rounds data into separate `rounds.json`, `holes.json`, `shots.json` files |
| `ingestion/garmin-download.js` | Browser console script for exporting data from Garmin Connect web |
| `dashboard/index.html` | Dashboard HTML shell |
| `dashboard/app.js` | All dashboard logic — data loading, chart rendering, filtering |
| `dashboard/styles.css` | Dashboard styles (Inter font, dark header, card layout) |
| `data/rounds.json` | Round-level data (score, putts, GIR %, fairway %) |
| `data/holes.json` | Hole-level data for all rounds |
| `data/shots.json` | Shot-level data (club, distance, lie) — requires CT10 sensors |
| `data/courses.json` | Course metadata: par, rating, slope, yardage, hole pars |
| `.garmin_creds.json` | Saved credentials (git-ignored, chmod 600) |
| `data/raw_garmin_dump.json` | Raw API responses (git-ignored — only created with `--dump-raw`) |

## Field mapping

Garmin's internal API field names aren't documented. If stats show as missing after
your first run:

1. Run `./.venv/bin/python ingestion/fetch_rounds.py --dump-raw`
2. Open `data/raw_garmin_dump.json` and find `scorecard_detail` for a round
3. Look at the actual field names in the `holes` and `shots` arrays
4. Update `parse_hole()` and `parse_shot()` in `ingestion/fetch_rounds.py` accordingly

Common variations seen in the wild:
- Holes: `holeNumber` vs `number`, `strokes` vs `totalStrokes`
- GIR: `greenInRegulation` vs `gir` (bool)
- Shots: `distanceFromPreviousShot` vs `shotDistance`, `clubType` vs `club`

## CT10 club data

Shot-by-shot club data (club name, distance, lie) appears in the **Club Distance** charts.
This only populates if you have CT10 sensors paired and data synced through the Garmin Golf app.
If charts show empty, check `data/raw_garmin_dump.json` for a `shots` or `shotData` array.

## .gitignore

```
data/raw_garmin_dump.json
.garmin_creds.json
.venv/
__pycache__/
```
