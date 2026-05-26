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
let filteredRounds = [], filteredHoles = [], filteredShots = [];
let lastUpdated = null;
let shotsLoaded = false;
let shotsLoading = null; // pending Promise while fetch is in-flight

// ── Helpers ───────────────────────────────────────────────────────────────────
const avg    = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const stddev = arr => { if (arr.length < 2) return null; const m=avg(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length); };
const r1     = x   => x != null ? Math.round(x * 10) / 10 : null;
const r0     = x   => x != null ? Math.round(x) : null;
const fmt    = (x, sfx = '') => x != null ? `${r1(x)}${sfx}` : '—';
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

function setSummary(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function catAxis(overrides = {}) {
  return { ...AX, type: 'category', ...overrides };
}

// ── Load & parse ──────────────────────────────────────────────────────────────
async function loadData() {
  const [roundsRes, holesRes] = await Promise.all([
    fetch('../data/rounds.json'),
    fetch('../data/holes.json'),
  ]);
  const [roundsData, holesData] = await Promise.all([roundsRes.json(), holesRes.json()]);
  lastUpdated = roundsData.last_updated || null;

  // Index holes by activity_id for fast lookup
  const holesById = {};
  for (const h of holesData.holes || []) {
    (holesById[h.activity_id] ||= []).push(h);
  }

  for (const r of roundsData.rounds) {
    const t = r.totals || {};
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
      tee_box:           r.tee_box          ?? null,
      tee_box_rating:    r.tee_box_rating   ?? null,
      tee_box_slope:     r.tee_box_slope    ?? null,
      front_nine:        r.front_nine       ?? null,
      back_nine:         r.back_nine        ?? null,
    });

    for (const h of holesById[r.activity_id] || []) {
      if (h.score == null) continue;
      allHoles.push({
        activity_id:    r.activity_id,
        date:           r.date,
        course:         r.course || 'Unknown',
        hole:           h.hole,
        par:            h.par,
        score:          h.score,
        putts:          h.putts,
        gir:            h.gir,
        fairway_hit:    h.fairway_hit,
        fairway_missed: h.fairway_missed_direction,
        penalties:      h.penalties ?? 0,
        yardage:        h.yardage,
        sand_shots:     h.sand_shots,
        end_lat:        h.end_lat  ?? null,
        end_lon:        h.end_lon  ?? null,
      });
    }
  }
}

async function loadShots() {
  if (shotsLoaded) return;
  // Deduplicate concurrent calls — reuse in-flight promise if one exists
  if (shotsLoading) return shotsLoading;
  shotsLoading = (async () => {
    const res  = await fetch('../data/shots.json');
    const data = await res.json();
    const ids  = new Set(filteredRounds.map(r => r.activity_id));
    for (const s of data.shots || []) {
      if (s.shot_number == null) continue;
      allShots.push({
        activity_id:    s.activity_id,
        date:           (allRounds.find(r => r.activity_id === s.activity_id) || {}).date ?? null,
        hole:           s.hole,
        shot_number:    s.shot_number,
        club_id:        s.club_id        ?? null,
        club_type_id:   s.club_type_id   ?? null,
        club_type_name: s.club_type_name ?? null,
        club_name:      s.club_name || s.club || null,
        distance_yards: s.distance_yards,
        lie:            s.lie,
        shot_type:      s.shot_type,
        lat:            s.lat   ?? null,
        lon:            s.lon   ?? null,
        end_lat:        s.end_lat ?? null,
        end_lon:        s.end_lon ?? null,
      });
    }
    filteredShots = allShots.filter(s => ids.has(s.activity_id));
    shotsLoaded  = true;
    shotsLoading = null;
  })();
  return shotsLoading;
}

