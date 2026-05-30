// ── Constants ─────────────────────────────────────────────────────────────────
const MA_WINDOW = 3;
const C_GREEN   = '#15803d';
const C_TEAL    = '#0d9488';
const C_BLUE    = '#3b82f6';
const C_NAVY    = '#1e3a5f';
const C_ORANGE  = '#f97316';
const C_RED     = '#ef4444';
const C_CRIMSON = '#7f1d1d';
const C_PURPLE  = '#a855f7';
const C_GRAY    = '#64748b';
const C_LIME    = '#84cc16';
const CHART_H   = 240;
const HOME_COURSE = 'Manchester Country Club';
const LS_KEY = 'golfstats.course';

const AX = { gridcolor: '#f1f5f9', linecolor: '#e2e8f0', zerolinecolor: '#e2e8f0' };
const BASE_LAYOUT = {
  margin: { l: 44, r: 10, t: 6, b: 40 },
  paper_bgcolor: 'transparent',
  plot_bgcolor:  'transparent',
  font: { family: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', size: 11, color: '#64748b' },
  xaxis: AX,
  yaxis: { ...AX },
  showlegend: true,
  legend: { orientation: 'h', y: -0.22, font: { size: 11 } },
};
const CFG = { responsive: true, displayModeBar: false };

function L(overrides = {}) {
  return Object.assign({}, BASE_LAYOUT, { height: CHART_H }, overrides);
}

// ── Data state ────────────────────────────────────────────────────────────────
let allRounds = [], allHoles = [], allShots = [];
let courseMeta = {};          // canonical name -> { par, rating, slope, yards, tee_box, holePar: {n: par}, holeYd, holeHcp }
let lastUpdated = null;
let shotsLoaded = false;
let shotsLoading = null;
let mode = 'course';
let selectedCourse = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const avg    = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const stddev = arr => { if (arr.length < 2) return null; const m=avg(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length); };
const sum    = arr => arr.reduce((a, b) => a + b, 0);
const r1     = x   => x != null ? Math.round(x * 10) / 10 : null;
const fmt    = (x, sfx = '') => x != null ? `${r1(x)}${sfx}` : '—';
const fmtSigned = x => x == null ? '—' : (x > 0 ? `+${r1(x)}` : `${r1(x)}`);
const fmtBool = v => v === true ? '✓' : v === false ? '✗' : '—';

function movingAvg(vals, w) {
  return vals.map((_, i) => {
    const slice = vals.slice(Math.max(0, i - w + 1), i + 1).filter(v => v != null);
    return slice.length >= 2 ? avg(slice) : null;
  });
}

function noData(id, msg = 'Not enough data') {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div class="no-data">${msg}</div>`;
}

// Plot wrapper: clears any prior content (e.g. a leftover no-data note) so a
// chart that toggles between "no data" and a real plot never leaves residue.
function plotClear(id, traces, layout, cfg = CFG) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (el) el.innerHTML = '';
  return Plotly['newPlot'](id, traces, layout, cfg);
}
function setSummary(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function catAxis(overrides = {}) { return { ...AX, type: 'category', ...overrides }; }

// Format date strings (YYYY-MM-DD) as sparse tick labels.
// Shows the month abbreviation only the first time each month appears.
// Appends ''YY the first time a new year appears.
const MONTH_ABB = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dateTicks(dates) {
  let lastMonthKey = null, lastYear = null;
  return dates.map(d => {
    const [y, m] = d.split('-');
    const key = `${y}-${m}`;
    if (key === lastMonthKey) return '';
    lastMonthKey = key;
    const label = MONTH_ABB[+m - 1];
    if (y !== lastYear) { lastYear = y; return `${label} '${y.slice(2)}`; }
    return label;
  });
}

// ── Load & parse ──────────────────────────────────────────────────────────────
async function loadData() {
  const [roundsRes, holesRes, coursesRes] = await Promise.all([
    fetch('../data/rounds.json'),
    fetch('../data/holes.json'),
    fetch('../data/courses.json'),
  ]);
  const [roundsData, holesData, coursesData] = await Promise.all([
    roundsRes.json(), holesRes.json(), coursesRes.json(),
  ]);
  lastUpdated = roundsData.last_updated || null;

  // Build course metadata + an alias index for matching round.course -> canonical name
  const aliasIndex = {}; // lowercased name/alias -> canonical name
  for (const c of coursesData.courses || []) {
    const holePar = {}, holeYd = {}, holeHcp = {};
    for (const h of c.holes || []) {
      if (h.par     != null) holePar[h.hole] = h.par;
      if (h.yardage != null) holeYd[h.hole]  = h.yardage;
      if (h.handicap!= null) holeHcp[h.hole] = h.handicap;
    }
    courseMeta[c.name] = {
      name: c.name, par: c.par, rating: c.rating, slope: c.slope,
      yards: c.yards, tee_box: c.tee_box, holePar, holeYd, holeHcp,
    };
    aliasIndex[c.name.toLowerCase()] = c.name;
    for (const a of c.aliases || []) aliasIndex[a.toLowerCase()] = c.name;
  }

  // Resolve a round's course string to a canonical metadata entry
  const resolveMeta = courseStr => {
    if (!courseStr) return null;
    const key = courseStr.toLowerCase();
    if (aliasIndex[key]) return courseMeta[aliasIndex[key]];
    // loose contains-match against aliases
    for (const [alias, canon] of Object.entries(aliasIndex)) {
      if (key.includes(alias) || alias.includes(key)) return courseMeta[canon];
    }
    return null;
  };

  const holesById = {};
  for (const h of holesData.holes || []) (holesById[h.activity_id] ||= []).push(h);

  for (const r of roundsData.rounds) {
    const t = r.totals || {};
    const meta = resolveMeta(r.course);
    allRounds.push({
      activity_id:       r.activity_id,
      date:              r.date,
      course:            r.course || 'Unknown',
      score:             t.score            ?? null,
      putts:             t.putts            ?? null,
      gir_count:         t.gir_count        ?? null,
      gir_pct:           t.gir_pct          ?? null,
      fairways_hit:      t.fairways_hit     ?? null,
      fairways_possible: t.fairways_possible?? null,
      fairway_pct:       t.fairway_pct      ?? null,
      holes_played:      t.holes_played     ?? null,
    });

    for (const h of holesById[r.activity_id] || []) {
      if (h.score == null) continue;
      // Enrich par/yardage from courses.json when missing on the hole record
      const par = h.par ?? meta?.holePar[h.hole] ?? null;
      const yd  = h.yardage ?? meta?.holeYd[h.hole] ?? null;
      // Derive GIR from score/putts/par when not explicitly recorded.
      // GIR = reached green in (par - 2) strokes or fewer, i.e. (score - putts) <= (par - 2).
      // This correctly handles 3-putt pars: e.g. par 4, score 4, putts 3 → 1 approach ≤ 2 regulation → GIR.
      let gir = h.gir;
      if (gir == null && par != null && h.score != null && h.putts != null) {
        gir = (h.score - h.putts) <= (par - 2);
      }
      allHoles.push({
        activity_id:    r.activity_id,
        date:           r.date,
        course:         r.course || 'Unknown',
        hole:           h.hole,
        par,
        score:          h.score,
        putts:          h.putts,
        gir,
        fairway_hit:    h.fairway_hit,
        fairway_missed: h.fairway_missed_direction,
        penalties:      h.penalties ?? 0,
        yardage:        yd,
        sand_shots:     h.sand_shots,
      });
    }
  }
}

