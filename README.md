# Golf Stats Tracker

Personal golf stats dashboard — pulls data from Garmin Connect (including CT10 club sensor data) and visualizes it in a local JavaScript dashboard backed by JSON files you own.

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

On first run you'll be prompted for your Garmin Connect email and password. If Garmin requests multi-factor authentication, you'll also be prompted to enter the SMS code. Credentials are saved to `.garmin_creds.json` (chmod 600, owner read-only). OAuth session tokens are cached in `~/.garminconnect` and reused automatically on later runs. If tokens expire or are revoked, you'll be prompted to authenticate again.

## Launch dashboard

Serve from the project root (required — the dashboard uses `fetch()` for local JSON files):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/dashboard/ in any browser. Powered by [Plotly](https://plotly.com/javascript/) via CDN, no build step needed. Fully responsive — works on desktop and mobile (tested on iPhone 17 Pro Max).

## Dashboard overview

The dashboard has two views switchable via the pill tabs at the top. Filters (round length and date range) appear inline next to the tabs and apply to the active view.

### Overall

Aggregates across all courses in the current filter.

- **KPIs** — rounds played, courses, avg score, avg putts, GIR %, fairway %, handicap index
- **Your Goal** — set a target score or handicap index; shows progress and a projected date on your current trend (saved in localStorage)
- **Focus This Week** — your single biggest Strokes Gained opportunity with concrete practice drills
- **Insights** — auto-generated priority cards with severity badges flagging your weakest areas
- **Strokes Gained by Category** *(estimate)* — off-the-tee / approach / short game / putting on one scale vs a scratch baseline; the longest red bar is your biggest opportunity
- **Total Strokes Gained per Round** — how the gap to scratch has moved over time
- **Score / Putts / GIR % / Fairway % trends** — time-series lines with 3-round moving averages
- **Scrambling Trend** — up-and-down rate from off the green over time
- **Penalty Stroke Trend** — total penalties per round over time
- **Handicap Differential Trend** — per-round WHS differentials (normalised for course difficulty)
- **Scoring Distribution** — donut: Eagle / Birdie / Par / Bogey / Double / Triple+
- **Putting Distribution** — donut: 1-putt / 2-putt / 3-putt+
- **Scoring by Par Type** — avg strokes vs par for par-3 / par-4 / par-5 holes
- **Fairway Miss Direction** — fairway hit vs. missed left vs. missed right
- **Club Distance** — box plots of carry distance by club; distance by lie; club usage frequency
- **Drive Distance Trend** — avg tee-shot distance per round over time *(requires CT10 data)*
- **Course Comparison** — all played courses ranked by avg score, vs par, putts, GIR %, fairway %

### By Course

Focuses on a single course selected from the Course dropdown in the filter bar. All the same date/round-length filters apply.

- **KPIs** — rounds, avg score, avg vs par, best round, avg putts, GIR %, fairway %
- **Score & Score vs Par Over Visits** — dual-axis trend with 3-round moving average
- **Records & Milestones** — personal bests: best round, low vs par, best front/back 9, birdies, fewest putts, trajectory
- **Insights** — course-specific priority cards (penalty rate, scrambling %, putting, etc.)
- **Score by Hole** — best, average, and worst score per hole with par reference
- **GIR % by Hole** — green in regulation rate per hole
- **Putts by Hole** — best, average, and worst putts per hole
- **Penalties by Hole** — total penalty strokes by hole
- **Scoring by Par Type** — avg score vs par for par-3 / par-4 / par-5 holes at this course
- **Fairway Miss Direction** — miss tendency specific to this course
- **Scrambling Trend** — rolling scrambling % at this course over time
- **Penalty Stroke Trend** — rolling penalty rate at this course over time
- **Strokes Gained by Category** *(estimate)* — compare your SG profile here vs. your overall baseline
- **This Course vs Overall** — side-by-side comparison table across all key stats
- **Scoring Mix vs Overall** — grouped bar chart comparing result distribution here vs. everywhere
- **Scorecards** — full hole-by-hole scorecard for any round at this course

## After each round

```bash
./.venv/bin/python ingestion/fetch_rounds.py
```

The fetch script upserts by `activity_id`: new rounds are added, existing rounds with full detail are skipped, and rounds missing detail or newer schema fields are refreshed automatically.

## Refreshing incomplete rounds

If rounds show a score but no putts, fairways, penalties, or shots, the stored copy only has summary-level data. Pull the full scorecard detail and CT10 shots for those rounds:

```bash
./.venv/bin/python ingestion/refresh_details.py            # only rounds missing detail
./.venv/bin/python ingestion/refresh_details.py --dry-run  # show what would be refreshed
./.venv/bin/python ingestion/refresh_details.py --all      # re-fetch every round
```

Each stored round is matched to its Garmin scorecard by date and strokes. When Garmin has no putts on the scorecard but the putter sensor was on, putts are derived from the shot list (holes get `putts_source: "shots"`). Raw responses are cached in `data/raw_cache/` so re-runs are free; `backfill_enrichment.py` and `strokes_gained.py` run afterwards.

## Backfilling shot data

If you have a `raw_garmin_dump.json` from a previous `--dump-raw` run, you can re-parse shot/club data without making any API calls:

```bash
./.venv/bin/python ingestion/backfill_shots.py

# Or specify custom file paths:
./.venv/bin/python ingestion/backfill_shots.py --raw data/raw_garmin_dump.json --rounds data/rounds.json
```

## Course metadata

Garmin doesn't expose canonical course names or metadata (par, rating, slope) in its API, so you map raw Garmin course strings to course entries in `data/courses.json` yourself.

The easiest way to do this is to edit `data/courses.json` directly, adding entries with a `name`, `par`, `rating`, `slope`, `yards`, and an `aliases` array containing all the Garmin course strings that should resolve to that course.

## Strokes Gained & handicap index

`ingestion/strokes_gained.py` runs automatically at the end of `fetch_rounds.py` and can also be run standalone:

```bash
./.venv/bin/python ingestion/strokes_gained.py
```

It writes a per-round `strokes_gained` block and a rolling `hcap_index` into `data/rounds.json`.

**Why SG is an *estimate*.** True shot-by-shot Strokes Gained requires the complete tee-to-cup shot sequence for every hole. CT10 shot capture is incomplete for this account (most rounds record no putts), so per-shot SG isn't viable. Instead, each category is estimated from round-level stats against a fixed scratch-golfer baseline:

| Category | Derived from |
|---|---|
| Off the Tee | fairways-hit % |
| Approach | greens-in-reg % |
| Putting | total putts |
| Short Game | scrambling % |

Categories are computed independently and signed (positive = better than scratch). The baselines and per-stat weights are constants at the top of `strokes_gained.py` and easy to retune.

**Known limitation — missing putt shots.** Garmin/CT10 exports for this account drop most putt-level shots, so `data/shots.json` can't support full per-shot SG or putting-distance analysis. If future syncs start including putts (check `data/raw_garmin_dump.json` for `PUTT`/`Green` entries on every hole), the engine can be upgraded.

## Data fields

Each hole record in `data/holes.json` includes:
- `par` — hole par (enriched from `data/courses.json` when missing from Garmin)
- `score`, `putts`, `penalties`, `fairway_hit`, `sand_shots`
- `gir` — green in regulation (stored if Garmin provides it; otherwise derived as `(score - putts) <= (par - 2)`)
- `hole_handicap_index` — course handicap ranking for that hole (1–18)
- `handicap_score` — Garmin's per-hole handicap-adjusted score

## Files

| File | Purpose |
|---|---|
| `ingestion/fetch_rounds.py` | Pulls data from Garmin Connect API, writes to `data/` |
| `ingestion/refresh_details.py` | Re-fetches full scorecard detail + shots for rounds that only have summary data |
| `ingestion/backfill_shots.py` | Re-parses shot data from `data/raw_garmin_dump.json` without API calls |
| `ingestion/backfill_enrichment.py` | Enriches existing records from `data/courses.json` |
| `ingestion/strokes_gained.py` | Estimates per-round strokes gained by category + WHS handicap index |
| `ingestion/split_data.py` | Splits raw rounds data into `rounds.json`, `holes.json`, `shots.json` |
| `ingestion/garmin-download.js` | Browser console script for exporting data from Garmin Connect web |
| `dashboard/index.html` | Dashboard HTML |
| `dashboard/app.js` | All dashboard logic — data loading, chart rendering, filtering |
| `dashboard/styles.css` | Dashboard styles |
| `images/` | Golf GIFs used as the rotating hero banner |
| `data/rounds.json` | Per-round summary data including SG estimates and handicap index |
| `data/holes.json` | Per-hole detail for every round |
| `data/shots.json` | Per-shot data from CT10 sensors (where available) |
| `data/courses.json` | Course metadata and Garmin alias mappings |


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

Garmin doesn't expose the canonical course name or `global_course_id` in its API, so you need to map raw Garmin course strings to course metadata yourself.

**Easiest way — Course Manager tab in the dashboard.** Any unmatched course strings are surfaced in the **Manage** tab with a count badge. From there you can either map a Garmin string to an existing course or create a new course entry. Mappings are stored in `localStorage` and applied on the next page load — no file edits required.

**Manual way** — edit `data/courses.json` directly to add or update course entries (par, rating, slope, yardage, tee box, hole details, aliases).

Example ambiguity: the Garmin string `"Hebron"` could mean:

- Tallwood
- Blackledge - Gilead Highlands
- Blackledge - Anderson Glen

## Launch dashboard

Serve from the project root (required — the dashboard uses `fetch()` for local JSON files):

```bash
python3 -m http.server 8000
```

Then navigate to http://localhost:8000/dashboard/. Powered by Plotly via CDN.

## Dashboard overview

The dashboard has three top-level views switchable via the pill tabs at the top:

### By Course
Focuses on a single course selected from the sidebar dropdown.

- **Insights** — auto-generated cards flagging priority areas (e.g. penalty rate, scrambling %, putting) with severity badges and practice tips
- **Score & Score vs Par Over Visits** — combined trend chart with score (left axis) and strokes vs par (right axis), each with a 3-round moving average
- **Records & Milestones** — personal bests: best round, low vs par, best front/back 9, birdies, fewest putts, and trajectory trend
- **Score by Hole** — best, average, and worst score per hole with a par reference line
- **GIR % by Hole** — green in regulation rate per hole (derived from score/putts when not explicitly recorded)
- **Putts by Hole** — best, average, and worst putts per hole
- **Penalties by Hole** — total penalty strokes by hole
- **Par Type Breakdown** — average score vs par for par-3 / par-4 / par-5 holes
- **Fairway Miss Direction** — pie chart of fairways hit vs. missed left vs. missed right
- **Scrambling Trend** — rolling scrambling % (up-and-down from off the green) over time
- **Penalty Stroke Trend** — rolling penalty rate per round over time
- **This Course vs All Courses** — side-by-side comparison table across score, vs par, putts, GIR %, fairway %, 1-putt %, and 3-putt %
- **Scoring Mix vs All Courses** — grouped bar chart comparing result distribution (Eagle, Birdie, Par, Bogey, Double, Triple+)
- **Scorecards** — full hole-by-hole scorecard for any round at this course

- **Your Goal** — set a target round score or handicap index; the card shows progress and, on your current trend, a projected date to reach it. Saved in your browser (localStorage).
- **Focus This Week** — your single biggest opportunity (the weakest Strokes Gained category) with concrete practice drills.

### Overall
Aggregates across all courses in the current filter.

- **Insights** — same auto-generated insight cards as the By Course view, computed across all filtered rounds
- **Strokes Gained by Category** *(estimate)* — off-the-tee / approach / short-game / putting on one strokes scale vs a scratch baseline, so you can rank where you're losing the most. See the note below on how it's computed.
- **Handicap Index** — a WHS-style rolling index (best 8 of your most recent 20 differentials) shown as a headline KPI and used by the goal projection.
- **Score / Putts / GIR % / Fairway % trends** — time-series trend lines with moving averages
- **Scoring Distribution** — donut chart showing result mix across all rounds
- **Putting Distribution** — donut chart of 1-putt / 2-putt / 3-putt+ breakdown
- **Par Type Breakdown** — average score vs par for par-3 / par-4 / par-5 holes
- **Fairway Miss Direction** — pie chart of fairways hit vs. missed left vs. missed right
- **Scrambling Trend** — rolling scrambling % over time
- **Penalty Stroke Trend** — rolling penalty rate per round over time
- **Handicap Differential Trend** — per-round course handicap differentials plotted over time
- **Club Distance** — box plots of distance by club and lie type; club usage frequency
- **Drive Distance Trend** — average tee-shot distance per round over time (requires CT10 data)
- **Course Comparison** — table ranking all played courses by avg score, vs par, putts, GIR %, fairway %

### Manage (Course Manager)
Handles the mapping between raw Garmin course strings and the canonical course entries in `data/courses.json`. A badge on the tab shows how many unmatched strings exist.

- **Unmatched rounds** — lists every Garmin course string that doesn't resolve to a known course; for each you can either map it to an existing course entry or create a new course entry on the spot. Mappings are saved to `localStorage` (`golfstats.aliases` / `golfstats.new_courses`) and applied immediately on reload.
- **Known courses table** — lists all known courses with par, rating, slope, round count, and all active aliases.

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

## Strokes Gained & handicap index

`ingestion/strokes_gained.py` runs automatically at the end of `fetch_rounds.py`
(and can be run standalone with no API calls):

```bash
./.venv/bin/python ingestion/strokes_gained.py
```

It writes a per-round `strokes_gained` block and a rolling `hcap_index` into
`data/rounds.json`.

**Why Strokes Gained is an *estimate* here.** True shot-by-shot Strokes Gained
needs the complete tee-to-cup shot sequence for every hole. In this dataset the
CT10 shot capture is incomplete — most rounds record no putts at all, and only a
handful have every hole ending in a holed putt (see *Known limitation* below). So
per-shot SG isn't viable. Instead each category is estimated from round-level
stats against a fixed scratch-golfer baseline:

| Category   | Derived from        |
|------------|---------------------|
| Off the Tee | fairways-hit %     |
| Approach    | greens-in-reg %    |
| Putting     | total putts        |
| Short Game  | scrambling % (needs hole data) |

Categories are computed independently and signed (positive = better than
scratch); they are **not** forced to sum to score − rating. The value is the
*relative* picture — which part of your game is leaking the most strokes. The
baselines and per-stat weights are reference constants at the top of
`strokes_gained.py` and are easy to retune.

**Known limitation — missing putt shots.** Garmin/CT10 shot exports for this
account drop most putt-level shots, so `data/shots.json` can't support full
per-shot SG, shot dispersion maps, or putting-distance analysis. If future syncs
start including putts (check `data/raw_garmin_dump.json` for `PUTT`/`Green`
entries on every hole), the engine can be upgraded to true per-shot SG.

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
| `ingestion/strokes_gained.py` | Estimates per-round strokes gained by category + WHS handicap index, writes to `data/rounds.json` |
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