// ── Filters ───────────────────────────────────────────────────────────────────
function applyFilters() {
  const course   = document.getElementById('filter-course').value;
  const holes    = document.getElementById('filter-holes').value;
  const dateFrom = document.getElementById('filter-date-from').value;
  const dateTo   = document.getElementById('filter-date-to').value;

  filteredRounds = allRounds.filter(r => {
    if (course && r.course !== course) return false;
    if (holes === '18' && r.holes_played !== 18) return false;
    if (holes === '9'  && r.holes_played !== 9)  return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo   && r.date > dateTo)   return false;
    if (!r.score || r.score <= 0)               return false;
    if (!r.holes_played || r.holes_played <= 0) return false;
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  const ids = new Set(filteredRounds.map(r => r.activity_id));
  filteredHoles  = allHoles.filter(h => ids.has(h.activity_id));
  filteredShots  = allShots.filter(s => ids.has(s.activity_id));

  const n = filteredRounds.length;
  document.getElementById('round-count').textContent = `${n} round${n !== 1 ? 's' : ''}`;
  updateAll();
}

// ── KPIs ──────────────────────────────────────────────────────────────────────
function updateKPIs() {
  const pick = key => filteredRounds.map(r => r[key]).filter(v => v != null);

  document.getElementById('kpi-score').textContent   = fmt(avg(pick('score')));
  document.getElementById('kpi-putts').textContent   = fmt(avg(pick('putts')));
  document.getElementById('kpi-gir').textContent     = fmt(avg(pick('gir_count')));
  document.getElementById('kpi-gir-pct').textContent = fmt(avg(pick('gir_pct')), '%');
  document.getElementById('kpi-fwy').textContent     = fmt(avg(pick('fairway_pct')), '%');

  // Putting KPIs from hole-level data
  const holesWithPutts = filteredHoles.filter(h => h.putts != null);
  if (holesWithPutts.length) {
    const one   = holesWithPutts.filter(h => h.putts <= 1).length;
    const three = holesWithPutts.filter(h => h.putts >= 3).length;
    const total = holesWithPutts.length;
    document.getElementById('kpi-1putt').textContent = `${((one/total)*100).toFixed(1)}%`;
    document.getElementById('kpi-3putt').textContent = `${((three/total)*100).toFixed(1)}%`;
  } else {
    document.getElementById('kpi-1putt').textContent = '—';
    document.getElementById('kpi-3putt').textContent = '—';
  }
}

// ── Trend line helper ─────────────────────────────────────────────────────────
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
  Plotly.newPlot(chartId, traces,
    L({ xaxis: { ...AX, type: 'date' }, yaxis: yax }), CFG);

  if (summaryId) {
    const mn = Math.min(...valid), mx = Math.max(...valid), a = avg(valid);
    setSummary(summaryId, `Avg ${fmt(a)} · Best ${mn} · Worst ${mx}`
      + (valid.length >= 2 ? ` · ${vals[vals.length-1] < vals[0] ? '↓ improving' : '↑ up'} ${Math.abs(vals[vals.length-1]-vals[0]).toFixed(1)} first to last` : ''));
  }
}

// ── Trends tab ────────────────────────────────────────────────────────────────
function renderTrends() {
  const dates = filteredRounds.map(r => r.date);
  trendLine('chart-score-trend', 'summary-score', dates, filteredRounds.map(r => r.score),       'Score',  C_GREEN);
  const puttsRounds = filteredRounds.filter(r => r.putts != null && r.putts > 0);
  trendLine('chart-putts-trend', 'summary-putts', puttsRounds.map(r => r.date), puttsRounds.map(r => r.putts), 'Putts', C_BLUE);
  trendLine('chart-gir-trend',   'summary-gir',   dates, filteredRounds.map(r => r.gir_pct),     'GIR %',  C_TEAL,   [0, 100]);
  trendLine('chart-fwy-trend',   'summary-fwy',   dates, filteredRounds.map(r => r.fairway_pct), 'FWY %',  C_PURPLE, [0, 100]);

  // Score vs Putts scatter
  const scatter = filteredRounds.filter(r => r.putts != null && r.score != null);
  if (scatter.length >= 2) {
    const px = scatter.map(r => r.putts), py = scatter.map(r => r.score);
    const mx = avg(px), my = avg(py);
    const num = px.reduce((s,x,i) => s+(x-mx)*(py[i]-my), 0);
    const dx  = Math.sqrt(px.reduce((s,x) => s+(x-mx)**2, 0));
    const dy  = Math.sqrt(py.reduce((s,y) => s+(y-my)**2, 0));
    const corr = num / (dx * dy);
    const slope = num / (dx * dx);
    const inter = my - slope * mx;
    const xr = [Math.min(...px), Math.max(...px)];
    Plotly.newPlot('chart-scatter', [
      { x: px, y: py, mode: 'markers', name: 'Round',
        marker: { color: C_GREEN, size: 9, opacity: 0.75 },
        text: scatter.map(r => `${r.date}<br>${r.course}`),
        hovertemplate: '%{text}<br>Putts: %{x}  Score: %{y}<extra></extra>' },
      { x: xr, y: xr.map(x => slope*x+inter), mode: 'lines', name: 'Trend',
        line: { color: C_RED, dash: 'dot', width: 2 } },
    ], L({ height: 300,
      xaxis: { ...AX, type: 'linear', title: { text: 'Putts', standoff: 6 } },
      yaxis: { ...AX, type: 'linear', title: { text: 'Score', standoff: 6 } },
    }), CFG);
    const rel = corr > 0.3 ? 'strong positive' : corr < -0.3 ? 'negative' : 'weak';
    setSummary('summary-scatter', `${rel.charAt(0).toUpperCase()+rel.slice(1)} relationship between putts and score (r = ${corr.toFixed(2)}).`);
  } else {
    noData('chart-scatter', 'Need at least 2 rounds');
  }
}

// ── Scoring tab ───────────────────────────────────────────────────────────────
const RESULT_ORDER  = ['Eagle or better', 'Birdie', 'Par', 'Bogey', 'Double', 'Triple+'];
const RESULT_COLORS = { 'Eagle or better': C_PURPLE, 'Birdie': C_BLUE, 'Par': C_NAVY,
                        'Bogey': C_GRAY, 'Double': C_RED, 'Triple+': C_CRIMSON };

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

