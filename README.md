# Garmin Golf Tracker

Personal golf stats dashboard — pulls data from Garmin Connect (including CT10 club sensor data)
and visualizes it in a local JavaScript dashboard stored in a JSON file you own.

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

## Launch dashboard

Open `dashboard/index.html` in a browser, or serve from the project root:

```bash
python -m http.server
```

Then navigate to http://localhost:8000/dashboard/. Powered by Plotly via CDN.

The dashboard has four tabs:

- **📈 Trends** — score, putts, GIR %, and fairway % over time
- **🕳️ Holes** — per-hole performance across all rounds
- **🏌️ Club Data** — shot-by-shot club distances (requires CT10 sensors)
- **📋 Scorecards** — individual round scorecards

Filters let you narrow by course, round length (9 or 18 holes), and date range.

## After each round

```bash
./.venv/bin/python ingestion/fetch_rounds.py
```

The fetch script upserts by `activity_id`:

- New rounds are added.
- Existing rounds with full detail are skipped.
- Existing rounds missing detail or newer schema fields are refreshed automatically.

You can set this up as a cron job or just run it manually.

## Backfilling shot data

If you have a `raw_garmin_dump.json` from a previous `--dump-raw` run, you can re-parse
shot/club data into `rounds.json` without making any API calls:

```bash
./.venv/bin/python ingestion/backfill_shots.py

# Or specify custom file paths:
./.venv/bin/python ingestion/backfill_shots.py --raw data/raw_garmin_dump.json --rounds data/rounds.json
```

This is useful after updating the shot parsing logic to pick up newly supported fields.

## Data fields

Each hole record in `data/rounds.json` now includes handicap-aware fields:
- `hole_handicap_index` (1-18 course handicap ranking for that hole)
- `handicap_score` (Garmin's per-hole handicap-adjusted score)

These are useful for analysis like performance on harder (`1-6`) vs easier (`13-18`) holes.

## Files

| File | Purpose |
|------|---------|
| `ingestion/fetch_rounds.py` | Pulls data from Garmin Connect API, writes to `data/rounds.json` |
| `ingestion/backfill_shots.py` | Re-parses shot data from `data/raw_garmin_dump.json` into `data/rounds.json` without API calls. Helpful if you have CT10 sensors and want club data. |
| `ingestion/garmin-download.js` | Browser console script for exporting data from Garmin Connect web |
| `dashboard/index.html` / `dashboard/app.js` / `dashboard/styles.css` | JavaScript dashboard (no server required) |
| `data/rounds.json` | Your data store (committed to repo — powers GitHub Pages) |
| `.garmin_creds.json` | Saved credentials (git-ignored, chmod 600) |
| `data/raw_garmin_dump.json` | Raw API responses (git-ignored — only created with `--dump-raw`) |

## Field mapping

Garmin's internal API field names aren't documented. If stats show as missing after
your first run:

1. Run `./.venv/bin/python ingestion/fetch_rounds.py --dump-raw`
2. Open `data/raw_garmin_dump.json` and find `scorecard_detail` for a round
3. Look at the actual field names in the `holes` and `shots` arrays
4. Update `parse_hole()` and `parse_shot()` in `ingestion/fetch_rounds.py` accordingly

`--dump-raw` now writes a debug entry for every processed activity (including lookup metadata
and fetch errors), even when scorecard detail is missing.

Common variations seen in the wild:
- Holes: `holeNumber` vs `number`, `strokes` vs `totalStrokes`
- GIR: `greenInRegulation` vs `gir` (bool)
- Shots: `distanceFromPreviousShot` vs `shotDistance`, `clubType` vs `club`

## CT10 club data

Shot-by-shot club data (club name, distance, lie) appears in the **Club Data** tab.
This only populates if you have CT10 sensors paired and data synced through the Garmin Golf app.
If the tab shows empty, check `data/raw_garmin_dump.json` for a `shots` or `shotData` array.

## .gitignore

```
data/raw_garmin_dump.json
.garmin_creds.json
.venv/
__pycache__/
```