async function loadShots() {
  if (shotsLoaded) return;
  if (shotsLoading) return shotsLoading;
  shotsLoading = (async () => {
    const res  = await fetch('../data/shots.json');
    const data = await res.json();
    const dateById = {};
    for (const r of allRounds) dateById[r.activity_id] = r.date;
    for (const s of data.shots || []) {
      if (s.shot_number == null) continue;
      allShots.push({
        activity_id:    s.activity_id,
        date:           dateById[s.activity_id] ?? null,
        course:         (allRounds.find(r => r.activity_id === s.activity_id) || {}).course ?? null,
        hole:           s.hole,
        shot_number:    s.shot_number,
        club_name:      s.club_name || s.club || null,
        distance_yards: s.distance_yards,
        lie:            s.lie,
        shot_type:      s.shot_type,
      });
    }
    shotsLoaded  = true;
    shotsLoading = null;
  })();
  return shotsLoading;
}

// ── Filtering ─────────────────────────────────────────────────────────────────
// Base filter = round-length + date range + valid score (course-agnostic).
function baseFilteredRounds() {
  const holes    = document.getElementById('filter-holes').value;
  const dateFrom = document.getElementById('filter-date-from').value;
  const dateTo   = document.getElementById('filter-date-to').value;
  return allRounds.filter(r => {
    if (holes === '18' && r.holes_played !== 18) return false;
    if (holes === '9'  && r.holes_played !== 9)  return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo   && r.date > dateTo)   return false;
    if (!r.score || r.score <= 0)               return false;
    if (!r.holes_played || r.holes_played <= 0) return false;
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// Bundle a set of rounds with their holes/shots subsets.
function bundle(rounds) {
  const ids = new Set(rounds.map(r => r.activity_id));
  return {
    rounds,
    holes: allHoles.filter(h => ids.has(h.activity_id)),
    shots: allShots.filter(s => ids.has(s.activity_id)),
  };
}

// ── Per-round aggregate stats (score, putts, vs par, nines, results) ────────────
function classifyHole(h) {
  if (h.par == null || h.score == null) return null;
  const d = h.score - h.par;
  if (d <= -2) return 'Eagle or better';
  if (d === -1) return 'Birdie';
  if (d === 0)  return 'Par';
  if (d === 1)  return 'Bogey';
  if (d === 2)  return 'Double';
  return 'Triple+';
}

function perRoundStats(rounds, holes) {
  const byId = {};
  for (const h of holes) (byId[h.activity_id] ||= []).push(h);
  return rounds.map(r => {
    const hs = (byId[r.activity_id] || []);
    const scored = hs.filter(h => h.score != null);
    const withPar = scored.filter(h => h.par != null);
    const fullPar = scored.length > 0 && withPar.length === scored.length;
    const vsPar = fullPar ? sum(withPar.map(h => h.score - h.par)) : null;
    const front = scored.filter(h => h.hole <= 9);
    const back  = scored.filter(h => h.hole >= 10 && h.hole <= 18);
    const front9 = front.length === 9 ? sum(front.map(h => h.score)) : null;
    const back9  = back.length  === 9 ? sum(back.map(h => h.score))  : null;
    let birdies = 0, eagles = 0;
    for (const h of withPar) { const c = classifyHole(h); if (c === 'Birdie') birdies++; else if (c === 'Eagle or better') eagles++; }
    return { ...r, vsPar, front9, back9, birdies, eagles };
  });
}

// Aggregate metrics for a bundle (used for KPIs + vs-overall comparison).
function aggregateMetrics(rounds, holes) {
  const stats = perRoundStats(rounds, holes);
  const holesWithPutts = holes.filter(h => h.putts != null);
  const onePct   = holesWithPutts.length ? holesWithPutts.filter(h => h.putts <= 1).length / holesWithPutts.length * 100 : null;
  const threePct = holesWithPutts.length ? holesWithPutts.filter(h => h.putts >= 3).length / holesWithPutts.length * 100 : null;
  return {
    n: rounds.length,
    score:   avg(rounds.map(r => r.score).filter(v => v != null)),
    vsPar:   avg(stats.map(s => s.vsPar).filter(v => v != null)),
    putts:   avg(rounds.map(r => r.putts).filter(v => v != null && v > 0)),
    girPct:  avg(rounds.map(r => r.gir_pct).filter(v => v != null)),
    fwyPct:  avg(rounds.map(r => r.fairway_pct).filter(v => v != null)),
    onePct, threePct,
  };
}

// ── Shared trend-line helper ────────────────────────────────────────────────────
function trendLine(chartId, summaryId, dates, vals, label, color, yRange = null) {
  const valid = vals.filter(v => v != null);
  if (!valid.length) { noData(chartId, `No ${label} data`); setSummary(summaryId || '', ''); return; }
  const traces = [
    { x: dates, y: vals, mode: 'lines+markers', name: label,
      line: { color, width: 2 }, marker: { color, size: 6 } },
  ];
  if (valid.length >= 2) {
    traces.push({ x: dates, y: movingAvg(vals, MA_WINDOW), mode: 'lines',
      name: `${MA_WINDOW}-rd avg`, line: { color: C_ORANGE, width: 2, dash: 'dot' } });
  }
  const yax = yRange ? { ...AX, type: 'linear', range: yRange } : { ...AX, type: 'linear' };
  plotClear(chartId, traces, L({ xaxis: { ...AX, type: 'category', tickvals: dates, ticktext: dateTicks(dates) }, yaxis: yax }), CFG);
  if (summaryId) {
    const mn = Math.min(...valid), mx = Math.max(...valid), a = avg(valid);
    setSummary(summaryId, `Avg ${fmt(a)} · Best ${mn} · Worst ${mx}`
      + (valid.length >= 2 ? ` · ${vals.filter(v=>v!=null).at(-1) < valid[0] ? '↓ improving' : '↑ up'} ${Math.abs(valid.at(-1)-valid[0]).toFixed(1)} first to last` : ''));
  }
}

const RESULT_ORDER  = ['Eagle or better', 'Birdie', 'Par', 'Bogey', 'Double', 'Triple+'];
const RESULT_COLORS = { 'Eagle or better': C_PURPLE, 'Birdie': C_BLUE, 'Par': C_NAVY,
                        'Bogey': C_GRAY, 'Double': C_RED, 'Triple+': C_CRIMSON };

function scoringCounts(holes) {
  const counts = Object.fromEntries(RESULT_ORDER.map(r => [r, 0]));
  let total = 0;
  for (const h of holes) { const c = classifyHole(h); if (c) { counts[c]++; total++; } }
  return { counts, total };
}

// ════════════════════════════════ COURSE VIEW ════════════════════════════════
function renderCourseView() {
  const base = baseFilteredRounds();
  const rounds = base.filter(r => r.course === selectedCourse);
  const { holes, shots } = bundle(rounds);
  const meta = courseMeta[selectedCourse];

  // Header + meta line
  document.getElementById('course-name').textContent = selectedCourse;
  const metaBits = [];
  if (rounds.length) {
    metaBits.push(`${rounds.length} round${rounds.length !== 1 ? 's' : ''}`);
    metaBits.push(`${rounds[0].date} – ${rounds.at(-1).date}`);
  }
  if (meta?.par)    metaBits.push(`Par ${meta.par}`);
  if (meta?.rating) metaBits.push(`Rating ${meta.rating}`);
  if (meta?.slope)  metaBits.push(`Slope ${meta.slope}`);
  if (meta?.yards)  metaBits.push(`${meta.yards.toLocaleString()} yds`);
  document.getElementById('course-meta').textContent = metaBits.join('  ·  ');

  const stats = perRoundStats(rounds, holes);
  const agg = aggregateMetrics(rounds, holes);

  // KPIs
  document.getElementById('ck-rounds').textContent = rounds.length || '—';
  document.getElementById('ck-score').textContent  = fmt(agg.score);
  document.getElementById('ck-vspar').textContent  = agg.vsPar != null ? fmtSigned(agg.vsPar) : '—';
  const best = rounds.length ? Math.min(...rounds.map(r => r.score)) : null;
  document.getElementById('ck-best').textContent   = best ?? '—';
  document.getElementById('ck-putts').textContent  = fmt(agg.putts);
  document.getElementById('ck-gir').textContent    = fmt(agg.girPct, '%');
  document.getElementById('ck-fwy').textContent    = fmt(agg.fwyPct, '%');

  // Overview trends — combined score + vs-par chart
  const scoreVals  = rounds.map(r => r.score);
  const scoreDates = rounds.map(r => r.date);
  const vsParPts   = stats.filter(s => s.vsPar != null);
  const hasVsPar   = vsParPts.length > 0;
  const validScores = scoreVals.filter(v => v != null);
  if (!validScores.length) {
    noData('chart-c-score-trend', 'No score data');
    setSummary('summary-c-score-trend', '');
  } else {
    const traces = [
      { x: scoreDates, y: scoreVals, mode: 'lines+markers', name: 'Score',
        line: { color: C_GREEN, width: 2 }, marker: { color: C_GREEN, size: 6 },
        yaxis: 'y' },
    ];
    if (validScores.length >= 2) {
      traces.push({ x: scoreDates, y: movingAvg(scoreVals, MA_WINDOW), mode: 'lines',
        name: `${MA_WINDOW}-rd avg (Score)`, line: { color: C_ORANGE, width: 2, dash: 'dot' }, yaxis: 'y' });
    }
    if (hasVsPar) {
      const vpDates = vsParPts.map(s => s.date);
      const vpVals  = vsParPts.map(s => s.vsPar);
      traces.push({ x: vpDates, y: vpVals, mode: 'lines+markers', name: 'vs Par',
        line: { color: C_NAVY, width: 2 }, marker: { color: C_NAVY, size: 6 },
        yaxis: 'y2' });
      if (vpVals.length >= 2) {
        traces.push({ x: vpDates, y: movingAvg(vpVals, MA_WINDOW), mode: 'lines',
          name: `${MA_WINDOW}-rd avg (vs Par)`, line: { color: C_PURPLE, width: 2, dash: 'dot' }, yaxis: 'y2' });
      }
    }
    const layout = L({
      xaxis: { ...AX, type: 'category', tickvals: scoreDates, ticktext: dateTicks(scoreDates) },
      yaxis: { ...AX, type: 'linear', title: { text: 'Score', standoff: 4 } },
      ...(hasVsPar ? {
        yaxis2: { ...AX, type: 'linear', title: { text: 'vs Par', standoff: 4 },
          overlaying: 'y', side: 'right', zeroline: true, zerolinecolor: '#94a3b8', zerolinewidth: 1 },
        margin: { ...BASE_LAYOUT.margin, r: 44 },
      } : {}),
    });
    plotClear('chart-c-score-trend', traces, layout, CFG);
    const mn = Math.min(...validScores), mx = Math.max(...validScores), a = avg(validScores);
    let summary = `Avg ${fmt(a)} · Best ${mn} · Worst ${mx}`
      + (validScores.length >= 2 ? ` · ${scoreVals.filter(v=>v!=null).at(-1) < validScores[0] ? '↓ improving' : '↑ up'} ${Math.abs(scoreVals.filter(v=>v!=null).at(-1)-validScores[0]).toFixed(1)} first to last` : '');
    if (hasVsPar) {
      const vpVals = vsParPts.map(s => s.vsPar);
      summary += `  ·  Avg vs Par: ${fmtSigned(avg(vpVals))}`;
    }
    setSummary('summary-c-score-trend', summary);
  }

  renderCourseRecords(rounds, stats);
  renderCourseHoles(holes);
  renderCourseVsOverall(rounds, holes, base);
  renderCourseScorecards(rounds, holes, shots);
}

function recordCard(label, value, sub) {
  return `<div class="record-card"><div class="record-value">${value}</div>
    <div class="record-label">${label}</div>${sub ? `<div class="record-sub">${sub}</div>` : ''}</div>`;
}

function renderCourseRecords(rounds, stats) {
  const el = document.getElementById('course-records');
  if (!rounds.length) { el.innerHTML = '<div class="no-data">No rounds for this course in the current filter.</div>'; return; }

  const bestRound = rounds.reduce((a, b) => b.score < a.score ? b : a);
  const cards = [];
  cards.push(recordCard('Best Round', bestRound.score, bestRound.date));

  const vsParStats = stats.filter(s => s.vsPar != null);
  if (vsParStats.length) {
    const lowVsPar = vsParStats.reduce((a, b) => b.vsPar < a.vsPar ? b : a);
    cards.push(recordCard('Low vs Par', fmtSigned(lowVsPar.vsPar), lowVsPar.date));
  }
  const f9 = stats.filter(s => s.front9 != null);
  if (f9.length) { const b = f9.reduce((a, x) => x.front9 < a.front9 ? x : a); cards.push(recordCard('Best Front 9', b.front9, b.date)); }
  const b9 = stats.filter(s => s.back9 != null);
  if (b9.length) { const b = b9.reduce((a, x) => x.back9 < a.back9 ? x : a); cards.push(recordCard('Best Back 9', b.back9, b.date)); }

  const totalBirdies = sum(stats.map(s => s.birdies));
  const totalEagles  = sum(stats.map(s => s.eagles));
  if (totalBirdies || totalEagles) cards.push(recordCard('Birdies', totalBirdies, totalEagles ? `${totalEagles} eagle${totalEagles !== 1 ? 's' : ''}` : ''));

  const bestPutts = Math.min(...rounds.map(r => r.putts).filter(v => v != null && v > 0));
  if (isFinite(bestPutts)) cards.push(recordCard('Fewest Putts', bestPutts, ''));

  // Trajectory: first vs recent score average
  if (rounds.length >= 4) {
    const half = Math.floor(rounds.length / 2);
    const early = avg(rounds.slice(0, half).map(r => r.score));
    const late  = avg(rounds.slice(half).map(r => r.score));
    const delta = late - early;
    cards.push(recordCard('Trend', `${delta < 0 ? '↓' : '↑'} ${Math.abs(delta).toFixed(1)}`,
      delta < 0 ? 'improving' : 'rising'));
  }
  el.innerHTML = cards.join('');
}

function renderCourseHoles(holes) {
  const ids = ['chart-c-hole-score','chart-c-hole-gir','chart-c-hole-putts','chart-c-hole-pen'];
  if (!holes.length) { ids.forEach(id => noData(id, 'No hole-level data')); return; }
  const holeNums = [...new Set(holes.map(h => h.hole))].sort((a,b) => a-b);

  // Best / Avg / Worst score per hole
  const hs = holeNums.map(n => {
    const hh = holes.filter(h => h.hole === n);
    const scores = hh.map(h => h.score).filter(s => s != null);
    const pars   = hh.map(h => h.par).filter(p => p != null);
    return {
      hole: n,
      avg_score: avg(scores),
      best_score: scores.length ? Math.min(...scores) : null,
      worst_score: scores.length ? Math.max(...scores) : null,
      avg_par: avg(pars),
    };
  });
  const d = hs.filter(d => d.avg_score != null);
  if (d.length) {
    const xLabels = d.map(d => `H${d.hole}`);
    const traces = [
      { x: xLabels, y: d.map(d => d.worst_score), mode: 'lines+markers', name: 'Worst',
        line: { color: C_RED, width: 2 }, marker: { color: C_RED, size: 6 },
        hovertemplate: 'Hole %{x} — Worst: %{y}<extra></extra>' },
      { x: xLabels, y: d.map(d => d.avg_score), mode: 'lines+markers', name: 'Avg',
        line: { color: C_ORANGE, width: 2 }, marker: { color: C_ORANGE, size: 6 },
        hovertemplate: 'Hole %{x} — Avg: %{y:.2f}<extra></extra>' },
      { x: xLabels, y: d.map(d => d.best_score), mode: 'lines+markers', name: 'Best',
        line: { color: C_BLUE, width: 2 }, marker: { color: C_BLUE, size: 6 },
        hovertemplate: 'Hole %{x} — Best: %{y}<extra></extra>' },
    ];
    if (d.some(d => d.avg_par != null)) {
      traces.push({ x: xLabels, y: d.map(d => d.avg_par), mode: 'lines', name: 'Par',
        line: { color: C_GREEN, width: 2, dash: 'dot' },
        hovertemplate: 'Hole %{x} — Par: %{y}<extra></extra>' });
    }
    plotClear('chart-c-hole-score', traces, L({
      xaxis: catAxis(),
      yaxis: { ...AX, type: 'linear' },
    }), CFG);
    const hardest = d.reduce((a,b) => (b.avg_score ?? -Infinity) > (a.avg_score ?? -Infinity) ? b : a);
    const easiest = d.reduce((a,b) => (b.avg_score ?? Infinity) < (a.avg_score ?? Infinity) ? b : a);
    setSummary('summary-c-hole-score',
      `Hardest avg: H${hardest.hole} (${fmt(hardest.avg_score)}). Easiest avg: H${easiest.hole} (${fmt(easiest.avg_score)}).`);
  } else {
    noData('chart-c-hole-score', 'No score data');
    setSummary('summary-c-hole-score', '');
  }

  // GIR % by hole
  const girData = holeNums.map(n => {
    const hh = holes.filter(h => h.hole === n && h.gir != null);
    return hh.length ? { hole: n, gir_pct: hh.filter(h => h.gir).length / hh.length * 100 } : null;
  }).filter(Boolean);
  if (girData.length) {
    plotClear('chart-c-hole-gir', [{
      x: girData.map(d => `H${d.hole}`), y: girData.map(d => d.gir_pct), type: 'bar',
      marker: { color: C_TEAL }, hovertemplate: 'H%{x}: %{y:.1f}%<extra></extra>',
    }], L({ showlegend: false, xaxis: catAxis(), yaxis: { ...AX, type: 'linear', range: [0, 100] } }), CFG);
    const best = girData.reduce((a,b) => b.gir_pct > a.gir_pct ? b : a);
    const worst = girData.reduce((a,b) => b.gir_pct < a.gir_pct ? b : a);
    setSummary('summary-c-hole-gir', `Best GIR: H${best.hole} (${best.gir_pct.toFixed(1)}%). Lowest: H${worst.hole} (${worst.gir_pct.toFixed(1)}%).`);
  } else { noData('chart-c-hole-gir', 'No GIR data'); }

  // Best / Avg / Worst putts by hole
  const puttData = holeNums.map(n => {
    const hh = holes.filter(h => h.hole === n && h.putts != null);
    if (!hh.length) return null;
    const putts = hh.map(h => h.putts);
    return { hole: n, avg_putts: avg(putts), best_putts: Math.min(...putts), worst_putts: Math.max(...putts) };
  }).filter(Boolean);
  if (puttData.length) {
    const xLabels = puttData.map(d => `H${d.hole}`);
    const yMax = Math.max(4, Math.ceil(Math.max(...puttData.map(d => d.worst_putts)) + 0.5));
    plotClear('chart-c-hole-putts', [
      { x: xLabels, y: puttData.map(d => d.worst_putts), mode: 'lines+markers', name: 'Worst',
        line: { color: C_RED, width: 2 }, marker: { color: C_RED, size: 6 },
        hovertemplate: 'Hole %{x} — Worst: %{y}<extra></extra>' },
      { x: xLabels, y: puttData.map(d => d.avg_putts), mode: 'lines+markers', name: 'Avg',
        line: { color: C_ORANGE, width: 2 }, marker: { color: C_ORANGE, size: 6 },
        hovertemplate: 'Hole %{x} — Avg: %{y:.2f}<extra></extra>' },
      { x: xLabels, y: puttData.map(d => d.best_putts), mode: 'lines+markers', name: 'Best',
        line: { color: C_BLUE, width: 2 }, marker: { color: C_BLUE, size: 6 },
        hovertemplate: 'Hole %{x} — Best: %{y}<extra></extra>' },
    ], L({ xaxis: catAxis(), yaxis: { ...AX, type: 'linear', range: [0, yMax] } }), CFG);
    const worst = puttData.reduce((a,b) => b.avg_putts > a.avg_putts ? b : a);
    setSummary('summary-c-hole-putts', `Toughest green: H${worst.hole} (${worst.avg_putts.toFixed(2)} avg putts). Baseline ~2/hole.`);
  } else { noData('chart-c-hole-putts', 'No putt data'); }

  // Penalties by hole
  const penData = holeNums.map(n => ({
    hole: n, penalties: sum(holes.filter(h => h.hole === n).map(h => h.penalties || 0)),
  })).filter(d => d.penalties > 0);
  if (penData.length) {
    plotClear('chart-c-hole-pen', [{
      x: penData.map(d => `H${d.hole}`), y: penData.map(d => d.penalties), type: 'bar',
      marker: { color: C_ORANGE }, hovertemplate: 'H%{x}: %{y} penalties<extra></extra>',
    }], L({ showlegend: false, xaxis: catAxis() }), CFG);
    const worst = penData.reduce((a,b) => b.penalties > a.penalties ? b : a);
    setSummary('summary-c-hole-pen', `Most penalties: H${worst.hole} (${worst.penalties} total).`);
  } else { noData('chart-c-hole-pen', 'No penalty data'); setSummary('summary-c-hole-pen', ''); }
}

function renderCourseVsOverall(courseRounds, courseHoles, baseRounds) {
  const overall = bundle(baseRounds);
  const cAgg = aggregateMetrics(courseRounds, courseHoles);
  const oAgg = aggregateMetrics(baseRounds, overall.holes);

  // Comparison table. lowerBetter => improvement when course value < overall.
  const rows = [
    { label: 'Avg Score',  c: cAgg.score,  o: oAgg.score,  lowerBetter: true,  sfx: '' },
    { label: 'Avg vs Par', c: cAgg.vsPar,  o: oAgg.vsPar,  lowerBetter: true,  signed: true },
    { label: 'Avg Putts',  c: cAgg.putts,  o: oAgg.putts,  lowerBetter: true,  sfx: '' },
    { label: 'GIR %',      c: cAgg.girPct, o: oAgg.girPct, lowerBetter: false, sfx: '%' },
    { label: 'Fairway %',  c: cAgg.fwyPct, o: oAgg.fwyPct, lowerBetter: false, sfx: '%' },
    { label: '1-Putt %',   c: cAgg.onePct, o: oAgg.onePct, lowerBetter: false, sfx: '%' },
    { label: '3-Putt %',   c: cAgg.threePct, o: oAgg.threePct, lowerBetter: true, sfx: '%' },
  ];
  const cell = (v, signed, sfx) => v == null ? '—' : (signed ? fmtSigned(v) : fmt(v, sfx || ''));
  const body = rows.map(r => {
    let diffHtml = '—';
    if (r.c != null && r.o != null) {
      const diff = r.c - r.o;
      const better = r.lowerBetter ? diff < 0 : diff > 0;
      const cls = Math.abs(diff) < 0.05 ? 'diff-flat' : better ? 'diff-good' : 'diff-bad';
      const arrow = Math.abs(diff) < 0.05 ? '' : (diff < 0 ? '▼' : '▲');
      diffHtml = `<span class="${cls}">${arrow} ${fmtSigned(diff)}${r.sfx || ''}</span>`;
    }
    return `<tr><td class="metric-label">${r.label}</td>
      <td class="metric-here">${cell(r.c, r.signed, r.sfx)}</td>
      <td>${cell(r.o, r.signed, r.sfx)}</td>
      <td>${diffHtml}</td></tr>`;
  }).join('');
  document.getElementById('course-vs-table').innerHTML = `
    <table class="compare-table">
      <thead><tr><th>Metric</th><th>This Course</th><th>All Courses</th><th>Δ</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;

  // Scoring mix comparison (requires par)
  const c = scoringCounts(courseHoles);
  const o = scoringCounts(overall.holes);
  if (c.total && o.total) {
    plotClear('chart-c-scoring-compare', [
      { x: RESULT_ORDER, y: RESULT_ORDER.map(k => c.counts[k] / c.total * 100),
        name: 'This Course', type: 'bar', marker: { color: C_GREEN } },
      { x: RESULT_ORDER, y: RESULT_ORDER.map(k => o.counts[k] / o.total * 100),
        name: 'All Courses', type: 'bar', marker: { color: C_GRAY } },
    ], L({ height: 280, barmode: 'group', xaxis: catAxis(),
      yaxis: { ...AX, type: 'linear', title: { text: '% of holes', standoff: 6 } } }), CFG);
    const cBirdiePlus = (c.counts['Birdie'] + c.counts['Eagle or better']) / c.total * 100;
    const oBirdiePlus = (o.counts['Birdie'] + o.counts['Eagle or better']) / o.total * 100;
    setSummary('summary-c-scoring-compare',
      `Birdie-or-better here: ${cBirdiePlus.toFixed(1)}% vs ${oBirdiePlus.toFixed(1)}% overall.`);
  } else {
    noData('chart-c-scoring-compare', 'Par data required for scoring mix');
    setSummary('summary-c-scoring-compare', '');
  }
}

function renderCourseScorecards(rounds, holes, shots) {
  const sorted = rounds.slice().sort((a,b) => b.date.localeCompare(a.date));
  const sel = document.getElementById('c-scorecard-selector');
  sel.innerHTML = sorted.map(r =>
    `<option value="${r.activity_id}">${r.date} (Score: ${r.score})</option>`).join('')
    || '<option value="">No rounds available</option>';
  if (sorted.length) renderScorecard(sorted[0].activity_id, holes, shots);
  else document.getElementById('c-scorecard-table').innerHTML = '';
}

function renderScorecard(actId, holesAll, shotsAll) {
  const holes = (holesAll || allHoles).filter(h => h.activity_id === actId).sort((a,b)=>a.hole-b.hole);
  const target = document.getElementById('c-scorecard-table');
  if (!holes.length) { target.innerHTML = '<div class="no-data">No hole detail for this round.</div>'; return; }
  const totalScore = sum(holes.map(h => h.score || 0));
  const allHavePar = holes.every(h => h.par != null);
  const totalPar   = allHavePar ? sum(holes.map(h => h.par || 0)) : null;
  const totalPutts = sum(holes.map(h => h.putts || 0));
  const girCount = holes.filter(h => h.gir === true).length;
  const girTotal = holes.filter(h => h.gir != null).length;
  const fwyHit   = holes.filter(h => h.fairway_hit === true).length;
  const fwyTotal = holes.filter(h => h.fairway_hit != null).length;
  const totalPen = sum(holes.map(h => h.penalties || 0));
  const allHaveYd = holes.every(h => h.yardage != null);
  const totalYards = allHaveYd ? sum(holes.map(h => h.yardage)) : null;

  const vsPar = totalPar != null ? totalScore - totalPar : null;
  const vsParStr = vsPar != null ? (vsPar > 0 ? `+${vsPar}` : `${vsPar}`) : null;
  const vsParCls = vsPar != null ? (vsPar < 0 ? 'birdie' : vsPar > 0 ? 'bogey' : '') : '';

  const holeHeaders = holes.map(h => `<th>${h.hole}</th>`).join('');
  const parRow   = holes.map(h => `<td>${h.par ?? '—'}</td>`).join('');
  const scoreRow = holes.map(h => {
    const diff = h.par != null && h.score != null ? h.score - h.par : null;
    const cls  = diff != null ? (diff < 0 ? 'birdie' : diff === 0 ? '' : diff === 1 ? 'bogey' : 'double-plus') : '';
    return `<td class="score-cell ${cls}"><strong>${h.score ?? '—'}</strong></td>`;
  }).join('');
  const puttsRow = holes.map(h => `<td>${h.putts ?? '—'}</td>`).join('');
  const girRow   = holes.map(h => `<td>${fmtBool(h.gir)}</td>`).join('');
  const fwyRow   = holes.map(h => `<td>${fmtBool(h.fairway_hit)}</td>`).join('');
  const penRow   = holes.map(h => `<td>${h.penalties ?? 0}</td>`).join('');
  const ydRow    = holes.map(h => `<td>${h.yardage ?? '—'}</td>`).join('');

  const roundShots = (shotsAll || allShots).filter(s => s.activity_id === actId);
  const teeShots = roundShots.filter(s => s.shot_type === 'TEE' || s.lie === 'TeeBox');
  const longestDrive = teeShots.length ? Math.round(Math.max(...teeShots.map(s => s.distance_yards ?? 0))) : null;

  target.innerHTML = `
    <div class="scorecard-wrap">
      <table class="scorecard-table">
        <thead><tr><th class="stat-label-col"></th>${holeHeaders}</tr></thead>
        <tbody>
          <tr><td class="stat-label">Par</td>${parRow}</tr>
          <tr><td class="stat-label">Score</td>${scoreRow}</tr>
          <tr><td class="stat-label">Putts</td>${puttsRow}</tr>
          <tr><td class="stat-label">GIR</td>${girRow}</tr>
          <tr><td class="stat-label">Fairway</td>${fwyRow}</tr>
          <tr><td class="stat-label">Penalties</td>${penRow}</tr>
          ${allHaveYd ? `<tr><td class="stat-label">Yards</td>${ydRow}</tr>` : ''}
        </tbody>
      </table>
    </div>
    <div class="scorecard-summary">
      <div class="sc-sum-item"><span class="sc-sum-label">Score</span><span class="sc-sum-value">${totalScore}${vsParStr != null ? ` <span class="sc-vs-par ${vsParCls}">(${vsParStr})</span>` : ''}</span></div>
      <div class="sc-sum-item"><span class="sc-sum-label">Putts</span><span class="sc-sum-value">${totalPutts}</span></div>
      ${girTotal > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">GIR</span><span class="sc-sum-value">${girCount}/${girTotal}</span></div>` : ''}
      ${fwyTotal > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Fairways</span><span class="sc-sum-value">${fwyHit}/${fwyTotal}</span></div>` : ''}
      ${totalPen > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Penalties</span><span class="sc-sum-value">${totalPen}</span></div>` : ''}
      ${totalYards != null ? `<div class="sc-sum-item"><span class="sc-sum-label">Yards</span><span class="sc-sum-value">${totalYards.toLocaleString()}</span></div>` : ''}
      ${longestDrive != null && longestDrive > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Longest Drive</span><span class="sc-sum-value">${longestDrive} yds</span></div>` : ''}
    </div>`;
}

// ════════════════════════════════ OVERALL VIEW ════════════════════════════════
function renderOverallView() {
  const rounds = baseFilteredRounds();
  const { holes, shots } = bundle(rounds);
  const agg = aggregateMetrics(rounds, holes);

  document.getElementById('ok-rounds').textContent  = rounds.length || '—';
  document.getElementById('ok-courses').textContent = new Set(rounds.map(r => r.course)).size || '—';
  document.getElementById('ok-score').textContent   = fmt(agg.score);
  document.getElementById('ok-putts').textContent   = fmt(agg.putts);
  document.getElementById('ok-gir').textContent     = fmt(agg.girPct, '%');
  document.getElementById('ok-fwy').textContent     = fmt(agg.fwyPct, '%');
  document.getElementById('ok-1putt').textContent   = fmt(agg.onePct, '%');

  const dates = rounds.map(r => r.date);
  trendLine('chart-o-score-trend', 'summary-o-score', dates, rounds.map(r => r.score), 'Score', C_GREEN);
  const pr = rounds.filter(r => r.putts != null && r.putts > 0);
  trendLine('chart-o-putts-trend', 'summary-o-putts', pr.map(r => r.date), pr.map(r => r.putts), 'Putts', C_BLUE);
  trendLine('chart-o-gir-trend', 'summary-o-gir', dates, rounds.map(r => r.gir_pct), 'GIR %', C_TEAL, [0, 100]);
  trendLine('chart-o-fwy-trend', 'summary-o-fwy', dates, rounds.map(r => r.fairway_pct), 'FWY %', C_PURPLE, [0, 100]);

  renderScoringDonut(holes);
  renderPuttingDonut(holes);
  renderOverallClubs(shots);
  renderComparisonTable(rounds, holes);
}

function renderScoringDonut(holes) {
  const { counts, total } = scoringCounts(holes);
  if (!total) { noData('chart-o-scoring-donut', 'Par data required'); setSummary('summary-o-scoring-donut',''); return; }
  const parOrBetter = counts['Eagle or better'] + counts['Birdie'] + counts['Par'];
  const pct = (parOrBetter / total * 100).toFixed(0);
  plotClear('chart-o-scoring-donut', [{
    labels: RESULT_ORDER, values: RESULT_ORDER.map(r => counts[r]), type: 'pie', hole: 0.55,
    marker: { colors: RESULT_ORDER.map(r => RESULT_COLORS[r]) },
    hovertemplate: '%{label}: %{value} holes (%{percent})<extra></extra>',
  }], L({ height: 300, showlegend: true, legend: { orientation: 'v', x: 1.02, y: 0.5 },
    annotations: [{ text: `<b>${pct}%</b><br>Par or<br>Better`, x: 0.5, y: 0.5, font: { size: 14, color: C_NAVY }, showarrow: false }] }), CFG);
  const top = RESULT_ORDER.reduce((a, b) => counts[b] > counts[a] ? b : a);
  setSummary('summary-o-scoring-donut', `${pct}% par or better. Most common: ${top} (${(counts[top]/total*100).toFixed(1)}%).`);
}

function renderPuttingDonut(holes) {
  const hp = holes.filter(h => h.putts != null);
  if (!hp.length) { noData('chart-o-putting-donut', 'No putt data'); setSummary('summary-o-putting-donut',''); return; }
  const one = hp.filter(h => h.putts <= 1).length, two = hp.filter(h => h.putts === 2).length, three = hp.filter(h => h.putts >= 3).length;
  const total = hp.length;
  const twoPlusPct = ((one + two) / total * 100).toFixed(0);
  plotClear('chart-o-putting-donut', [{
    labels: ['1 Putt or Better', '2 Putts', '3 Putts or Worse'], values: [one, two, three],
    type: 'pie', hole: 0.55, marker: { colors: [C_TEAL, C_NAVY, C_RED] },
    hovertemplate: '%{label}: %{value} holes (%{percent})<extra></extra>',
  }], L({ height: 300, showlegend: true, legend: { orientation: 'v', x: 1.02, y: 0.5 },
    annotations: [{ text: `<b>${twoPlusPct}%</b><br>2 Putts<br>or Better`, x: 0.5, y: 0.5, font: { size: 14, color: C_NAVY }, showarrow: false }] }), CFG);
  setSummary('summary-o-putting-donut',
    `Avg ${fmt(avg(hp.map(h=>h.putts)))} putts/hole. 1-putt: ${(one/total*100).toFixed(1)}% · 3-putt: ${(three/total*100).toFixed(1)}%.`);
}

function renderOverallClubs(shots) {
  const ids = ['chart-o-club-box','chart-o-lie-distance','chart-o-club-usage','chart-o-drive-trend'];
  const valid = shots.filter(s => s.distance_yards != null && s.distance_yards > 0);
  if (!valid.length) {
    ids.forEach(id => noData(id, shotsLoaded ? 'No club/shot data available' : 'Loading shot data…'));
    return;
  }
  const clubs = [...new Set(valid.map(s => s.club_name))].filter(Boolean);

  plotClear('chart-o-club-box', clubs.map(club => {
    const d = valid.filter(s => s.club_name === club).map(s => s.distance_yards);
    return { x: d.map(()=>club), y: d, type: 'box', name: club, boxpoints: 'outliers',
      hovertemplate: `<b>%{x}</b><br>Median: ${median(d)?.toFixed(1)} yds<br>Avg: ${avg(d)?.toFixed(1)} yds<br>Shots: ${d.length}<extra></extra>` };
  }), L({ height: 320, showlegend: false, xaxis: { ...AX, type: 'category' },
    yaxis: { ...AX, type: 'linear', title: { text: 'Yards', standoff: 6 } } }), CFG);
  const clubStats = clubs.map(c => ({ c, med: median(valid.filter(s => s.club_name === c).map(s => s.distance_yards)) })).sort((a,b)=>(b.med??0)-(a.med??0));
  setSummary('summary-o-club-box', `Longest median club: ${clubStats[0].c} at ${clubStats[0].med?.toFixed(1)} yds.`);

  const lies = [...new Set(valid.map(s => s.lie))].filter(l => l && l !== 'Unknown');
  if (lies.length) {
    plotClear('chart-o-lie-distance', lies.map(lie => {
      const d = valid.filter(s => s.lie === lie).map(s => s.distance_yards);
      return { x: d.map(()=>lie), y: d, type: 'box', name: lie, boxpoints: false };
    }), L({ showlegend: false, xaxis: { ...AX, type: 'category' },
      yaxis: { ...AX, type: 'linear', title: { text: 'Yards', standoff: 6 } } }), CFG);
    const lieAvgs = lies.map(lie => ({ lie, avg: avg(valid.filter(s => s.lie === lie).map(s => s.distance_yards)) })).sort((a,b)=>(b.avg??0)-(a.avg??0));
    setSummary('summary-o-lie-distance', lieAvgs.map(l => `${l.lie}: ${l.avg?.toFixed(1)} yds`).join(' · '));
  } else { noData('chart-o-lie-distance', 'No lie data'); }

  const usage = clubs.map(c => ({ c, n: valid.filter(s => s.club_name === c).length })).sort((a,b)=>b.n-a.n);
  plotClear('chart-o-club-usage', [{ x: usage.map(u=>u.c), y: usage.map(u=>u.n), type: 'bar',
    marker: { color: C_GREEN }, hovertemplate: '%{x}: %{y} shots<extra></extra>' }],
    L({ showlegend: false, xaxis: catAxis() }), CFG);
  setSummary('summary-o-club-usage', `Most-used: ${usage[0].c} (${usage[0].n} shots).`);

  const teeShots = valid.filter(s => s.lie === 'TeeBox');
  if (teeShots.length) {
    const roundIds = [...new Set(teeShots.map(s => s.activity_id))];
    const byDate = roundIds.map(id => {
      const ss = teeShots.filter(s => s.activity_id === id);
      return { date: ss[0].date, avg: avg(ss.map(s => s.distance_yards)) };
    }).filter(d => d.date).sort((a,b) => a.date.localeCompare(b.date));
    trendLine('chart-o-drive-trend', 'summary-o-drive-trend', byDate.map(d => d.date), byDate.map(d => d.avg), 'Avg Drive (yds)', C_ORANGE);
  } else { noData('chart-o-drive-trend', 'No tee shot data'); setSummary('summary-o-drive-trend', ''); }
}

function renderComparisonTable(rounds, holes) {
  const courses = [...new Set(rounds.map(r => r.course))];
  const rows = courses.map(course => {
    const cr = rounds.filter(r => r.course === course);
    const ch = holes.filter(h => h.course === course);
    const agg = aggregateMetrics(cr, ch);
    return { course, n: cr.length, score: agg.score, vsPar: agg.vsPar,
      best: Math.min(...cr.map(r => r.score)), putts: agg.putts, gir: agg.girPct, fwy: agg.fwyPct };
  }).sort((a, b) => b.n - a.n);

  const body = rows.map(r => `
    <tr data-course="${r.course.replace(/"/g, '&quot;')}" class="${r.course === selectedCourse ? 'row-home' : ''}">
      <td class="metric-label">${r.course}${r.course === HOME_COURSE ? ' <span class="home-badge">home</span>' : ''}</td>
      <td>${r.n}</td>
      <td>${fmt(r.score)}</td>
      <td>${r.vsPar != null ? fmtSigned(r.vsPar) : '—'}</td>
      <td>${isFinite(r.best) ? r.best : '—'}</td>
      <td>${fmt(r.putts)}</td>
      <td>${fmt(r.gir, '%')}</td>
      <td>${fmt(r.fwy, '%')}</td>
    </tr>`).join('');
  document.getElementById('course-comparison-table').innerHTML = `
    <table class="compare-table comparison-table">
      <thead><tr><th>Course</th><th>Rounds</th><th>Avg Score</th><th>Avg vs Par</th><th>Best</th><th>Avg Putts</th><th>GIR %</th><th>FWY %</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  document.querySelectorAll('#course-comparison-table tr[data-course]').forEach(tr => {
    tr.addEventListener('click', () => {
      selectedCourse = tr.dataset.course;
      localStorage.setItem(LS_KEY, selectedCourse);
      document.getElementById('course-select').value = selectedCourse;
      switchMode('course');
    });
  });
}

// ── Mode + setup ────────────────────────────────────────────────────────────────
function switchMode(newMode) {
  mode = newMode;
  document.querySelectorAll('.mode-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('view-course').classList.toggle('active', mode === 'course');
  document.getElementById('view-overall').classList.toggle('active', mode === 'overall');
  render();
}

function render() {
  const base = baseFilteredRounds();
  const n = base.length;
  document.getElementById('round-count').textContent = `${n} round${n !== 1 ? 's' : ''} (all courses)`;
  if (mode === 'course') renderCourseView();
  else renderOverallView();
}

function setupChrome() {
  // Course selector: courses that actually appear in rounds, ordered by round count desc
  const counts = {};
  for (const r of allRounds) counts[r.course] = (counts[r.course] || 0) + 1;
  const courses = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const sel = document.getElementById('course-select');
  sel.innerHTML = courses.map(c => `<option value="${c.replace(/"/g,'&quot;')}">${c} (${counts[c]})</option>`).join('');

  const stored = localStorage.getItem(LS_KEY);
  selectedCourse = (stored && courses.includes(stored)) ? stored
    : courses.includes(HOME_COURSE) ? HOME_COURSE : courses[0];
  sel.value = selectedCourse;

  document.getElementById('filter-holes').value = '18';
  const dates = allRounds.map(r => r.date).filter(Boolean).sort();
  if (dates.length) {
    document.getElementById('filter-date-from').value = dates[0];
    document.getElementById('filter-date-to').value   = dates.at(-1);
  }

  sel.addEventListener('change', () => {
    selectedCourse = sel.value;
    localStorage.setItem(LS_KEY, selectedCourse);
    render();
  });
  ['filter-holes','filter-date-from','filter-date-to'].forEach(id =>
    document.getElementById(id).addEventListener('change', render));
  document.getElementById('c-scorecard-selector').addEventListener('change', e => {
    const base = baseFilteredRounds().filter(r => r.course === selectedCourse);
    const { holes, shots } = bundle(base);
    renderScorecard(e.target.value, holes, shots);
  });
  document.querySelectorAll('.mode-tabs .tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchMode(btn.dataset.mode)));
}

// ── Init ────────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadData();
    setupChrome();
    if (lastUpdated) document.getElementById('last-updated').textContent = `Last synced: ${lastUpdated.slice(0, 10)}`;
    render();
    // Lazy-load shot data, then refresh shot-dependent sections.
    loadShots().then(() => render());
  } catch (err) {
    document.body.innerHTML = `
      <div style="padding:40px;font-family:sans-serif;color:#dc2626">
        <h2>Failed to load data</h2><p>${err.message}</p>
        <p style="color:#64748b;margin-top:8px">Serve via HTTP, not file:// — run: python3 -m http.server 8765</p>
      </div>`;
  }
}

init();