function renderScoring() {
  const holesWithPar = filteredHoles.filter(h => h.par != null && h.score != null);
  const hasPar = holesWithPar.length > 0;

  // Scoring summary donut
  if (hasPar) {
    const counts = Object.fromEntries(RESULT_ORDER.map(r => [r, 0]));
    holesWithPar.forEach(h => { const c = classifyHole(h); if (c) counts[c]++; });
    const total = holesWithPar.length;
    const parOrBetter = counts['Eagle or better'] + counts['Birdie'] + counts['Par'];
    const pct = ((parOrBetter / total) * 100).toFixed(0);

    Plotly.newPlot('chart-scoring-donut', [{
      labels: RESULT_ORDER,
      values: RESULT_ORDER.map(r => counts[r]),
      type: 'pie', hole: 0.55,
      marker: { colors: RESULT_ORDER.map(r => RESULT_COLORS[r]) },
      hovertemplate: '%{label}: %{value} holes (%{percent})<extra></extra>',
    }], L({ height: 280, showlegend: true,
      legend: { orientation: 'v', x: 1.02, y: 0.5, font: { size: 11 } },
      annotations: [{ text: `<b>${pct}%</b><br>Par or<br>Better`, x: 0.5, y: 0.5,
        font: { size: 14, color: C_NAVY }, showarrow: false }],
    }), CFG);
    const top = RESULT_ORDER.reduce((a, b) => counts[b] > counts[a] ? b : a);
    setSummary('summary-scoring-donut',
      `${pct}% par or better. Most common result: ${top} (${counts[top]} holes, ${((counts[top]/total)*100).toFixed(1)}%).`);
  } else {
    noData('chart-scoring-donut', 'Par data required');
  }

  // Par 3/4/5 breakdown
  if (hasPar) {
    const parGroups = [3, 4, 5];
    const parAvg = parGroups.map(p => {
      const hs = holesWithPar.filter(h => h.par === p);
      return { par: p, avg_vs_par: avg(hs.map(h => h.score - h.par)), count: hs.length };
    }).filter(d => d.count > 0);

    if (parAvg.length) {
      Plotly.newPlot('chart-par-breakdown', [{
        x: parAvg.map(d => `Par ${d.par}<br>(${d.count} holes)`),
        y: parAvg.map(d => d.avg_vs_par),
        type: 'bar',
        text: parAvg.map(d => d.avg_vs_par != null ? (d.avg_vs_par > 0 ? `+${d.avg_vs_par.toFixed(2)}` : d.avg_vs_par.toFixed(2)) : ''),
        textposition: 'outside',
        marker: { color: parAvg.map(d => (d.avg_vs_par ?? 0) > 0 ? C_RED : (d.avg_vs_par ?? 0) < 0 ? C_BLUE : C_GREEN) },
        hovertemplate: 'Par %{x}: avg %{y:+.2f}<extra></extra>',
      }], L({ showlegend: false,
        xaxis: catAxis(),
        yaxis: { ...AX, type: 'linear', zeroline: true, zerolinecolor: '#94a3b8', zerolinewidth: 2 },
      }), CFG);
      const worst = parAvg.reduce((a, b) => (b.avg_vs_par??-99) > (a.avg_vs_par??-99) ? b : a);
      setSummary('summary-par-breakdown', `Weakest on Par ${worst.par} (avg ${worst.avg_vs_par > 0 ? '+' : ''}${worst.avg_vs_par?.toFixed(2)}).`);
    }
  } else {
    noData('chart-par-breakdown', 'Par data required');
  }

  // Scoring by round stacked bar
  if (hasPar) {
    const roundIds = filteredRounds.map(r => r.activity_id);
    const labels = filteredRounds.map(r => `${r.date.slice(5)}<br>${r.course.length > 14 ? r.course.slice(0,14)+'…' : r.course}`);
    const stackData = Object.fromEntries(RESULT_ORDER.map(cat => [cat, roundIds.map(actId => {
      const hs = filteredHoles.filter(h => h.activity_id === actId && h.par != null && h.score != null);
      return hs.filter(h => classifyHole(h) === cat).length;
    })]));

    const traces = RESULT_ORDER.map(cat => ({
      x: labels,
      y: stackData[cat],
      name: cat,
      type: 'bar',
      marker: { color: RESULT_COLORS[cat] },
    }));
    Plotly.newPlot('chart-scoring-stacked', traces,
      L({ height: 300, barmode: 'stack',
        xaxis: catAxis(),
        yaxis: { ...AX, type: 'linear', title: { text: 'Holes', standoff: 6 } },
      }), CFG);
    setSummary('summary-scoring-stacked', 'Hole-by-hole scoring breakdown per round. Taller green = stronger round.');
  } else {
    noData('chart-scoring-stacked', 'Par data required for stacked breakdown');
  }

  // Scoring distribution bar
  if (hasPar) {
    const counts = Object.fromEntries(RESULT_ORDER.map(r => [r, 0]));
    holesWithPar.forEach(h => { const c = classifyHole(h); if (c) counts[c]++; });
    Plotly.newPlot('chart-score-dist', [{
      x: RESULT_ORDER, y: RESULT_ORDER.map(r => counts[r]),
      type: 'bar',
      marker: { color: RESULT_ORDER.map(r => RESULT_COLORS[r]) },
      hovertemplate: '%{x}: %{y} holes<extra></extra>',
    }], L({ height: 220, showlegend: false, xaxis: catAxis() }), CFG);
    const total = holesWithPar.length;
    const bbb = counts['Eagle or better'] + counts['Birdie'];
    setSummary('summary-score-dist',
      `Birdie-or-better: ${((bbb/total)*100).toFixed(1)}%. ` +
      `Bogey or worse: ${(((counts['Bogey']+counts['Double']+counts['Triple+'])/total)*100).toFixed(1)}%.`);
  } else {
    noData('chart-score-dist', 'Par data required');
  }
}

