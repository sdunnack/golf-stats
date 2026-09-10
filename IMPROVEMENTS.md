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

## 2. Sticky hero header — DONE 2026-09-07

- [x] Header collapses to a slim 56px bar (logo + last synced) once scrolled past 120px, with
      hysteresis so it doesn't flicker at the threshold. `body.header-collapsed` overrides
      `--header-h`; hero content/image fade out.

## 3. Default filter — DONE 2026-09-07

- [x] New **Range** selector in the filter bar: Last 20 rounds (default, WHS window) /
      Last 50 / This year / All time / Custom dates. `baseFilteredRounds()` slices the last N
      or (This year) filters from Jan 1 of the current year; the date
      pickers are disabled unless "Custom dates" (editing one flips the selector to Custom).
      Note: in By Course view "Last N" still means the last N rounds *overall* then filtered to
      the course — fine for the home course, use "All time" for rarely-played courses.
- [x] `dateTicks()` is now span-aware: monthly labels ≤ 18 months, quarterly ≤ 48 months,
      yearly beyond that.

## 4. Split Club Data into its own panel

- [ ] Add a "Clubs" item to the left nav (Stats / Clubs / Insights / Training) and move the six
      club cards (box plot, rough-loss table, distance by lie, usage, driving distance trend)
      there. It's a different audience from scoring.
- [ ] Club labels: append `club_type_name` from shots.json (e.g. "Dream Machine (Driver)") on
      axis labels or hover.
- [ ] Filter club distance box plots for outliers: drop shots < 15th percentile per club for
      full-swing clubs, and any shot with distance 0.
- [x] Club box plot, rough-loss table and (existing) median summary are now ordered
      longest → shortest by median full-swing distance instead of shot-data insertion order.
      Club Usage stays sorted by shot count — that's its metric.

## 5. Small-sample noise

- [ ] Rough-vs-fairway table: require n ≥ 5 per lie per club; show n as a badge, grey out rows
      below threshold (currently shows rows with n=1 and negative "distance lost" from n=2).
- [ ] Course comparison: collapse courses with < 3 rounds into a "Played once or twice"
      group, or sort them to the bottom with a muted style.
- [ ] Records & Milestones: show n rounds behind the record.

## 6. Trend summary lines (`trendLine()` in app.js, and the course score chart) — DONE 2026-09-07

- [x] New `trendTail(valid, higherIsBetter)` helper compares first-N vs last-N average
      (N up to 5) instead of two single rounds. Used by `trendLine()`, the course score
      trend, and the SG trend (the three places that had inline "first to last" logic).
- [x] `higherIsBetter` flag threaded through `trendLine()`; GIR %, Fairways, Scrambling and
      Avg Drive pass `true`. Direction word ("improving"/"declining") now reflects whether the
      metric moved the good way; arrow reflects the raw direction. "flat" when |delta| < 0.05.

## 7. Strokes Gained framing

- [ ] Total SG (-12.4 "vs scratch") doesn't reconcile with an average of +28 vs par. Either
      scale categories so they sum to score − rating, or relabel as a relative category index
      and drop "vs scratch" from the copy.
- [ ] Remove or retune the "~15-cap avg" reference marker (user is a 21 index; benchmark
      should match).

## 8. Reduce text per card — DONE 2026-09-07

- [x] `tidyCardText()` in app.js tucks every card's `.chart-desc` behind a small (i) toggle
      next to the title (aria-expanded/controls wired up). The one-line `.chart-summary` stays
      visible. `#trend-tab-desc` is left alone — it's a live one-liner, not a static blurb.
- [x] `.panel-intro` paragraphs removed at load.

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
