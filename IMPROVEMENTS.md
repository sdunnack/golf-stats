# Dashboard Improvements Backlog

Findings from a review on 2026-09-07. Ordered by impact. Check items off as they land.
Supersedes the remaining items in `golf-stats-cleanup.md` (trend tabs and number
formatting from that plan are already done; the rest is folded in below).

---

## 1. Missing data shown as zero (highest impact) — FIXED 2026-09-07

**Root cause:** the old `--fix-incomplete` pass in `fetch_rounds.py` used the Garmin golf
*summary* list as if it were the scorecard detail. The summary only has strokes per hole, so
~118 rounds were saved with no putts / fairways / penalties / tee box / shots, and their
`gir_pct` was written as `0.0` instead of `null`. That produced the 3.8% GIR KPI, the -11.5
SG Approach on every one of those rounds, and the "Approach is your biggest leak" advice.

**What was done:**

- [x] New `ingestion/refresh_details.py` matches each stored round to its Garmin scorecard by
      date + strokes, fetches the real detail and per-hole shots, and merges them in. Where the
      scorecard has no putts but the putter sensor was on, putts are derived from PUTT shots.
- [x] `fetch_rounds.py`: `--fix-incomplete` now uses the summary only for the scorecard ID and
      fetches the real detail; totals store `null` (not 0) for putts/GIR when nothing was
      recorded; a round-level GIR % needs at least 5 known holes; total putts only when every
      played hole has a count.
- [x] `strokes_gained.py`: putting SG scales by holes that actually have putt data.

Coverage after the refresh (217 rounds):

| Year | Rounds | With putts | With fairways | With CT10 shots |
|------|--------|------------|---------------|-----------------|
| 2023 | 55     | 55         | 54            | 55              |
| 2024 | 65     | 42         | 65            | 65              |
| 2025 | 59     | 55         | 59            | 59              |
| 2026 | 38     | 38         | 38            | 38              |

Still missing (Garmin genuinely has no putt data): 23 rounds in 2024 and 4 in 2025 where the
putter sensor was off and no putts were entered.

- [ ] Show "based on N rounds" under every KPI / chart summary that depends on hole detail.
- [ ] Garmin also has 43 scorecards from 2021–2022 with no matching activity. Importing them
      would need a synthetic activity ID (e.g. `sc<scorecard_id>`) and the date taken from the
      UTC `startTime`.

## 2. Sticky hero header

- [ ] Header is `position: sticky` and 200px tall; it eats ~20% of a 900px viewport on every
      scroll. Collapse to a slim bar (logo + last updated) once scrolled, or make it
      non-sticky.

## 3. Default filter

- [ ] Default to the **last 20 rounds** (matches the WHS handicap window) instead of all-time.
      Keep "All time" and the date pickers as options.
- [ ] Date axis: quarterly or yearly tick labels when the span is > 12 months (currently every
      month across 3 years).

## 4. Split Club Data into its own panel

- [ ] Add a "Clubs" item to the left nav (Stats / Clubs / Insights / Training) and move the six
      club cards (box plot, rough-loss table, distance by lie, usage, driving distance trend)
      there. It's a different audience from scoring.
- [ ] Club labels: append `club_type_name` from shots.json (e.g. "Dream Machine (Driver)") on
      axis labels or hover.
- [ ] Filter club distance box plots for outliers: drop shots < 15th percentile per club for
      full-swing clubs, and any shot with distance 0.

## 5. Small-sample noise

- [ ] Rough-vs-fairway table: require n ≥ 5 per lie per club; show n as a badge, grey out rows
      below threshold (currently shows rows with n=1 and negative "distance lost" from n=2).
- [ ] Course comparison: collapse courses with < 3 rounds into a "Played once or twice"
      group, or sort them to the bottom with a muted style.
- [ ] Records & Milestones: show n rounds behind the record.

## 6. Trend summary lines (`trendLine()` in app.js, and the course score chart)

- [ ] Replace "first to last" (two single rounds) with first-5 avg vs last-5 avg.
- [ ] Add a per-metric `higherIsBetter` flag. Driving Distance currently says
      "Best 118 · Worst 164.7 · ↓ improving" when distance went down.

## 7. Strokes Gained framing

- [ ] Total SG (-12.4 "vs scratch") doesn't reconcile with an average of +28 vs par. Either
      scale categories so they sum to score − rating, or relabel as a relative category index
      and drop "vs scratch" from the copy.
- [ ] Remove or retune the "~15-cap avg" reference marker (user is a 21 index; benchmark
      should match).

## 8. Reduce text per card

- [ ] Move the `.chart-desc` paragraph behind an (i) icon / tooltip on every card. Keep the
      one-line `.chart-summary`, which is the actual insight.
- [ ] Remove the `.panel-intro` paragraphs (they explain the tabs on every panel).

## 9. Duplicate / redundant cards (candidates to cut or merge)

- [ ] Focus This Week and the top Insight card say the same thing; merge into one.
- [ ] Shot Distance by Lie overlaps the rough-loss table.
- [ ] Scoring Mix vs Overall repeats the Scoring donut.
- [ ] Course-view SG chart is nearly identical to the overall SG chart; keep only the
      "This course vs overall" table row for SG.

## 10. KPI row

- [ ] Replace "Courses" with something performance-related (Last round, Best round, or Avg vs
      Par).
- [ ] Two-tier header from the old plan: primary (Avg Score, Handicap Idx, GIR %, Avg Putts)
      large; secondary (Rounds, Fairway %, etc.) as a small metadata line.

## 11. By Course page

- [ ] Ringer table sits above the KPIs on the home course and pushes them below the fold; move
      it below the Overview section or make it collapsible.
- [ ] Collapse "Per-Hole Breakdown" and "Advanced Stats" sections by default.
- [ ] Scorecard selector has 87 entries; group by year or default to the latest round with a
      prev/next control.

## 12. Layout (from the old cleanup plan)

- [ ] Pair Scoring Summary + Putting Summary side by side (done), same for Club Usage +
      Distance Distribution once moved to the Clubs panel.
- [ ] Keep Course Comparison anchored at the bottom of the Stats panel.

---

## Ingestion

- [x] Hole-level putts/fairways/penalties recovered for the rounds that only had summary data
      (see section 1). Endpoints that work: `get_golf_summary` (list), `get_golf_scorecard`
      (detail, wrapped in `scorecardDetails[0]` + `courseSnapshots` with `holePars`), and
      `get_golf_shot_data` called one hole at a time (the comma-separated default is rejected).
- [ ] Shots with club id `0` / no club type, and shots with no lie or shot type, are left as-is.