// ── Putting tab ───────────────────────────────────────────────────────────────
function renderPutting() {
  const holesWithPutts = filteredHoles.filter(h => h.putts != null);

  // Putting summary donut
  if (holesWithPutts.length > 0) {
    const one   = holesWithPutts.filter(h => h.putts <= 1).length;
    const two   = holesWithPutts.filter(h => h.putts === 2).length;
    const three = holesWithPutts.filter(h => h.putts >= 3).length;
    const total = holesWithPutts.length;
    const twoPlusOne = one + two;
    const twoPlusPct = ((twoPlusOne / total) * 100).toFixed(0);

    Plotly.newPlot('chart-putting-donut', [{
      labels: ['1 Putt or Better', '2 Putts', '3 Putts or Worse'],
      values: [one, two, three],
      type: 'pie', hole: 0.55,
      marker: { colors: [C_TEAL, C_NAVY, C_RED] },
      hovertemplate: '%{label}: %{value} holes (%{percent})<extra></extra>',
    }], L({ height: 280, showlegend: true,
      legend: { orientation: 'v', x: 1.02, y: 0.5, font: { size: 11 } },
      annotations: [{ text: `<b>${twoPlusPct}%</b><br>2 Putts<br>or Better`, x: 0.5, y: 0.5,
        font: { size: 14, color: C_NAVY }, showarrow: false }],
    }), CFG);
    const onePct   = ((one/total)*100).toFixed(1);
    const threePct = ((three/total)*100).toFixed(1);
    const avgP = avg(holesWithPutts.map(h => h.putts));
    setSummary('summary-putting-donut',
      `Avg ${fmt(avgP)} putts/hole. 1-putt: ${onePct}% · 3-putt: ${threePct}%.`);
  } else {
    noData('chart-putting-donut', 'No putt data');
  }

  // 1-putt % by round trend
  const onePuttByRound = filteredRounds.map(r => {
    const hs = filteredHoles.filter(h => h.activity_id === r.activity_id && h.putts != null);
    if (!hs.length) return null;
    return (hs.filter(h => h.putts <= 1).length / hs.length) * 100;
  });
  trendLine('chart-1putt-trend', 'summary-1putt-trend',
    filteredRounds.map(r => r.date), onePuttByRound, '1-Putt %', C_TEAL, [0, 100]);

  // 3-putt free streak
  renderStreakChart();

  // Avg putts by hole
  const holeNums = [...new Set(filteredHoles.map(h => h.hole))].sort((a,b) => a-b);
  const puttData = holeNums.map(n => {
    const hs = filteredHoles.filter(h => h.hole === n && h.putts != null);
    return hs.length ? { hole: n, avg_putts: avg(hs.map(h => h.putts)) } : null;
  }).filter(Boolean);

  if (puttData.length > 0) {
    Plotly.newPlot('chart-hole-putts', [{
      x: puttData.map(d => `H${d.hole}`), y: puttData.map(d => d.avg_putts),
      type: 'bar', marker: { color: C_BLUE },
      hovertemplate: 'Hole %{x}: %{y:.2f} putts<extra></extra>',
    }], L({ showlegend: false, xaxis: catAxis(),
      yaxis: { ...AX, type: 'linear', range: [0, Math.max(4, Math.ceil(Math.max(...puttData.map(d=>d.avg_putts))+0.5))] },
    }), CFG);
    const best  = puttData.reduce((a,b) => b.avg_putts < a.avg_putts ? b : a);
    const worst = puttData.reduce((a,b) => b.avg_putts > a.avg_putts ? b : a);
    setSummary('summary-hole-putts',
      `Best: H${best.hole} (${best.avg_putts.toFixed(2)}). Worst: H${worst.hole} (${worst.avg_putts.toFixed(2)}). Baseline ~2/hole.`);
  } else {
    noData('chart-hole-putts', 'No putt data');
  }

  // Putts per round trend handled in Trends tab
}

function renderStreakChart() {
  // Walk rounds in order and compute consecutive 3-putt-free holes
  const streaks = [];
  let current = 0;

  for (const round of filteredRounds) {
    const roundHoles = filteredHoles
      .filter(h => h.activity_id === round.activity_id && h.putts != null)
      .sort((a, b) => a.hole - b.hole);

    for (const h of roundHoles) {
      if (h.putts <= 2) {
        current++;
      } else {
        if (current >= 2) streaks.push({ date: round.date, length: current, active: false });
        current = 0;
      }
    }
    // After each round, if current streak ended in this round record inline (not cross-round carry)
    // We'll push trailing streaks at round end for readability
    if (current >= 2 && roundHoles.length > 0) {
      // Peek: does it continue into next round? We'll finalize at end
    }
  }
  // Final active streak
  if (current >= 1) streaks.push({ date: filteredRounds.at(-1)?.date ?? '', length: current, active: true });

  if (!streaks.length) {
    noData('chart-streak', 'No 3-putt free streaks of 2+ holes found');
    setSummary('summary-streak', '');
    return;
  }

  const completed = streaks.filter(s => !s.active);
  const active    = streaks.find(s => s.active);
  const allLengths = streaks.map(s => s.length);
  const avgLen = avg(allLengths);

  const traces = [];
  if (completed.length) {
    traces.push({
      x: completed.map(s => s.date),
      y: completed.map(s => s.length),
      type: 'bar', name: '3-Putt Free Streak',
      marker: { color: C_NAVY },
      text: completed.map(s => s.length),
      textposition: 'outside',
    });
  }
  if (active) {
    traces.push({
      x: [active.date], y: [active.length],
      type: 'bar', name: 'Active Streak',
      marker: { color: C_LIME },
      text: [active.length], textposition: 'outside',
    });
  }
  // Avg putts overlay
  const avgPuttsByDate = filteredRounds.map(r => {
    const hs = filteredHoles.filter(h => h.activity_id === r.activity_id && h.putts != null);
    return { date: r.date, avg: hs.length ? avg(hs.map(h => h.putts)) : null };
  }).filter(d => d.avg != null);

  if (avgPuttsByDate.length) {
    traces.push({
      x: avgPuttsByDate.map(d => d.date),
      y: avgPuttsByDate.map(d => d.avg),
      type: 'scatter', mode: 'lines+markers', name: 'Avg Putts/Hole',
      yaxis: 'y2',
      line: { color: C_BLUE, width: 2 },
      marker: { color: C_BLUE, size: 5 },
    });
  }

  Plotly.newPlot('chart-streak', traces, L({
    height: 320,
    barmode: 'group',
    xaxis: { ...AX, type: 'category' },
    yaxis: { ...AX, type: 'linear', title: { text: 'Holes', standoff: 6 } },
    yaxis2: { overlaying: 'y', side: 'right', type: 'linear', showgrid: false,
      title: { text: 'Avg Putts/Hole', standoff: 6 }, tickfont: { color: C_BLUE } },
    annotations: [{ text: `Avg: ${avgLen?.toFixed(1)} holes`, xref: 'paper', yref: 'paper',
      x: 1, y: 1.06, showarrow: false, font: { color: C_GRAY, size: 11 } }],
  }), CFG);
  const longest = Math.max(...allLengths);
  setSummary('summary-streak',
    `Longest 3-putt-free streak: ${longest} holes. Avg streak: ${avgLen?.toFixed(1)} holes. ` +
    (active ? `Current active streak: ${active.length} hole${active.length !== 1 ? 's' : ''}.` : ''));
}

// ── Holes tab ─────────────────────────────────────────────────────────────────
function renderHoles() {
  if (!filteredHoles.length) {
    ['chart-hole-score','chart-hole-gir','chart-miss-direction','chart-hole-penalties']
      .forEach(id => noData(id, 'No hole-level data'));
    return;
  }

  const holeNums = [...new Set(filteredHoles.map(h => h.hole))].sort((a,b) => a-b);

  // Score vs par by hole
  const holeStats = holeNums.map(n => {
    const hs    = filteredHoles.filter(h => h.hole === n);
    const scores = hs.map(h => h.score).filter(s => s != null);
    const pars   = hs.map(h => h.par).filter(p => p != null);
    return { hole: n, avg_score: avg(scores), avg_par: avg(pars),
      avg_vs_par: avg(scores) != null && avg(pars) != null ? avg(scores) - avg(pars) : null };
  });

  if (holeStats.some(d => d.avg_vs_par != null)) {
    const d = holeStats.filter(d => d.avg_vs_par != null);
    Plotly.newPlot('chart-hole-score', [{
      x: d.map(d => `H${d.hole}`), y: d.map(d => d.avg_vs_par),
      type: 'bar',
      marker: { color: d.map(d => (d.avg_vs_par??0) > 0 ? C_RED : (d.avg_vs_par??0) < 0 ? C_BLUE : C_GREEN) },
      hovertemplate: 'Hole %{x}: %{y:+.2f}<extra></extra>',
    }], L({ showlegend: false, xaxis: catAxis(),
      yaxis: { ...AX, type: 'linear', zeroline: true, zerolinecolor: '#94a3b8', zerolinewidth: 2 },
    }), CFG);
    const hardest = d.reduce((a,b) => (b.avg_vs_par??-99) > (a.avg_vs_par??-99) ? b : a);
    const easiest = d.reduce((a,b) => (b.avg_vs_par??99)  < (a.avg_vs_par??99)  ? b : a);
    setSummary('summary-hole-score',
      `Hardest: H${hardest.hole} (${hardest.avg_vs_par > 0?'+':''}${hardest.avg_vs_par?.toFixed(2)}). ` +
      `Easiest: H${easiest.hole} (${easiest.avg_vs_par > 0?'+':''}${easiest.avg_vs_par?.toFixed(2)}).`);
  } else {
    const d = holeStats.filter(d => d.avg_score != null);
    Plotly.newPlot('chart-hole-score', [{
      x: d.map(d => `H${d.hole}`), y: d.map(d => d.avg_score),
      type: 'bar', marker: { color: C_GREEN },
    }], L({ showlegend: false, xaxis: catAxis() }), CFG);
    setSummary('summary-hole-score', 'Par data not available — showing average raw score per hole.');
  }

  // GIR % by hole
  const girData = holeNums.map(n => {
    const hs = filteredHoles.filter(h => h.hole === n && h.gir != null);
    return hs.length ? { hole: n, gir_pct: (hs.filter(h => h.gir).length / hs.length) * 100 } : null;
  }).filter(Boolean);

  if (girData.length) {
    Plotly.newPlot('chart-hole-gir', [{
      x: girData.map(d => `H${d.hole}`), y: girData.map(d => d.gir_pct),
      type: 'bar', marker: { color: C_TEAL },
      hovertemplate: 'H%{x}: %{y:.1f}%<extra></extra>',
    }], L({ showlegend: false, xaxis: catAxis(),
      yaxis: { ...AX, type: 'linear', range: [0, 100] },
    }), CFG);
    const best  = girData.reduce((a,b) => b.gir_pct > a.gir_pct ? b : a);
    const worst = girData.reduce((a,b) => b.gir_pct < a.gir_pct ? b : a);
    setSummary('summary-hole-gir', `Best GIR: H${best.hole} (${best.gir_pct.toFixed(1)}%). Lowest: H${worst.hole} (${worst.gir_pct.toFixed(1)}%).`);
  } else {
    noData('chart-hole-gir', 'No GIR data');
  }

  // Fairway miss direction
  const misses = filteredHoles.filter(h => h.fairway_missed);
  if (misses.length) {
    const counts = {};
    misses.forEach(h => { counts[h.fairway_missed] = (counts[h.fairway_missed]||0)+1; });
    const labels = Object.keys(counts), values = Object.values(counts);
    Plotly.newPlot('chart-miss-direction', [{
      labels, values, type: 'pie', hole: 0.42,
      marker: { colors: labels.map(l => l==='LEFT' ? C_RED : C_BLUE) },
    }], L({ height: 220, showlegend: true, legend: { orientation: 'v', x:1, y:0.5 } }), CFG);
    const top = labels.reduce((a,b) => counts[b]>counts[a]?b:a);
    const pct = (counts[top]/values.reduce((a,b)=>a+b,0)*100).toFixed(1);
    setSummary('summary-miss-direction', `Most misses are ${top} (${pct}%).`);
  } else {
    noData('chart-miss-direction', 'No fairway miss data');
  }

  // Penalties by hole
  const penData = holeNums.map(n => {
    const hs = filteredHoles.filter(h => h.hole === n);
    const total = hs.reduce((s,h) => s+(h.penalties||0), 0);
    return { hole: n, penalties: total, rounds: hs.length };
  }).filter(d => d.penalties > 0);

  if (penData.length) {
    Plotly.newPlot('chart-hole-penalties', [{
      x: penData.map(d => `H${d.hole}`), y: penData.map(d => d.penalties),
      type: 'bar', marker: { color: C_ORANGE },
      hovertemplate: 'H%{x}: %{y} total penalties<extra></extra>',
    }], L({ showlegend: false, xaxis: catAxis() }), CFG);
  } else {
    noData('chart-hole-penalties', 'No penalty data');
  }
}

// ── Clubs tab ─────────────────────────────────────────────────────────────────
function renderClubs() {
  const valid = filteredShots.filter(s => s.distance_yards != null && s.distance_yards > 0);

  if (!valid.length) {
    ['chart-club-box','chart-club-usage','chart-lie-distance','chart-drive-trend']
      .forEach(id => noData(id, 'No club/shot data available'));
    return;
  }

  const clubs = [...new Set(valid.map(s => s.club_name))].filter(Boolean);

  // Box plot by club — hover shows key stats
  Plotly.newPlot('chart-club-box',
    clubs.map(club => {
      const dists = valid.filter(s => s.club_name === club).map(s => s.distance_yards);
      const clubAvg = avg(dists)?.toFixed(1);
      const clubMed = median(dists)?.toFixed(1);
      const clubSd  = stddev(dists)?.toFixed(1);
      return {
        x: dists.map(()=>club), y: dists, type: 'box', name: club, boxpoints: 'outliers',
        hovertemplate: `<b>%{x}</b><br>Median: ${clubMed} yds<br>Avg: ${clubAvg} yds<br>Std Dev: ${clubSd} yds<br>Shots: ${dists.length}<extra></extra>`,
      };
    }),
    L({ height: 320, showlegend: false,
      xaxis: { ...AX, type: 'category' },
      yaxis: { ...AX, type: 'linear', title: { text: 'Yards', standoff: 6 } },
    }), CFG);

  const clubStats = clubs.map(club => {
    const dists = valid.filter(s => s.club_name === club).map(s => s.distance_yards);
    return { club, avg: avg(dists), med: median(dists), sd: stddev(dists),
      min: Math.min(...dists), max: Math.max(...dists), count: dists.length };
  }).sort((a,b) => (b.med??0) - (a.med??0));

  const longest = clubStats[0];
  setSummary('summary-club-box', `Longest median club: ${longest.club} at ${longest.med?.toFixed(1)} yards.`);

  // Shot distance by lie (box plot)
  const lies = [...new Set(valid.map(s => s.lie))].filter(l => l && l !== 'Unknown');
  if (lies.length) {
    Plotly.newPlot('chart-lie-distance',
      lies.map(lie => {
        const dists = valid.filter(s => s.lie === lie).map(s => s.distance_yards);
        return { x: dists.map(()=>lie), y: dists, type: 'box', name: lie, boxpoints: false };
      }),
      L({ showlegend: false,
        xaxis: { ...AX, type: 'category' },
        yaxis: { ...AX, type: 'linear', title: { text: 'Yards', standoff: 6 } },
      }), CFG);
    const lieAvgs = lies.map(lie => {
      const dists = valid.filter(s => s.lie === lie).map(s => s.distance_yards);
      return { lie, avg: avg(dists) };
    }).sort((a,b) => (b.avg??0)-(a.avg??0));
    setSummary('summary-lie-distance',
      lieAvgs.map(l => `${l.lie}: ${l.avg?.toFixed(1)} yds`).join(' · '));
  } else {
    noData('chart-lie-distance', 'No lie data');
  }

  // Club usage bar
  const usage = clubs.map(c => ({ c, n: valid.filter(s => s.club_name===c).length })).sort((a,b)=>b.n-a.n);
  Plotly.newPlot('chart-club-usage', [{
    x: usage.map(u=>u.c), y: usage.map(u=>u.n), type: 'bar', marker: { color: C_GREEN },
    hovertemplate: '%{x}: %{y} shots<extra></extra>',
  }], L({ showlegend: false, xaxis: catAxis() }), CFG);
  setSummary('summary-club-usage', `Most-used: ${usage[0].c} (${usage[0].n} shots).`);

  // Driving distance trend (TeeBox shots averaged per round)
  const teeShots = valid.filter(s => s.lie === 'TeeBox');
  if (teeShots.length) {
    const driveByRound = filteredRounds.map(r => {
      const shots = teeShots.filter(s => s.activity_id === r.activity_id);
      return shots.length ? avg(shots.map(s => s.distance_yards)) : null;
    });
    trendLine('chart-drive-trend', 'summary-drive-trend',
      filteredRounds.map(r => r.date), driveByRound, 'Avg Drive (yds)', C_ORANGE);
  } else {
    noData('chart-drive-trend', 'No tee shot data');
    setSummary('summary-drive-trend', '');
  }
}

// ── Scorecards tab ────────────────────────────────────────────────────────────
function renderScorecardSelector() {
  const sorted = filteredRounds.slice()
    .sort((a,b) => b.date.localeCompare(a.date))
    .filter(r => r.score != null);
  const sel = document.getElementById('scorecard-selector');
  sel.innerHTML = sorted.map(r =>
    `<option value="${r.activity_id}">${r.date} — ${r.course} (Score: ${r.score})</option>`
  ).join('') || '<option value="">No rounds available</option>';
  if (sorted.length) renderScorecard(sorted[0].activity_id);
  else document.getElementById('scorecard-table').innerHTML = '';
}

function renderScorecard(actId) {
  const holes = filteredHoles.filter(h => h.activity_id === actId).sort((a,b)=>a.hole-b.hole);
  if (!holes.length) {
    document.getElementById('scorecard-table').innerHTML = '<div class="no-data">No hole detail for this round.</div>';
    return;
  }
  const totalScore  = holes.reduce((a,h)=>a+(h.score||0),0);
  const allHavePar  = holes.every(h=>h.par!=null);
  const totalPar    = allHavePar ? holes.reduce((a,h)=>a+(h.par||0),0) : null;
  const totalPutts  = holes.reduce((a,h)=>a+(h.putts||0),0);
  const girCount    = holes.filter(h=>h.gir===true).length;
  const girTotal    = holes.filter(h=>h.gir!=null).length;
  const fwyHit      = holes.filter(h=>h.fairway_hit===true).length;
  const fwyTotal    = holes.filter(h=>h.fairway_hit!=null).length;
  const totalPen    = holes.reduce((a,h)=>a+(h.penalties||0),0);
  const allHaveYd   = holes.every(h=>h.yardage!=null);
  const totalYards  = allHaveYd ? holes.reduce((a,h)=>a+h.yardage,0) : null;

  const vsPar     = totalPar != null ? totalScore - totalPar : null;
  const vsParStr  = vsPar != null ? (vsPar > 0 ? `+${vsPar}` : `${vsPar}`) : null;
  const vsParCls  = vsPar != null ? (vsPar < 0 ? 'birdie' : vsPar > 0 ? 'bogey' : '') : '';

  const holeHeaders = holes.map(h => `<th>${h.hole}</th>`).join('');
  const parRow      = holes.map(h => `<td>${h.par??'—'}</td>`).join('');
  const scoreRow    = holes.map(h => {
    const diff = h.par != null && h.score != null ? h.score - h.par : null;
    const cls  = diff != null ? (diff < 0 ? 'birdie' : diff === 0 ? '' : diff === 1 ? 'bogey' : 'double-plus') : '';
    return `<td class="score-cell ${cls}"><strong>${h.score??'—'}</strong></td>`;
  }).join('');
  const puttsRow    = holes.map(h => `<td>${h.putts??'—'}</td>`).join('');
  const girRow      = holes.map(h => `<td>${fmtBool(h.gir)}</td>`).join('');
  const fwyRow      = holes.map(h => `<td>${fmtBool(h.fairway_hit)}</td>`).join('');
  const penRow      = holes.map(h => `<td>${h.penalties??0}</td>`).join('');
  const ydRow       = holes.map(h => `<td>${h.yardage??'—'}</td>`).join('');

  const roundShots = allShots.filter(s => s.activity_id === actId);
  const teeShots   = roundShots.filter(s => s.shot_type === 'TEE' || s.lie === 'TeeBox');
  const longestDrive = teeShots.length
    ? Math.round(Math.max(...teeShots.map(s => s.distance_yards ?? 0)))
    : null;

  document.getElementById('scorecard-table').innerHTML = `
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
      <div class="sc-sum-item">
        <span class="sc-sum-label">Score</span>
        <span class="sc-sum-value">${totalScore}${vsParStr != null ? ` <span class="sc-vs-par ${vsParCls}">(${vsParStr})</span>` : ''}</span>
      </div>
      <div class="sc-sum-item">
        <span class="sc-sum-label">Putts</span>
        <span class="sc-sum-value">${totalPutts}</span>
      </div>
      ${girTotal > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">GIR</span><span class="sc-sum-value">${girCount}/${girTotal}</span></div>` : ''}
      ${fwyTotal > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Fairways</span><span class="sc-sum-value">${fwyHit}/${fwyTotal}</span></div>` : ''}
      ${totalPen > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Penalties</span><span class="sc-sum-value">${totalPen}</span></div>` : ''}
      ${totalYards != null ? `<div class="sc-sum-item"><span class="sc-sum-label">Yards</span><span class="sc-sum-value">${totalYards.toLocaleString()}</span></div>` : ''}
      ${longestDrive != null && longestDrive > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Longest Drive</span><span class="sc-sum-value">${longestDrive} yds</span></div>` : ''}
    </div>`;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function setupFilters() {
  const courses = [...new Set(allRounds.map(r=>r.course))].sort();
  const sel = document.getElementById('filter-course');
  courses.forEach(c => { const o=document.createElement('option'); o.value=o.textContent=c; sel.appendChild(o); });
  const defaultCourse = courses.find(c => c.toLowerCase().includes('manchester'));
  if (defaultCourse) sel.value = defaultCourse;

  document.getElementById('filter-holes').value = '18';

  const dates = allRounds.map(r=>r.date).filter(Boolean).sort();
  if (dates.length) {
    document.getElementById('filter-date-from').value = dates[0];
    document.getElementById('filter-date-to').value   = dates[dates.length-1];
  }

  ['filter-course','filter-holes','filter-date-from','filter-date-to'].forEach(id =>
    document.getElementById(id).addEventListener('change', applyFilters));

  document.getElementById('scorecard-selector').addEventListener('change', e => renderScorecard(e.target.value));

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'clubs' || btn.dataset.tab === 'scorecards') {
      await loadShots();
      if (btn.dataset.tab === 'clubs') renderClubs();
      else renderScorecardSelector();
    }
  }));
}

function updateAll() {
  updateKPIs();
  renderTrends();
  renderScoring();
  renderPutting();
  renderHoles();
  renderClubs();
  renderScorecardSelector();
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadData();
    setupFilters();
    if (lastUpdated) document.getElementById('last-updated').textContent = `Last synced: ${lastUpdated}`;
    applyFilters();
  } catch (err) {
    document.body.innerHTML = `
      <div style="padding:40px;font-family:sans-serif;color:#dc2626">
        <h2>Failed to load rounds.json</h2><p>${err.message}</p>
        <p style="color:#64748b;margin-top:8px">Serve via HTTP, not file:// — run: python3 -m http.server 8765</p>
      </div>`;
  }
}

init();
