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
const RINGER_START_KEY = 'golfstats.ringer_start_date';
const DIVISION_DAYS = new Set([0, 4, 6]);

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
let aliasIndex = {};          // lowercased alias -> canonical name (module-level so manage panel can read it)
let rawCoursesData = [];      // original courses array from file, used by export
let lastUpdated = null;
let shotsLoaded = false;
let shotsLoading = null;
let mode = 'overall';
let currentPanel = 'stats';
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
function catAxis(overrides = {}) { return { ...AX, type: 'category', showgrid: false, ...overrides }; }

// ── Breakdown helpers (stat strips, SVG charts) ────────────────────────────────
const BD = { green: '#16a34a', greenD: '#15803d', greenL: '#dcfce7', red: '#dc2626', text: '#0f172a',
  muted: '#64748b', subtle: '#94a3b8', light: '#f1f5f9', panel: '#f8fafc', blue: '#3b82f6', orange: '#f97316' };
const svgOpen = (w, h, extra = '') => `<svg viewBox="0 0 ${w} ${h}" width="100%" ${extra}>`;
const svgText = (x, y, s, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${s}</text>`;
const pctOf = (n, d) => d ? Math.round(100 * n / d) : null;
const shortDate = iso => iso ? `${MONTH_ABB[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}` : '';
// Charts are drawn at the container's real width so text stays at its natural size.
function chartWidth(el, fallback = 640) { return Math.max(280, Math.round(el?.clientWidth || fallback)); }

// items: [{ value, label, cls?, big?, sub? }]
function statStrip(items) {
  return `<div class="stat-strip">${items.map(i => `<div class="${i.big ? 'big' : ''}"><b class="${i.cls || ''}"${i.color ? ` style="color:${i.color}"` : ''}>${i.value}</b><span>${i.label}</span>${i.sub ? `<small>${i.sub}</small>` : ''}</div>`).join('')}</div>`;
}
function legend(items) {
  return `<div class="bd-legend">${items.map(([color, label, cls = '']) => `<span><i class="${cls}" style="background:${color}"></i>${label}</span>`).join('')}</div>`;
}
// Arrow + amount vs a comparison value; lowerBetter flips which direction is good.
function deltaHtml(now, before, lowerBetter, unit = '', vsLabel = 'vs prev') {
  if (now == null || before == null) return '<span class="delta flat">&nbsp;</span>';
  const d = now - before;
  if (Math.abs(d) < 0.05) return `<span class="delta flat">no change ${vsLabel}</span>`;
  const good = lowerBetter ? d < 0 : d > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${r1(Math.abs(d))}${unit} ${vsLabel}</span>`;
}
function sparkline(vals, color = BD.green, w = 120, h = 26) {
  const pts0 = vals.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts0.length < 2) return '';
  const vs = pts0.map(p => p[1]), lo = Math.min(...vs), hi = Math.max(...vs);
  const pts = pts0.map(([i, v]) => [w * i / Math.max(1, vals.length - 1), h - 3 - (h - 6) * (v - lo) / ((hi - lo) || 1)]);
  const last = pts.at(-1);
  return `${svgOpen(w, h, `style="max-width:${w}px"`)}<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="1.6" opacity=".8"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${color}"/></svg>`;
}
// The same number of rounds immediately before `rounds`, under the same round-length filter.
function priorWindow(rounds) {
  if (!rounds.length) return [];
  const holes = document.getElementById('filter-holes').value;
  return allRounds.filter(r => r.date < rounds[0].date && r.score > 0
      && (!holes || r.holes_played === +holes))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-rounds.length);
}

function isoWeekday(isoDate) {
  const parts = (isoDate || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isDivisionDay(isoDate) {
  const wd = isoWeekday(isoDate);
  return wd != null && DIVISION_DAYS.has(wd);
}

// Resolve a course string to its metadata using the module-level alias index.
function getCourseMeta(courseStr) {
  if (!courseStr) return null;
  const key = courseStr.toLowerCase();
  if (aliasIndex[key]) return courseMeta[aliasIndex[key]];
  for (const [alias, canon] of Object.entries(aliasIndex)) {
    if (key.includes(alias) || alias.includes(key)) return courseMeta[canon];
  }
  return null;
}

// Format date strings (YYYY-MM-DD) as sparse tick labels.
// Shows the month abbreviation only the first time each month appears.
// Appends ''YY the first time a new year appears.
const MONTH_ABB = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dateTicks(dates) {
  if (!dates.length) return [];
  // Choose granularity by span so a 3-year "All time" view isn't labelled monthly.
  const first = dates[0], last = dates[dates.length - 1];
  const spanMonths = (+last.slice(0, 4) - +first.slice(0, 4)) * 12
    + (+last.slice(5, 7) - +first.slice(5, 7));
  const mode = spanMonths > 48 ? 'year' : spanMonths > 18 ? 'quarter' : 'month';

  let lastBucket = null, lastYear = null;
  return dates.map(d => {
    const [y, m] = d.split('-');
    const q = Math.floor((+m - 1) / 3);
    const bucket = mode === 'year' ? y : mode === 'quarter' ? `${y}-q${q}` : `${y}-${m}`;
    if (bucket === lastBucket) return '';
    lastBucket = bucket;
    if (mode === 'year') return `'${y.slice(2)}`;
    const label = mode === 'quarter' ? MONTH_ABB[q * 3] : MONTH_ABB[+m - 1];
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

  rawCoursesData = coursesData.courses || [];

  // Build course metadata + alias index (module-level) from courses.json
  aliasIndex = {};
  for (const c of rawCoursesData) {
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

  // Apply any aliases/courses saved via the Course Manager panel (stored in localStorage)
  const _savedAliases = JSON.parse(localStorage.getItem('golfstats.aliases') || '{}');
  for (const [alias, canon] of Object.entries(_savedAliases)) {
    if (courseMeta[canon]) aliasIndex[alias.toLowerCase()] = canon;
  }
  const _savedCourses = JSON.parse(localStorage.getItem('golfstats.new_courses') || '[]');
  for (const c of _savedCourses) {
    if (courseMeta[c.name]) continue;
    const hp = {}, hy = {}, hh = {};
    for (const h of c.holes || []) {
      if (h.par != null) hp[h.hole] = h.par;
      if (h.yardage != null) hy[h.hole] = h.yardage;
      if (h.handicap != null) hh[h.hole] = h.handicap;
    }
    courseMeta[c.name] = { name: c.name, par: c.par, rating: c.rating, slope: c.slope,
      yards: c.yards, tee_box: c.tee_box, holePar: hp, holeYd: hy, holeHcp: hh };
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
      sg:                r.strokes_gained   ?? null,
      duration_seconds:  r.duration_seconds ?? null,
      distance_meters:   r.distance_meters  ?? null,
      front_nine:        r.front_nine       ?? null,
      back_nine:         r.back_nine        ?? null,
      hcap_index:        r.hcap_index       ?? null,
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
        club_type_name: s.club_type_name || null,
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
  const range    = document.getElementById('filter-range')?.value || 'custom';
  const useDates = range === 'custom';
  const dateFrom = range === 'thisyear' ? `${new Date().getFullYear()}-01-01`
    : useDates ? document.getElementById('filter-date-from').value : '';
  const dateTo   = useDates ? document.getElementById('filter-date-to').value : '';
  const rounds = allRounds.filter(r => {
    if (holes === '18' && r.holes_played !== 18) return false;
    if (holes === '9'  && r.holes_played !== 9)  return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo   && r.date > dateTo)   return false;
    if (!r.score || r.score <= 0)               return false;
    if (!r.holes_played || r.holes_played <= 0) return false;
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
  // "Last N rounds" presets keep the WHS-style rolling window.
  const n = range === 'last20' ? 20 : range === 'last50' ? 50 : null;
  return n ? rounds.slice(-n) : rounds;
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

// ── Shared trend-direction helper ──────────────────────────────────────────────
// Compares the first-N vs last-N average (N up to 5) instead of two single
// rounds, and phrases the direction using higherIsBetter so "improving" always
// means the metric moved the good way.
function trendTail(valid, higherIsBetter = false, toFixed = 1) {
  if (!valid || valid.length < 4) return '';
  const n = Math.min(5, Math.floor(valid.length / 2));
  const firstAvg = avg(valid.slice(0, n));
  const lastAvg = avg(valid.slice(-n));
  const delta = lastAvg - firstAvg;
  if (Math.abs(delta) < 0.05) return ` · flat (first ${n} vs last ${n})`;
  const arrow = delta < 0 ? '↓' : '↑';
  const better = higherIsBetter ? delta > 0 : delta < 0;
  return ` · ${arrow} ${better ? 'improving' : 'declining'} ${Math.abs(delta).toFixed(toFixed)} (first ${n} vs last ${n})`;
}

// ── Shared trend-line helper ────────────────────────────────────────────────────
// Annotated trend: shaded "normal range" (avg ± 1 sd), 3-round average, best and
// worst rounds tagged, and a stat strip underneath. `extraStats` adds strip cells.
function trendLine(chartId, summaryId, dates, vals, label, color, yRange = null, higherIsBetter = false, extraStats = []) {
  const el = document.getElementById(chartId);
  const pts = dates.map((d, i) => ({ d, v: vals[i] })).filter(p => p.v != null);
  if (!el) return;
  if (!pts.length) { noData(chartId, `No ${label} data`); if (summaryId) setSummary(summaryId, ''); return; }
  if (summaryId) setSummary(summaryId, '');
  const sfx = /%/.test(label) ? '%' : '';
  const vs = pts.map(p => p.v), n = vs.length;
  const mean = avg(vs), sd = stddev(vs) || 0;
  const W = chartWidth(el), H = chartId === 'chart-o-trends' ? 280 : 220;
  const Lm = 36, Rm = 14, T = 26, B = 24;
  let lo = Math.min(...vs, mean - sd), hi = Math.max(...vs, mean + sd);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  if (yRange) { lo = Math.max(yRange[0], lo); hi = Math.min(yRange[1], hi); }
  const x = i => Lm + (W - Lm - Rm) * (n === 1 ? 0.5 : i / (n - 1));
  const y = v => T + (H - T - B) * (hi - v) / ((hi - lo) || 1);
  const goodSide = v => higherIsBetter ? v > mean + sd : v < mean - sd;
  const badSide  = v => higherIsBetter ? v < mean - sd : v > mean + sd;

  let s = svgOpen(W, H);
  const step = niceStep((hi - lo) / 3);
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    s += `<line x1="${Lm}" x2="${W - Rm}" y1="${y(t)}" y2="${y(t)}" stroke="${BD.light}"/>`
      + svgText(Lm - 6, y(t) + 3, r1(t) + sfx, `font-size="10" fill="${BD.subtle}" text-anchor="end"`);
  }
  if (sd > 0) {
    s += `<rect x="${Lm}" y="${y(mean + sd)}" width="${W - Lm - Rm}" height="${y(mean - sd) - y(mean + sd)}" fill="${BD.greenL}" opacity=".6"/>`;
    s += svgText(Lm + 6, y(mean + sd) - 5, `normal range · avg ${r1(mean)}${sfx}`, `font-size="10" fill="${BD.greenD}" font-weight="600"`);
  }
  s += `<line x1="${Lm}" x2="${W - Rm}" y1="${y(mean)}" y2="${y(mean)}" stroke="${BD.greenD}" stroke-dasharray="4 3" opacity=".5"/>`;
  const ma = movingAvg(vs, MA_WINDOW);
  s += `<path d="${ma.map((v, i) => v == null ? '' : `${ma[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="3" opacity=".3"/>`;
  s += `<path d="${vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${BD.text}" stroke-width="1.3" opacity=".85"/>`;
  pts.forEach((p, i) => {
    const col = goodSide(p.v) ? BD.green : badSide(p.v) ? BD.red : BD.text;
    s += `<circle cx="${x(i)}" cy="${y(p.v)}" r="${i === n - 1 ? 5 : 3.5}" fill="${col}" stroke="#fff" stroke-width="1.2"><title>${p.d}: ${r1(p.v)}${sfx}</title></circle>`;
  });
  if (n >= 3) {
    const iBest = vs.indexOf(higherIsBetter ? Math.max(...vs) : Math.min(...vs));
    const iWorst = vs.indexOf(higherIsBetter ? Math.min(...vs) : Math.max(...vs));
    const tag = (i, text, col) => {
      const above = y(vs[i]) > T + 20 && (higherIsBetter ? i === iBest : i === iWorst);
      const w = text.length * 5.6 + 14;
      const tx = Math.max(Lm + w / 2, Math.min(W - Rm - w / 2, x(i)));
      const ty = above ? y(vs[i]) - 13 : Math.min(H - B - 2, y(vs[i]) + 19);
      return `<rect x="${tx - w / 2}" y="${ty - 11}" width="${w}" height="16" rx="8" fill="#fff" stroke="${col}"/>`
        + svgText(tx, ty + 1, text, `font-size="9.5" font-weight="700" fill="${col}" text-anchor="middle"`);
    };
    s += tag(iBest, `Best ${r1(vs[iBest])}${sfx} · ${shortDate(pts[iBest].d)}`, BD.green);
    if (iWorst !== iBest) s += tag(iWorst, `Worst ${r1(vs[iWorst])}${sfx} · ${shortDate(pts[iWorst].d)}`, BD.red);
  }
  const yr = d => pts[0].d.slice(0, 4) !== pts.at(-1).d.slice(0, 4) ? ` ’${d.slice(2, 4)}` : '';
  s += svgText(Lm, H - 4, shortDate(pts[0].d) + yr(pts[0].d), `font-size="10" fill="${BD.subtle}"`);
  if (n > 1) s += svgText(W - Rm, H - 4, shortDate(pts.at(-1).d) + yr(pts.at(-1).d), `font-size="10" fill="${BD.subtle}" text-anchor="end"`);
  s += '</svg>';

  const within = sd > 0 ? vs.filter(v => Math.abs(v - mean) <= sd).length : n;
  const strip = [{ value: `${r1(mean)}${sfx}`, label: 'Average', big: true },
    { value: `${within}/${n}`, label: 'In normal range' }];
  if (n >= 4) {
    const k = Math.min(5, Math.floor(n / 2));
    const d = avg(vs.slice(-k)) - avg(vs.slice(0, k));
    const good = higherIsBetter ? d > 0 : d < 0;
    strip.push({ value: Math.abs(d) < 0.05 ? 'flat' : `${d > 0 ? '▲' : '▼'} ${r1(Math.abs(d))}`, label: `First ${k} → last ${k}`,
      cls: Math.abs(d) < 0.05 ? 'flat' : good ? 'up' : 'down' });
  }
  el.innerHTML = `<div class="bd-chart">${s}</div>`
    + legend([[BD.text, label], [color, `${MA_WINDOW}-round avg`], [BD.greenL, 'Normal range (avg ± 1 sd)']])
    + statStrip([...strip, ...extraStats]);
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw) || 10 * p;
}

// ── Overall "Trends" tabbed container ───────────────────────────────────────────
let trendTabDefs = [];
let trendActiveKey = 'score';

function renderOverallTrends(rounds, holes) {
  const dates = rounds.map(r => r.date);
  const pr = rounds.filter(r => r.putts != null && r.putts > 0);
  trendTabDefs = [
    { key: 'score', label: 'Score', desc: 'Total strokes per round.',
      run: () => trendLine('chart-o-trends', 'summary-o-trends', dates, rounds.map(r => r.score), 'Score', C_GREEN) },
    { key: 'putts', label: 'Putts', desc: 'Total putts per round.',
      run: () => trendLine('chart-o-trends', 'summary-o-trends', pr.map(r => r.date), pr.map(r => r.putts), 'Putts', C_BLUE) },
    { key: 'gir', label: 'GIR %', desc: 'Greens hit in regulation, per round.',
      run: () => trendLine('chart-o-trends', 'summary-o-trends', dates, rounds.map(r => r.gir_pct), 'GIR %', C_TEAL, [0, 100], true) },
    { key: 'fwy', label: 'Fairways', desc: 'Fairways hit off the tee, per round.',
      run: () => trendLine('chart-o-trends', 'summary-o-trends', dates, rounds.map(r => r.fairway_pct), 'FWY %', C_PURPLE, [0, 100], true) },
    { key: 'scramble', label: 'Scrambling', desc: 'How often you make par or better after missing the green in regulation.',
      run: () => renderScramblingTrend(rounds, holes, 'chart-o-trends', 'summary-o-trends') },
    { key: 'penalty', label: 'Penalties', desc: 'Total penalty strokes taken each round. A downward trend means fewer costly mistakes.',
      run: () => renderPenaltyTrend(rounds, holes, 'chart-o-trends', 'summary-o-trends') },
    { key: 'hcap', label: 'Handicap Diff', desc: 'Calculated as (Score − Course Rating) / Course Slope × 113. Normalizes each round for course difficulty — lower is better.',
      run: () => renderHandicapDiffTrend(rounds, 'chart-o-trends', 'summary-o-trends') },
    { key: 'sg', label: 'Strokes Gained', desc: 'Estimated total strokes gained vs scratch each round. Higher is better — an upward trend means you\'re closing the gap to scratch.',
      run: () => renderSGTrend(rounds, 'chart-o-trends', 'summary-o-trends') },
  ];
  if (!trendTabDefs.some(d => d.key === trendActiveKey)) trendActiveKey = trendTabDefs[0].key;
  renderTrendTabs();
}

function renderTrendTabs() {
  const tabsEl = document.getElementById('trend-tabs');
  if (!tabsEl || !trendTabDefs.length) return;
  tabsEl.innerHTML = trendTabDefs.map(d =>
    `<button type="button" class="trend-tab${d.key === trendActiveKey ? ' active' : ''}" data-key="${d.key}">${d.label}</button>`
  ).join('');
  tabsEl.querySelectorAll('.trend-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (trendActiveKey === btn.dataset.key) return;
      trendActiveKey = btn.dataset.key;
      renderTrendTabs();
    });
  });
  const active = trendTabDefs.find(d => d.key === trendActiveKey);
  const descEl = document.getElementById('trend-tab-desc');
  if (descEl) descEl.textContent = active?.desc || '';
  active?.run();
}

const RESULT_ORDER  = ['Eagle or better', 'Birdie', 'Par', 'Bogey', 'Double', 'Triple+'];
// Good-to-bad scale shared by the scoring mix, hole heatmap and ringer card.
const RESULT_COLORS = { 'Eagle or better': '#eab308', 'Birdie': '#16a34a', 'Par': '#bbf7d0',
                        'Bogey': '#fecaca', 'Double': '#f87171', 'Triple+': '#991b1b' };
const RESULT_SHORT  = { 'Eagle or better': 'Eagle+', 'Birdie': 'Birdie', 'Par': 'Par', 'Bogey': 'Bogey', 'Double': 'Double', 'Triple+': 'Triple+' };
const resultColor = (score, par) => RESULT_COLORS[classifyHole({ score, par })] || BD.light;
const resultInk   = (score, par) => ['Birdie', 'Double', 'Triple+'].includes(classifyHole({ score, par })) ? '#fff' : BD.text;

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

  renderManchesterRinger(rounds, holes, meta);

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

  renderKpiBand('ck-band', rounds, holes, base, { compareLabel: 'vs overall',
    extra: `${rounds.length} round${rounds.length !== 1 ? 's' : ''}` });

  const vsParVals = stats.map(st => st.vsPar).filter(v => v != null);
  trendLine('chart-c-score-trend', 'summary-c-score-trend', rounds.map(r => r.date), rounds.map(r => r.score), 'Score', C_GREEN, null, false,
    vsParVals.length ? [{ value: fmtSigned(avg(vsParVals)), label: 'Avg vs par' }] : []);

  renderCourseRecords(rounds, stats);
  renderInsights(rounds, holes, 'insights-course');
  renderCourseHoles(holes);
  renderParTypeBreakdown(holes, 'chart-c-par-type', 'summary-c-par-type');
  renderFairwayMissDirection(holes, rounds, 'chart-c-fwy-miss', 'summary-c-fwy-miss');
  renderScramblingTrend(rounds, holes, 'chart-c-scramble-trend', 'summary-c-scramble-trend');
  renderPenaltyTrend(rounds, holes, 'chart-c-penalty-trend', 'summary-c-penalty-trend');
  renderStrokesGained(rounds, 'chart-c-sg', 'summary-c-sg', base, 'your overall');
  renderCourseVsOverall(rounds, holes, base);
  renderCourseScorecards(rounds, holes, shots);
}

function renderManchesterRinger(rounds, holes, meta) {
  const card = document.getElementById('ringer-card');
  const input = document.getElementById('ringer-start-date');
  const wrap = document.getElementById('ringer-table-wrap');
  if (!card || !input || !wrap) return;

  if (selectedCourse !== HOME_COURSE) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const byId = {};
  for (const h of holes) (byId[h.activity_id] ||= []).push(h);

  const allDates = rounds.map(r => r.date).filter(Boolean).sort();
  if (!input.value) {
    const saved = localStorage.getItem(RINGER_START_KEY);
    const defaultStart = saved || `${new Date().getFullYear()}-01-01`;
    input.value = defaultStart;
  }
  if (allDates.length) {
    input.min = allDates[0];
    input.max = allDates.at(-1);
  }
  const startDate = input.value;

  const divRounds = rounds
    .filter(r => isDivisionDay(r.date))
    .filter(r => !startDate || r.date >= startDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  const parByHole = {};
  for (let h = 1; h <= 18; h++) {
    parByHole[h] = meta?.holePar?.[h] ?? null;
  }

  const bestByHole = {};
  for (let h = 1; h <= 18; h++) {
    const vals = divRounds.map(r => {
      const hole = (byId[r.activity_id] || []).find(x => x.hole === h);
      return hole?.score ?? null;
    }).filter(v => v != null);
    bestByHole[h] = vals.length ? Math.min(...vals) : null;
  }

  if (!divRounds.length) {
    wrap.innerHTML = '<div class="no-data">No Manchester division-day rounds in the selected date range.</div>';
    return;
  }

  const header = ['<th>Date</th>'];
  for (let h = 1; h <= 18; h++) header.push(`<th>H${h}</th>`);
  header.push('<th>Total</th>');

  const bestRow = ['<td class="ringer-label">Best</td>'];
  let bestTotal = 0;
  let bestCount = 0;
  for (let h = 1; h <= 18; h++) {
    const sc = bestByHole[h];
    bestRow.push(ringerChip(sc, parByHole[h], false));
    if (sc != null) { bestTotal += sc; bestCount++; }
  }
  bestRow.push(`<td class="ringer-total">${bestCount ? bestTotal : '—'}</td>`);

  const parRow = ['<td class="ringer-label">Par</td>'];
  for (let h = 1; h <= 18; h++) parRow.push(`<td>${parByHole[h] ?? '—'}</td>`);
  const totalPar = Object.values(parByHole).every(p => p != null) ? sum(Object.values(parByHole)) : null;
  parRow.push(`<td class="ringer-total">${totalPar ?? '—'}</td>`);

  const bodyRows = [...divRounds].reverse().map(r => {
    const hs = byId[r.activity_id] || [];
    const map = {};
    for (const h of hs) map[h.hole] = h;
    const cells = [`<td class="ringer-date">${r.date}</td>`];
    let total = 0;
    let count = 0;
    for (let n = 1; n <= 18; n++) {
      const sc = map[n]?.score ?? null;
      cells.push(ringerChip(sc, parByHole[n], sc != null && sc === bestByHole[n]));
      if (sc != null) { total += sc; count++; }
    }
    cells.push(`<td class="ringer-total">${count ? total : '—'}</td>`);
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="ringer-table-wrap">
      <table class="ringer-table">
        <thead><tr>${header.join('')}</tr></thead>
        <tbody>
          <tr class="ringer-best-row">${bestRow.join('')}</tr>
          <tr class="ringer-par-row">${parRow.join('')}</tr>
          ${bodyRows}
        </tbody>
      </table>
    </div>`;
}

// Ringer cell coloured by result; outlined where this round set the ringer score.
function ringerChip(score, par, isBest) {
  if (score == null) return '<td class="ringer-score"></td>';
  const style = par != null ? ` style="background:${resultColor(score, par)};color:${resultInk(score, par)}"` : '';
  return `<td class="ringer-score ringer-chip${isBest ? ' is-best' : ''}"${style}>${score}</td>`;
}

function recordCard(label, value, sub) {
  return `<div><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
}
const recordDate = iso => `${shortDate(iso)} ${iso.slice(0, 4)}`;

function renderCourseRecords(rounds, stats) {
  const el = document.getElementById('course-records');
  if (!rounds.length) { el.innerHTML = '<div class="no-data">No rounds for this course in the current filter.</div>'; return; }
  el.className = 'records-row';

  const bestRound = rounds.reduce((a, b) => b.score < a.score ? b : a);
  const cards = [];
  cards.push(recordCard('Best round', bestRound.score, recordDate(bestRound.date)));

  const vsParStats = stats.filter(s => s.vsPar != null);
  if (vsParStats.length) {
    const lowVsPar = vsParStats.reduce((a, b) => b.vsPar < a.vsPar ? b : a);
    cards.push(recordCard('Low vs par', fmtSigned(lowVsPar.vsPar), recordDate(lowVsPar.date)));
  }
  const f9 = stats.filter(s => s.front9 != null);
  if (f9.length) { const b = f9.reduce((a, x) => x.front9 < a.front9 ? x : a); cards.push(recordCard('Best front 9', b.front9, recordDate(b.date))); }
  const b9 = stats.filter(s => s.back9 != null);
  if (b9.length) { const b = b9.reduce((a, x) => x.back9 < a.back9 ? x : a); cards.push(recordCard('Best back 9', b.back9, recordDate(b.date))); }

  const totalBirdies = sum(stats.map(s => s.birdies));
  const totalEagles  = sum(stats.map(s => s.eagles));
  if (totalBirdies || totalEagles) cards.push(recordCard('Birdies', totalBirdies, totalEagles ? `${totalEagles} eagle${totalEagles !== 1 ? 's' : ''}` : `in ${rounds.length} rounds`));

  const withPutts = rounds.filter(r => r.putts != null && r.putts > 0);
  if (withPutts.length) { const b = withPutts.reduce((a, x) => x.putts < a.putts ? x : a); cards.push(recordCard('Fewest putts', b.putts, recordDate(b.date))); }

  // Trajectory: first vs recent score average
  if (rounds.length >= 4) {
    const half = Math.floor(rounds.length / 2);
    const early = avg(rounds.slice(0, half).map(r => r.score));
    const late  = avg(rounds.slice(half).map(r => r.score));
    const delta = late - early;
    cards.push(`<div><b class="${delta < 0 ? 'up' : 'down'}" style="${delta < 0 ? '' : 'color:var(--neg)'}">${delta < 0 ? '▼' : '▲'} ${Math.abs(delta).toFixed(1)}</b><span>Trend</span><small>${delta < 0 ? 'improving' : 'rising'} · early vs recent half</small></div>`);
  }
  el.innerHTML = cards.join('');
}

// t: 0 = best (green), 1 = worst (red)
function heatStops(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    { t: 0,    bg: [187, 247, 208], fg: '#14532d' }, // green-200
    { t: 0.5,  bg: [241, 245, 249], fg: '#475569' }, // slate-100 (neutral)
    { t: 1,    bg: [252, 165, 165], fg: '#7f1d1d' }, // red-300
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi.t - lo.t || 1;
  const k = (t - lo.t) / span;
  const bg = lo.bg.map((c, i) => Math.round(c + (hi.bg[i] - c) * k));
  return { bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`, fg: k < 0.5 ? lo.fg : hi.fg };
}

function renderHoleHeatmapStrip(containerId, cells) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!cells.length) { noData(containerId, 'No hole-level data'); return; }
  el.innerHTML = `<div class="hole-heatmap-strip">${cells.map(c => `
    <div class="hole-cell" style="background:${c.bg};color:${c.fg}" title="${c.title}">
      <div class="hole-cell-label">H${c.hole}</div>
      <div class="hole-cell-value">${c.display}</div>
    </div>`).join('')}</div>`;
}

function renderCourseHoles(holes) {
  const ids = ['chart-c-hole-score','chart-c-hole-gir','chart-c-hole-putts','chart-c-hole-pen'];
  if (!holes.length) { ids.forEach(id => noData(id, 'No hole-level data')); return; }
  const holeNums = [...new Set(holes.map(h => h.hole))].sort((a,b) => a-b);

  // Score by hole — every result stacked best→worst, avg to par underneath
  const scoreEl = document.getElementById('chart-c-hole-score');
  const avgToPar = n => avg(holes.filter(h => h.hole === n && h.par != null).map(h => h.score - h.par));
  const withPar = holeNums.filter(n => avgToPar(n) != null);
  if (withPar.length) {
    const col = n => {
      const results = holes.filter(h => h.hole === n && h.par != null).sort((a, b) => (a.score - a.par) - (b.score - b.par));
      const a = avgToPar(n);
      const cls = a >= 1.5 ? 'down' : a <= 0.8 ? 'up' : '';
      return `<div><div class="hn">${n}</div>${results.map(h => `<div class="cell" style="background:${resultColor(h.score, h.par)}" title="H${n} · ${h.date}: ${h.score} (par ${h.par})"></div>`).join('')}<div class="av ${cls}">${fmtSigned(a)}</div></div>`;
    };
    const nine = ns => ns.length ? `<div class="result-heat-nine">${ns.map(col).join('')}</div>` : '';
    const front = withPar.filter(n => n <= 9), back = withPar.filter(n => n > 9);
    scoreEl.innerHTML = `<div class="result-heat" style="${front.length && back.length ? '' : 'grid-template-columns:1fr'}">${nine(front)}${nine(back)}</div>`
      + legend(RESULT_ORDER.map(k => [RESULT_COLORS[k], RESULT_SHORT[k]]));
    const easiest = withPar.reduce((a, b) => avgToPar(b) < avgToPar(a) ? b : a);
    const hardest = withPar.reduce((a, b) => avgToPar(b) > avgToPar(a) ? b : a);
    setSummary('summary-c-hole-score',
      `Hole ${easiest} gives strokes back (avg ${fmtSigned(avgToPar(easiest))}). Hole ${hardest} takes them (avg ${fmtSigned(avgToPar(hardest))}).`);
  } else {
    noData('chart-c-hole-score', 'Par data required');
    setSummary('summary-c-hole-score', '');
  }

  // GIR % by hole — higher is better
  const girData = holeNums.map(n => {
    const hh = holes.filter(h => h.hole === n && h.gir != null);
    return hh.length ? { hole: n, gir_pct: hh.filter(h => h.gir).length / hh.length * 100 } : null;
  }).filter(Boolean);
  if (girData.length) {
    const cells = girData.map(x => {
      const { bg, fg } = heatStops(1 - x.gir_pct / 100);
      return { hole: x.hole, bg, fg, display: fmt(x.gir_pct, '%'), title: `Hole ${x.hole}: ${fmt(x.gir_pct, '%')} GIR` };
    });
    renderHoleHeatmapStrip('chart-c-hole-gir', cells);
    const best = girData.reduce((a,b) => b.gir_pct > a.gir_pct ? b : a);
    const worst = girData.reduce((a,b) => b.gir_pct < a.gir_pct ? b : a);
    setSummary('summary-c-hole-gir', `Best GIR: H${best.hole} (${fmt(best.gir_pct, '%')}). Lowest: H${worst.hole} (${fmt(worst.gir_pct, '%')}).`);
  } else { noData('chart-c-hole-gir', 'No GIR data'); }

  // Putts by hole — lower is better, baseline ~2
  const puttData = holeNums.map(n => {
    const hh = holes.filter(h => h.hole === n && h.putts != null);
    if (!hh.length) return null;
    const putts = hh.map(h => h.putts);
    return { hole: n, avg_putts: avg(putts), best_putts: Math.min(...putts), worst_putts: Math.max(...putts) };
  }).filter(Boolean);
  if (puttData.length) {
    const cells = puttData.map(x => {
      const t = (x.avg_putts - 1.3) / 1.6; // ~1.3 (great) .. ~2.9 (rough) mapped to 0..1
      const { bg, fg } = heatStops(t);
      return { hole: x.hole, bg, fg, display: x.avg_putts.toFixed(2),
        title: `Hole ${x.hole}: avg ${x.avg_putts.toFixed(2)} putts, best ${x.best_putts}, worst ${x.worst_putts}` };
    });
    renderHoleHeatmapStrip('chart-c-hole-putts', cells);
    const worst = puttData.reduce((a,b) => b.avg_putts > a.avg_putts ? b : a);
    setSummary('summary-c-hole-putts', `Toughest green: H${worst.hole} (${worst.avg_putts.toFixed(2)} avg putts). Baseline ~2/hole.`);
  } else { noData('chart-c-hole-putts', 'No putt data'); }

  // Penalties by hole — lower is better
  const penData = holeNums.map(n => {
    const hh = holes.filter(h => h.hole === n);
    return { hole: n, avg_pen: avg(hh.map(h => h.penalties || 0)), total_pen: sum(hh.map(h => h.penalties || 0)) };
  }).filter(d => d.total_pen > 0);
  if (penData.length) {
    const maxAvg = Math.max(...penData.map(d => d.avg_pen), 0.1);
    const cells = penData.map(x => {
      const { bg, fg } = heatStops(x.avg_pen / maxAvg);
      return { hole: x.hole, bg, fg, display: x.total_pen, title: `Hole ${x.hole}: ${x.total_pen} penalty stroke${x.total_pen !== 1 ? 's' : ''} total` };
    });
    renderHoleHeatmapStrip('chart-c-hole-pen', cells);
    const worst = penData.reduce((a,b) => b.total_pen > a.total_pen ? b : a);
    setSummary('summary-c-hole-pen', `Most penalties: H${worst.hole} (${worst.total_pen} total).`);
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
  // Paired dots per stat: filled = this course, hollow = all courses.
  const el = document.getElementById('course-vs-table');
  const show = (v, r) => v == null ? '—' : r.signed ? fmtSigned(v) : fmt(v, r.sfx || '');
  const W = Math.max(180, chartWidth(el) - 118);
  // Each axis is centred on the all-courses value; `span` is the gap that reaches the edge.
  const SPAN = { 'Avg Score': 6, 'Avg vs Par': 6, 'Avg Putts': 3, 'GIR %': 12, 'Fairway %': 12, '1-Putt %': 10, '3-Putt %': 10 };
  el.innerHTML = rows.filter(r => r.c != null && r.o != null).map(r => {
    const span = Math.max(SPAN[r.label] || 5, Math.abs(r.c - r.o) * 1.3);
    const x = v => 14 + (W - 28) * (v - (r.o - span)) / (2 * span);
    const diff = r.c - r.o;
    const better = Math.abs(diff) < 0.05 ? null : r.lowerBetter ? diff < 0 : diff > 0;
    const col = better == null ? BD.subtle : better ? BD.green : BD.red;
    return `<div style="display:grid;grid-template-columns:110px ${W}px;align-items:center;margin-bottom:6px">
      <span style="font-weight:600;font-size:12.5px">${r.label}</span>
      <div class="bd-chart">${svgOpen(W, 42)}
        <line x1="${x(r.o)}" x2="${x(r.o)}" y1="10" y2="30" stroke="${BD.light}" stroke-width="2"/>
        <line x1="${x(r.c)}" x2="${x(r.o)}" y1="20" y2="20" stroke="${col}" stroke-width="3"/>
        <circle cx="${x(r.o)}" cy="20" r="6" fill="#fff" stroke="${BD.muted}" stroke-width="2"/>
        <circle cx="${x(r.c)}" cy="20" r="6" fill="${col}"/>
        ${svgText(x(r.c), 8, show(r.c, r), `font-size="10.5" font-weight="800" fill="${better === false ? BD.red : BD.greenD}" text-anchor="middle"`)}
        ${svgText(x(r.o), 40, show(r.o, r), `font-size="10" fill="${BD.muted}" text-anchor="middle"`)}
      </svg></div></div>`;
  }).join('') + legend([[BD.green, 'This course', 'dot'], ['#fff;border:2px solid ' + BD.muted, 'All courses', 'dot']]);

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

  const round = allRounds.find(r => r.activity_id === actId) || null;
  const totalScore = sum(holes.map(h => h.score || 0));
  const allHavePar = holes.every(h => h.par != null);
  const totalPar   = allHavePar ? sum(holes.map(h => h.par || 0)) : null;
  const totalPutts = sum(holes.map(h => h.putts || 0));
  const girCount = holes.filter(h => h.gir === true).length;
  const girTotal = holes.filter(h => h.gir != null).length;
  const fwyHit   = holes.filter(h => h.fairway_hit === true).length;
  const fwyTotal = holes.filter(h => h.fairway_hit != null).length;
  const totalPen = sum(holes.map(h => h.penalties || 0));

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

  const roundShots = (shotsAll || allShots).filter(s => s.activity_id === actId);
  const teeShots = roundShots.filter(s => s.shot_type === 'TEE' || s.lie === 'TeeBox');
  const longestDrive = teeShots.length ? Math.round(Math.max(...teeShots.map(s => s.distance_yards ?? 0))) : null;

  const parKnown = holes.filter(h => h.par != null && h.score != null);
  const bestHole = parKnown.length ? parKnown.reduce((a, b) => ((b.score - b.par) < (a.score - a.par) ? b : a)) : null;
  const worstHole = parKnown.length ? parKnown.reduce((a, b) => ((b.score - b.par) > (a.score - a.par) ? b : a)) : null;
  const bestDiff = bestHole ? bestHole.score - bestHole.par : null;
  const worstDiff = worstHole ? worstHole.score - worstHole.par : null;

  const onePutts = holes.filter(h => h.putts != null && h.putts <= 1).length;
  const threePutts = holes.filter(h => h.putts != null && h.putts >= 3).length;
  const penaltyHoles = holes.filter(h => (h.penalties || 0) > 0).length;

  const leftMiss = holes.filter(h => (h.fairway_missed || '').toString().toUpperCase().includes('LEFT')).length;
  const rightMiss = holes.filter(h => (h.fairway_missed || '').toString().toUpperCase().includes('RIGHT')).length;
  const missBias = leftMiss === 0 && rightMiss === 0 ? 'No directional misses recorded'
    : leftMiss > rightMiss ? `Left bias (${leftMiss}L/${rightMiss}R)`
    : rightMiss > leftMiss ? `Right bias (${rightMiss}R/${leftMiss}L)`
    : `Balanced misses (${leftMiss}L/${rightMiss}R)`;

  const front = holes.filter(h => h.hole <= 9);
  const back = holes.filter(h => h.hole >= 10 && h.hole <= 18);
  const splitBlock = (label, hs) => {
    if (!hs.length) return '';
    const sideScore = sum(hs.map(h => h.score || 0));
    const sideParKnown = hs.filter(h => h.par != null && h.score != null);
    const sideVsPar = sideParKnown.length === hs.length ? sum(sideParKnown.map(h => h.score - h.par)) : null;
    const sidePutts = sum(hs.map(h => h.putts || 0));
    const sideGirCount = hs.filter(h => h.gir === true).length;
    const sideGirTotal = hs.filter(h => h.gir != null).length;
    const sideFwyHit = hs.filter(h => h.fairway_hit === true).length;
    const sideFwyTotal = hs.filter(h => h.fairway_hit != null).length;
    return `
      <div class="sc-mini-card">
        <div class="sc-mini-title">${label}</div>
        <div class="sc-mini-row"><span>Score</span><strong>${sideScore}${sideVsPar != null ? ` (${fmtSigned(sideVsPar)})` : ''}</strong></div>
        <div class="sc-mini-row"><span>Putts</span><strong>${sidePutts}</strong></div>
        ${sideGirTotal > 0 ? `<div class="sc-mini-row"><span>GIR</span><strong>${sideGirCount}/${sideGirTotal}</strong></div>` : ''}
        ${sideFwyTotal > 0 ? `<div class="sc-mini-row"><span>Fairways</span><strong>${sideFwyHit}/${sideFwyTotal}</strong></div>` : ''}
      </div>`;
  };

  const { counts: scoringMix, total: scoringTotal } = scoringCounts(holes);
  const scoringMixHtml = scoringTotal ? RESULT_ORDER.filter(k => scoringMix[k] > 0).map(k =>
    `<span class="sc-chip" style="--chip:${RESULT_COLORS[k]};">${k}: ${scoringMix[k]}</span>`).join('')
    : '<span class="sc-muted">Par data needed</span>';

  const sg = round && typeof round.sg === 'object' ? round.sg : null;
  const sgItems = [
    { k: 'off_tee', label: 'Off Tee' },
    { k: 'approach', label: 'Approach' },
    { k: 'short_game', label: 'Short Game' },
    { k: 'putting', label: 'Putting' },
    { k: 'total', label: 'Total' },
  ];
  const sgHtml = sg ? sgItems.map(({ k, label }) => {
    const v = sg[k];
    const cls = v == null ? '' : (v > 0 ? 'good' : v < 0 ? 'bad' : 'neutral');
    return `<div class="sc-sg-item ${cls}"><span>${label}</span><strong>${fmtSigned(v)}</strong></div>`;
  }).join('') : '<div class="sc-muted">No strokes gained data</div>';

  const missedGir = holes.filter(h => h.gir === false && h.par != null && h.score != null);
  const scrambled = missedGir.filter(h => h.score <= h.par).length;
  const scramblePct = missedGir.length ? (scrambled / missedGir.length * 100) : null;

  const girParKnown = holes.filter(h => h.gir === true && h.par != null && h.score != null);
  const nonGirParKnown = holes.filter(h => h.gir === false && h.par != null && h.score != null);
  const girToPar = girParKnown.length ? avg(girParKnown.map(h => h.score - h.par)) : null;
  const nonGirToPar = nonGirParKnown.length ? avg(nonGirParKnown.map(h => h.score - h.par)) : null;

  const parTypeRows = [3, 4, 5].map(p => {
    const hs = holes.filter(h => h.par === p && h.score != null);
    if (!hs.length) return null;
    const rel = avg(hs.map(h => h.score - h.par));
    return `<div class="sc-mini-row"><span>Par ${p}</span><strong>${fmtSigned(rel)} avg (${hs.length} holes)</strong></div>`;
  }).filter(Boolean).join('') || '<div class="sc-muted">No par-type breakdown</div>';

  const durationMin = round?.duration_seconds != null ? (round.duration_seconds / 60) : null;
  const minPerHole = durationMin != null && holes.length ? durationMin / holes.length : null;
  const distanceMi = round?.distance_meters != null ? (round.distance_meters * 0.000621371) : null;

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
        </tbody>
      </table>
    </div>
    <div class="scorecard-summary">
      <div class="sc-sum-item"><span class="sc-sum-label">Score</span><span class="sc-sum-value">${totalScore}${vsParStr != null ? ` <span class="sc-vs-par ${vsParCls}">(${vsParStr})</span>` : ''}</span></div>
      <div class="sc-sum-item"><span class="sc-sum-label">Putts</span><span class="sc-sum-value">${totalPutts}</span></div>
      ${girTotal > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">GIR</span><span class="sc-sum-value">${girCount}/${girTotal}</span></div>` : ''}
      ${fwyTotal > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Fairways</span><span class="sc-sum-value">${fwyHit}/${fwyTotal}</span></div>` : ''}
      ${totalPen > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Penalties</span><span class="sc-sum-value">${totalPen}</span></div>` : ''}
      ${longestDrive != null && longestDrive > 0 ? `<div class="sc-sum-item"><span class="sc-sum-label">Longest Drive</span><span class="sc-sum-value">${longestDrive} yds</span></div>` : ''}
    </div>

    <div class="scorecard-insights-grid">
      <div class="sc-insight-card">
        <h4>Strengths and Leaks</h4>
        <div class="sc-mini-row"><span>Best Hole</span><strong>${bestHole ? `#${bestHole.hole} (${fmtSigned(bestDiff)})` : '—'}</strong></div>
        <div class="sc-mini-row"><span>Worst Hole</span><strong>${worstHole ? `#${worstHole.hole} (${fmtSigned(worstDiff)})` : '—'}</strong></div>
        <div class="sc-mini-row"><span>One Putts</span><strong>${onePutts}</strong></div>
        <div class="sc-mini-row"><span>Three Putts</span><strong>${threePutts}</strong></div>
        <div class="sc-mini-row"><span>Penalty Holes</span><strong>${penaltyHoles}</strong></div>
        <div class="sc-mini-row"><span>Fairway Miss Pattern</span><strong>${missBias}</strong></div>
      </div>

      <div class="sc-insight-card">
        <h4>Front and Back Split</h4>
        <div class="sc-split-grid">
          ${splitBlock('Front 9', front)}
          ${splitBlock('Back 9', back)}
        </div>
      </div>

      <div class="sc-insight-card">
        <h4>Scoring Composition</h4>
        <div class="sc-chip-row">${scoringMixHtml}</div>
      </div>

      <div class="sc-insight-card">
        <h4>Strokes Gained Fingerprint</h4>
        <div class="sc-sg-grid">${sgHtml}</div>
      </div>

      <div class="sc-insight-card">
        <h4>Round Efficiency</h4>
        <div class="sc-mini-row"><span>Scrambling</span><strong>${scramblePct != null ? `${fmt(scramblePct, '%')} (${scrambled}/${missedGir.length})` : '—'}</strong></div>
        <div class="sc-mini-row"><span>GIR Hole Scoring</span><strong>${girToPar != null ? fmtSigned(girToPar) : '—'}</strong></div>
        <div class="sc-mini-row"><span>Missed GIR Scoring</span><strong>${nonGirToPar != null ? fmtSigned(nonGirToPar) : '—'}</strong></div>
        ${parTypeRows}
      </div>

      <div class="sc-insight-card">
        <h4>Round Context</h4>
        <div class="sc-mini-row"><span>Duration</span><strong>${durationMin != null ? `${Math.round(durationMin)} min` : '—'}</strong></div>
        <div class="sc-mini-row"><span>Minutes per Hole</span><strong>${minPerHole != null ? `${fmt(minPerHole)}` : '—'}</strong></div>
        <div class="sc-mini-row"><span>Distance Walked</span><strong>${distanceMi != null ? `${fmt(distanceMi)} mi` : '—'}</strong></div>
      </div>
    </div>`;
}

// ════════════════════════════════ OVERALL VIEW ════════════════════════════════
function renderOverallView() {
  const rounds = baseFilteredRounds();
  const { holes, shots } = bundle(rounds);
  const prior = priorWindow(rounds);

  renderKpiBand('ok-band', rounds, holes, prior, {
    headline: 'hcap', compareLabel: 'vs prev', extra: `${rounds.length} rounds · ${new Set(rounds.map(r => r.course)).size} courses` });

  renderGoals(rounds);
  renderFocus(rounds, 'focus-overall');
  renderInsights(rounds, holes, 'insights-overall');
  renderStrokesGained(rounds, 'chart-o-sg', 'summary-o-sg', prior, `previous ${prior.length}`);

  renderOverallTrends(rounds, holes);

  renderScoringDonut(holes);
  renderPuttingDonut(holes, rounds);
  renderFairwayMissDirection(holes, rounds);
  renderOverallClubs(shots);
  renderComparisonTable(rounds, holes);
}

// One KPI band: a headline number plus five stats, each with its change vs
// `compare` (the previous window, or the overall view on By Course) and a sparkline.
function renderKpiBand(id, rounds, holes, compare, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!rounds.length) { el.innerHTML = '<div class="no-data" style="grid-column:1/-1">No rounds in the current filter.</div>'; return; }
  const a = aggregateMetrics(rounds, holes);
  const b = compare.length ? aggregateMetrics(compare, bundle(compare).holes) : {};
  const vs = opts.compareLabel || 'vs prev';
  const series = k => rounds.map(r => r[k] != null && (k === 'hcap_index' || r[k] > 0) ? r[k] : null);
  const cell = (lbl, val, d, sp = '') => `<div><div class="lbl">${lbl}</div><div class="val">${val}</div>${d}${sp}</div>`;
  const best = rounds.reduce((p, q) => q.score < p.score ? q : p);
  const cells = [];
  if (opts.headline === 'hcap') {
    const now = rounds.filter(r => r.hcap_index != null).at(-1)?.hcap_index ?? null;
    const before = compare.filter(r => r.hcap_index != null).at(-1)?.hcap_index ?? null;
    cells.push(cell(`Handicap index · ${opts.extra}`, now != null ? fmt(now) : '—', deltaHtml(now, before, true, '', vs), sparkline(series('hcap_index'))));
    cells.push(cell('Avg score', fmt(a.score), deltaHtml(a.score, b.score, true, '', vs), sparkline(series('score'))));
  } else {
    cells.push(cell(`Avg score · ${opts.extra}`, fmt(a.score), deltaHtml(a.score, b.score, true, '', vs), sparkline(series('score'))));
    cells.push(cell('Avg vs par', a.vsPar != null ? fmtSigned(a.vsPar) : '—', deltaHtml(a.vsPar, b.vsPar, true, '', vs)));
  }
  cells.push(cell('Avg putts', fmt(a.putts), deltaHtml(a.putts, b.putts, true, '', vs), sparkline(series('putts'))));
  cells.push(cell('GIR', fmt(a.girPct, '%'), deltaHtml(a.girPct, b.girPct, false, ' pts', vs), sparkline(series('gir_pct'))));
  cells.push(cell('Fairways', fmt(a.fwyPct, '%'), deltaHtml(a.fwyPct, b.fwyPct, false, ' pts', vs), sparkline(series('fairway_pct'))));
  cells.push(cell('Best round', best.score, `<span class="delta flat">${shortDate(best.date)} ${best.date.slice(0, 4)}</span>`));
  el.innerHTML = cells.join('');
}

function renderScoringDonut(holes) {
  const el = document.getElementById('chart-o-scoring-donut');
  const { counts, total } = scoringCounts(holes);
  if (!total) { noData('chart-o-scoring-donut', 'Par data required'); setSummary('summary-o-scoring-donut',''); return; }
  const bar = RESULT_ORDER.filter(k => counts[k]).map(k => {
    const p = pctOf(counts[k], total);
    return `<div style="flex:${counts[k]};background:${RESULT_COLORS[k]};color:${['Birdie', 'Double', 'Triple+'].includes(k) ? '#fff' : BD.text}" title="${k}: ${counts[k]} holes (${p}%)">${p >= 6 ? p + '%' : ''}</div>`;
  }).join('');
  const keys = RESULT_ORDER.map(k => `<div><i style="background:${RESULT_COLORS[k]}"></i><b>${counts[k]}</b><span>${RESULT_SHORT[k]}</span></div>`).join('');
  const parTypes = [3, 4, 5].map(p => {
    const hs = holes.filter(h => h.par === p && h.score != null);
    return hs.length ? { p, v: avg(hs.map(h => h.score - h.par)) } : null;
  }).filter(Boolean);
  const best = parTypes.length ? parTypes.reduce((a, b) => b.v < a.v ? b : a) : null;
  el.innerHTML = `<div class="mix-bar">${bar}</div><div class="mix-keys">${keys}</div>`
    + (parTypes.length ? statStrip(parTypes.map(x => ({ value: fmtSigned(x.v), label: `Par ${x.p}s · avg to par`, cls: x === best ? 'up' : '' }))) : '');
  const parOrBetter = counts['Eagle or better'] + counts['Birdie'] + counts['Par'];
  setSummary('summary-o-scoring-donut', `${pctOf(parOrBetter, total)}% of ${total} holes at par or better.`
    + (best && parTypes.length > 1 ? ` Par ${best.p}s are your strongest hole type.` : ''));
}

function renderPuttingDonut(holes, rounds = []) {
  const el = document.getElementById('chart-o-putting-donut');
  const hp = holes.filter(h => h.putts != null);
  if (!hp.length) { noData('chart-o-putting-donut', 'No putt data'); setSummary('summary-o-putting-donut',''); return; }
  const c = k => hp.filter(h => k === 3 ? h.putts >= 3 : k === 1 ? h.putts <= 1 : h.putts === k).length;
  const three = c(3), total = hp.length;
  const roundsWithHoles = new Set(hp.map(h => h.activity_id)).size;
  let html = statStrip([
    { value: `${pctOf(c(1), total)}%`, label: '0–1 putt' },
    { value: `${pctOf(c(2), total)}%`, label: '2 putts', big: true },
    { value: `${pctOf(three, total)}%`, label: '3+ putts', cls: 'down' },
    { value: r1(three / Math.max(1, roundsWithHoles)), label: '3-putts / round' },
  ]);
  // Putts per round vs a 20-handicap benchmark (18-hole rounds only).
  const rs = rounds.filter(r => r.putts > 0 && r.holes_played === 18);
  if (rs.length >= 2) {
    const target = 34;
    const W = chartWidth(el), H = 120, B = 16, T = 12, bw = W / rs.length;
    const max = Math.max(...rs.map(r => r.putts), target), min = Math.min(...rs.map(r => r.putts), 28) - 2;
    const y = v => T + (H - B - T) * (max - v) / (max - min);
    let s = svgOpen(W, H);
    rs.forEach((r, i) => {
      s += `<rect x="${i * bw + Math.min(3, bw * .15)}" y="${y(r.putts)}" width="${bw - 2 * Math.min(3, bw * .15)}" height="${H - B - y(r.putts)}" rx="2" fill="${r.putts <= target ? BD.green : '#fca5a5'}"><title>${r.date}: ${r.putts} putts</title></rect>`;
      if (bw >= 16) s += svgText(i * bw + bw / 2, y(r.putts) - 3, r.putts, `font-size="9" fill="${BD.muted}" text-anchor="middle"`);
    });
    s += `<line x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}" stroke="${BD.greenD}" stroke-dasharray="4 3"/>`
      + `<rect x="0" y="${y(target) - 8}" width="84" height="15" rx="7" fill="#fff" stroke="${BD.greenD}"/>`
      + svgText(42, y(target) + 3, '20-hcp avg 34', `font-size="9" fill="${BD.greenD}" text-anchor="middle" font-weight="700"`);
    s += svgText(0, H - 2, shortDate(rs[0].date), `font-size="9.5" fill="${BD.subtle}"`) + svgText(W, H - 2, shortDate(rs.at(-1).date), `font-size="9.5" fill="${BD.subtle}" text-anchor="end"`);
    html += `<div class="bd-sublabel">Putts per 18-hole round</div><div class="bd-chart">${s}</svg></div>`;
  }
  el.innerHTML = html;
  setSummary('summary-o-putting-donut', `Avg ${fmt(avg(hp.map(h => h.putts)))} putts per hole across ${total} holes.`);
}

const FULL_SWING_TYPES = new Set(['TEE', 'APPROACH', 'LAYUP']);

function renderOverallClubs(shots) {
  const ids = ['chart-o-club-box','chart-o-lie-distance','chart-o-club-usage','chart-o-drive-trend'];
  const valid = shots.filter(s => s.distance_yards != null && s.distance_yards > 0);
  if (!valid.length) {
    ids.forEach(id => noData(id, shotsLoaded ? 'No club/shot data available' : 'Loading shot data…'));
    return;
  }
  const clubs = [...new Set(valid.map(s => s.club_name))].filter(Boolean);
  const fullSwing = valid.filter(s => FULL_SWING_TYPES.has(s.shot_type));

  // Order clubs longest → shortest by median full-swing distance so every
  // club chart/table reads the same way instead of shot-data insertion order.
  const clubStats = [...new Set(fullSwing.map(s => s.club_name))].filter(Boolean)
    .map(c => ({ c, med: median(fullSwing.filter(s => s.club_name === c).map(s => s.distance_yards)) }))
    .sort((a, b) => (b.med ?? -Infinity) - (a.med ?? -Infinity));
  const fullSwingClubs = clubStats.map(o => o.c);

  renderClubGapping(fullSwing, fullSwingClubs);
  setSummary('summary-o-club-box', clubStats.length
    ? `Longest median club: ${clubStats[0].c} at ${clubStats[0].med?.toFixed(1)} yds. Tee/approach/layup shots only — chips, putts and recovery shots excluded.`
    : '');

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

  renderClubLieTable(fullSwing, fullSwingClubs);

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
    trendLine('chart-o-drive-trend', 'summary-o-drive-trend', byDate.map(d => d.date), byDate.map(d => d.avg), 'Avg Drive (yds)', C_ORANGE, null, true);
  } else { noData('chart-o-drive-trend', 'No tee shot data'); setSummary('summary-o-drive-trend', ''); }
}

// Gapping chart: each club's middle-half range and median, longest first, with
// the drop to the next club down (overlapping clubs flagged red).
function renderClubGapping(fullSwing, clubs) {
  const el = document.getElementById('chart-o-club-box');
  if (!el) return;
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.round(p * (s.length - 1))]; };
  const rows = clubs.map(club => {
    const cs = fullSwing.filter(s => s.club_name === club);
    const d = cs.map(s => s.distance_yards);
    return { club, type: cs.find(s => s.club_type_name)?.club_type_name || '', n: d.length, med: median(d), lo: q(d, .25), hi: q(d, .75) };
  }).filter(r => r.n >= 3);
  if (!rows.length) { noData('chart-o-club-box', 'Not enough full-swing shots per club'); return; }
  const max = Math.ceil(Math.max(...rows.map(r => r.hi)) / 25) * 25 + 10;
  const W = Math.max(520, chartWidth(el)), Lm = Math.min(150, W * 0.22), Rm = 120, rowH = 26, H = rows.length * rowH + 24;
  const x = v => Lm + (W - Lm - Rm) * v / max;
  let s = svgOpen(W, H, 'style="min-width:520px"');
  for (let g = 0; g <= max; g += 50) {
    s += `<line x1="${x(g)}" x2="${x(g)}" y1="0" y2="${H - 18}" stroke="${BD.light}"/>`
      + svgText(x(g), H - 4, `${g} yd`, `font-size="10" fill="${BD.subtle}" text-anchor="middle"`);
  }
  rows.forEach((c, i) => {
    const y = i * rowH + 4;
    s += svgText(0, y + 11, c.club, `font-size="12" font-weight="600" fill="${BD.text}"`)
      + svgText(0, y + 22, c.type, `font-size="9" fill="${BD.subtle}"`);
    s += `<rect x="${x(c.lo)}" y="${y + 3}" width="${Math.max(2, x(c.hi) - x(c.lo))}" height="12" rx="6" fill="${BD.greenL}"><title>${c.club}: ${Math.round(c.lo)}–${Math.round(c.hi)} yds typical, ${c.n} shots</title></rect>`;
    s += `<line x1="${x(c.med)}" x2="${x(c.med)}" y1="${y}" y2="${y + 18}" stroke="${BD.greenD}" stroke-width="2.5"/>`;
    s += svgText(x(c.med) + 6, y + 13, Math.round(c.med), `font-size="10.5" font-weight="700" fill="${BD.greenD}"`);
    const next = rows[i + 1];
    if (next) {
      const gap = c.med - next.med;
      const txt = gap < 6 ? `<tspan fill="${BD.red}" font-weight="700">gap ${Math.round(gap)} yd · overlap</tspan>`
        : gap > 25 ? `<tspan fill="${BD.orange}" font-weight="700">gap ${Math.round(gap)} yd</tspan>` : `gap ${Math.round(gap)} yd`;
      s += svgText(W - Rm + 12, y + 12, txt, `font-size="10" fill="${BD.muted}"`);
    }
    s += svgText(W, y + 12, `${c.n}×`, `font-size="9.5" fill="${BD.subtle}" text-anchor="end"`);
  });
  s += '</svg>';
  el.innerHTML = `<div class="bd-chart" style="overflow-x:auto">${s}</div>`
    + legend([[BD.greenD, 'Median distance'], [BD.greenL, 'Typical range (middle half)']])
    + '<div class="bd-legend" style="margin-top:2px">Gap = drop to the next club down. Red flags clubs that overlap; orange flags a gap over 25 yds.</div>';
}

function renderClubLieTable(fullSwing, clubs) {
  const el = document.getElementById('club-lie-table');
  if (!el) return;
  const rows = clubs.map(club => {
    const cs = fullSwing.filter(s => s.club_name === club);
    const fwy = cs.filter(s => s.lie === 'Fairway').map(s => s.distance_yards);
    const rough = cs.filter(s => s.lie === 'Rough').map(s => s.distance_yards);
    const fwyAvg = avg(fwy), roughAvg = avg(rough);
    const loss = fwyAvg != null && roughAvg != null ? fwyAvg - roughAvg : null;
    return { club, fwyAvg, fwyN: fwy.length, roughAvg, roughN: rough.length, loss };
  }).filter(r => r.fwyN || r.roughN);
  // `clubs` arrives pre-sorted longest → shortest; keep that order here too.

  if (!rows.length) { noData('club-lie-table', 'No fairway/rough shot data'); return; }

  const body = rows.map(r => `
    <tr>
      <td class="metric-label">${r.club}</td>
      <td>${r.fwyAvg != null ? `${fmt(r.fwyAvg)} yds (${r.fwyN})` : '—'}</td>
      <td>${r.roughAvg != null ? `${fmt(r.roughAvg)} yds (${r.roughN})` : '—'}</td>
      <td>${r.loss != null ? fmt(r.loss, ' yds') : '—'}</td>
    </tr>`).join('');
  el.innerHTML = `
    <table class="compare-table">
      <thead><tr><th>Club</th><th>Fairway Avg</th><th>Rough Avg</th><th>Distance Lost</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
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

// ── New overall charts ──────────────────────────────────────────────────────────

function renderParTypeBreakdown(holes, chartId, summaryId) {
  const data = [3, 4, 5].map(par => {
    const hs = holes.filter(h => h.par === par && h.score != null);
    if (!hs.length) return null;
    return { par, n: hs.length, avgVsPar: avg(hs.map(h => h.score - h.par)) };
  }).filter(Boolean);

  if (!data.length) { noData(chartId, 'Par data required'); setSummary(summaryId, ''); return; }

  const worst = data.reduce((a, b) => b.avgVsPar > a.avgVsPar ? b : a);
  const best  = data.reduce((a, b) => b.avgVsPar < a.avgVsPar ? b : a);
  document.getElementById(chartId).innerHTML = statStrip(data.map(d => ({
    value: fmtSigned(d.avgVsPar), label: `Par ${d.par}s · avg to par`, sub: `${d.n} holes`,
    cls: data.length > 1 && d === best ? 'up' : data.length > 1 && d === worst ? 'down' : '' })));
  setSummary(summaryId,
    `Strongest: Par ${best.par} (avg ${fmtSigned(best.avgVsPar)}). Weakest: Par ${worst.par} (avg ${fmtSigned(worst.avgVsPar)}).`);
}

const FWY_LEFT_COLOR  = '#3B82F6';
const FWY_HIT_COLOR   = '#16a34a';
const FWY_RIGHT_COLOR = '#f97316';

function renderFairwayMissDirection(holes, rounds = null, chartId = 'chart-o-fwy-miss', summaryId = 'summary-o-fwy-miss') {
  const el = document.getElementById(chartId);
  const tally = hs => {
    const fw = hs.filter(h => h.fairway_hit != null && (h.par == null || h.par >= 4));
    const hit = fw.filter(h => h.fairway_hit).length;
    const left = fw.filter(h => !h.fairway_hit && h.fairway_missed === 'LEFT').length;
    const right = fw.filter(h => !h.fairway_hit && h.fairway_missed === 'RIGHT').length;
    return { n: fw.length, hit, left, right, other: fw.length - hit - left - right };
  };
  const t = tally(holes);
  if (!t.n) { noData(chartId, 'No fairway data'); setSummary(summaryId, ''); return; }

  let html = statStrip([
    { value: `${pctOf(t.left, t.n)}%`, label: 'Miss left', color: FWY_LEFT_COLOR },
    { value: `${pctOf(t.hit, t.n)}%`, label: 'Fairway', big: true, cls: 'up' },
    { value: `${pctOf(t.right, t.n)}%`, label: 'Miss right', color: FWY_RIGHT_COLOR },
  ]);
  // One stacked bar per round (most recent 14), score on top.
  const byId = {};
  for (const h of holes) (byId[h.activity_id] ||= []).push(h);
  const rs = (rounds || []).map(r => ({ r, t: tally(byId[r.activity_id] || []) })).filter(x => x.t.n).slice(-14);
  if (rs.length >= 2) {
    const W = chartWidth(el), H = 150, B = 16, T = 14, bw = W / rs.length, gap = Math.min(3, bw * .15);
    let s = svgOpen(W, H);
    rs.forEach(({ r, t: p }, i) => {
      let yy = H - B;
      [[p.hit, FWY_HIT_COLOR], [p.left, FWY_LEFT_COLOR], [p.right, FWY_RIGHT_COLOR], [p.other, '#cbd5e1']].forEach(([n, col]) => {
        const h = (H - B - T) * n / p.n; yy -= h;
        if (h > 0) s += `<rect x="${i * bw + gap}" y="${yy}" width="${bw - 2 * gap}" height="${h}" fill="${col}" opacity=".9"><title>${r.date}: ${p.hit}/${p.n} fairways</title></rect>`;
      });
      if (bw >= 18) s += svgText(i * bw + bw / 2, T - 4, r.score, `font-size="9" fill="${BD.muted}" text-anchor="middle" font-weight="600"`);
    });
    s += svgText(0, H - 2, shortDate(rs[0].r.date), `font-size="9.5" fill="${BD.subtle}"`) + svgText(W, H - 2, shortDate(rs.at(-1).r.date), `font-size="9.5" fill="${BD.subtle}" text-anchor="end"`);
    html += `<div class="bd-sublabel">Each round${bw >= 18 ? ' (score on top)' : ''}</div><div class="bd-chart">${s}</svg></div>`
      + legend([[FWY_HIT_COLOR, 'Fairway'], [FWY_LEFT_COLOR, 'Left'], [FWY_RIGHT_COLOR, 'Right'], ['#cbd5e1', 'Missed, side not recorded']]);
  }
  el.innerHTML = html;

  const misses = t.left + t.right;
  const bias = misses === 0 ? 'No misses recorded'
    : t.left > t.right ? `${pctOf(t.left, misses)}% of your misses go left`
    : t.right > t.left ? `${pctOf(t.right, misses)}% of your misses go right`
    : 'Misses split evenly';
  setSummary(summaryId, `${pctOf(t.hit, t.n)}% of ${t.n} par 4 & 5 fairways hit. ${bias}.`);
}

function renderScramblingTrend(rounds, holes, chartId = 'chart-o-scramble-trend', summaryId = 'summary-o-scramble-trend') {
  const byId = {};
  for (const h of holes) (byId[h.activity_id] ||= []).push(h);

  const pts = rounds.map(r => {
    const hs = byId[r.activity_id] || [];
    const missed = hs.filter(h => h.gir === false && h.par != null && h.score != null);
    if (!missed.length) return null;
    const saved = missed.filter(h => (h.score - h.par) <= 0).length;
    return { date: r.date, pct: saved / missed.length * 100 };
  }).filter(Boolean);

  if (!pts.length) { noData(chartId, 'No scrambling data (requires GIR + par + score)'); setSummary(summaryId, ''); return; }
  trendLine(chartId, summaryId, pts.map(p => p.date), pts.map(p => p.pct), 'Scrambling %', C_TEAL, [0, 100], true);
}

function renderPenaltyTrend(rounds, holes, chartId = 'chart-o-penalty-trend', summaryId = 'summary-o-penalty-trend') {
  const byId = {};
  for (const h of holes) (byId[h.activity_id] ||= []).push(h);

  const dates = rounds.map(r => r.date);
  const vals  = rounds.map(r => sum((byId[r.activity_id] || []).map(h => h.penalties || 0)));

  if (!vals.length) { noData(chartId, 'No data'); setSummary(summaryId, ''); return; }
  trendLine(chartId, summaryId, dates, vals, 'Penalties', C_RED);
}

function renderHandicapDiffTrend(rounds, chartId = 'chart-o-hcap-trend', summaryId = 'summary-o-hcap-trend') {
  const pts = rounds.map(r => {
    const meta = getCourseMeta(r.course);
    if (!meta?.rating || !meta?.slope || r.score == null) return null;
    return { date: r.date, course: r.course, diff: (r.score - meta.rating) / meta.slope * 113 };
  }).filter(Boolean);

  if (!pts.length) { noData(chartId, 'Course rating/slope data required'); setSummary(summaryId, ''); return; }

  const uniqueCourses = new Set(pts.map(p => p.course));
  if (uniqueCourses.size < 2) {
    noData(chartId, 'Only meaningful across multiple courses — all rounds here are on the same course, so this would be identical to the score trend');
    setSummary(summaryId, '');
    return;
  }

  trendLine(chartId, summaryId, pts.map(p => p.date), pts.map(p => p.diff), 'Handicap Diff', C_NAVY);
}

// ── Strokes Gained (estimated, by category) ─────────────────────────────────────
const SG_CATS = [
  ['off_tee',    'Off the Tee'],
  ['approach',   'Approach'],
  ['short_game', 'Short Game'],
  ['putting',    'Putting'],
];

// Average each SG category across rounds that carry an estimate. Returns null
// when no round in the set has SG data.
function aggregateSG(rounds) {
  const out = {}; let any = false;
  for (const [k] of SG_CATS) {
    const vals = rounds.map(r => r.sg?.[k]).filter(v => v != null);
    out[k] = vals.length ? avg(vals) : null;
    if (vals.length) any = true;
  }
  const totals = rounds.map(r => r.sg?.total).filter(v => v != null);
  out.total = totals.length ? avg(totals) : null;
  out.n = rounds.filter(r => r.sg).length;
  return any ? out : null;
}

// Approximate, commonly-cited per-category strokes-lost-vs-scratch for a
// ~15-handicap golfer (rounded ballpark figures based on published strokes-
// gained research, e.g. Broadie's "Every Shot Counts") — shown only as a
// rough reference marker, not precise user data.
const SG_BENCHMARK_15 = { off_tee: -2.5, approach: -5.5, short_game: -2.5, putting: -2.5 };
const SG_NEG_COLOR = '#b91c1c'; // muted crimson
const SG_POS_COLOR = '#10b981'; // emerald

// Strokes lost per category vs scratch, with a ~15-handicap marker and a hollow
// dot for the comparison set (previous window overall, your overall on By Course).
function renderStrokesGained(rounds, chartId, summaryId, compare = [], compareLabel = 'previous') {
  const el = document.getElementById(chartId);
  const agg = aggregateSG(rounds);
  if (!el) return;
  if (!agg) { noData(chartId, 'No strokes-gained estimate yet'); setSummary(summaryId, ''); return; }
  const prev = compare.length ? aggregateSG(compare) : null;
  const cats = SG_CATS.filter(([k]) => agg[k] != null).map(([k, l]) => ({ k, l, v: agg[k], p: prev?.[k] ?? null, bm: SG_BENCHMARK_15[k] }));
  const side = el.clientWidth > 700;
  const W = Math.max(300, chartWidth(el) - (side ? 226 : 0)), Lm = 96, Rm = 46, rowH = 44, H = cats.length * rowH + 30;
  const all = cats.flatMap(c => [c.v, c.p, c.bm]).filter(v => v != null);
  const lo = Math.min(-2, Math.floor(Math.min(...all)) - 1), hi = Math.max(0, Math.ceil(Math.max(...all)));
  const x = v => Lm + (W - Lm - Rm) * (v - lo) / (hi - lo);
  let s = svgOpen(W, H);
  const step = niceStep((hi - lo) / 5);
  for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
    s += `<line x1="${x(g)}" x2="${x(g)}" y1="4" y2="${H - 20}" stroke="${g === 0 ? BD.subtle : BD.light}"/>`
      + svgText(x(g), H - 6, g === 0 ? 'Scratch' : g, `font-size="10" fill="${BD.subtle}" text-anchor="middle"`);
  }
  cats.forEach((c, i) => {
    const y = 10 + i * rowH;
    const behind = c.v < c.bm;
    s += svgText(0, y + 12, c.l, `font-size="12" font-weight="600" fill="${BD.text}"`);
    s += `<rect x="${Lm}" y="${y}" width="${W - Lm - Rm}" height="16" rx="4" fill="${BD.panel}"/>`;
    s += `<rect x="${Math.min(x(0), x(c.v))}" y="${y}" width="${Math.abs(x(c.v) - x(0))}" height="16" rx="4" fill="${c.v >= 0 ? SG_POS_COLOR : SG_NEG_COLOR}" opacity="${behind || c.v >= 0 ? .85 : .45}"><title>${c.l}: ${fmtSigned(c.v)} strokes/round</title></rect>`;
    s += `<line x1="${x(c.bm)}" x2="${x(c.bm)}" y1="${y - 4}" y2="${y + 20}" stroke="${BD.text}" stroke-width="2"/>`;
    if (c.p != null) s += `<circle cx="${x(c.p)}" cy="${y + 8}" r="3.5" fill="#fff" stroke="${BD.muted}" stroke-width="1.5"><title>${compareLabel}: ${fmtSigned(c.p)}</title></circle>`;
    s += svgText(W, y + 12, fmtSigned(c.v), `font-size="12.5" font-weight="800" fill="${c.v >= 0 ? SG_POS_COLOR : SG_NEG_COLOR}" text-anchor="end"`);
    s += svgText(Lm, y + 30, `${fmtSigned(c.v - c.bm)} vs ~15 handicap`, `font-size="9.5" fill="${behind ? BD.red : BD.greenD}"`);
  });
  s += '</svg>';
  const byGap = [...cats].sort((a, b) => (a.v - a.bm) - (b.v - b.bm));
  const worst = byGap[0], best = byGap.at(-1);
  const cards = `<div class="sg-side">
      <div class="${agg.total < 0 ? 'bad' : ''}"><b class="${agg.total < 0 ? 'down' : 'up'}">${fmtSigned(agg.total)}</b><strong>strokes / round vs scratch</strong>${prev?.total != null ? `<br>${compareLabel}: ${fmtSigned(prev.total)}` : ''}</div>
      ${worst.v < worst.bm ? `<div class="bad"><b class="down">${fmtSigned(worst.v - worst.bm)}</b><strong>${worst.l}</strong> is furthest behind a ~15 handicap</div>` : ''}
      ${best !== worst ? `<div><b class="${best.v >= best.bm ? 'up' : ''}">${fmtSigned(best.v - best.bm)}</b><strong>${best.l}</strong> ${best.v >= best.bm ? 'already beats' : 'is closest to'} a ~15 handicap</div>` : ''}
    </div>`;
  el.innerHTML = `<div class="sg-wrap" style="${side ? '' : 'grid-template-columns:1fr'}"><div><div class="bd-chart">${s}</div>
    ${legend([[SG_NEG_COLOR, 'You (avg / round)'], [BD.text, '~15 handicap'], ...(prev ? [['#fff;border:1.5px solid ' + BD.muted, compareLabel[0].toUpperCase() + compareLabel.slice(1), 'dot']] : [])])}</div>${cards}</div>`;
  setSummary(summaryId, `Based on ${agg.n} round${agg.n !== 1 ? 's' : ''} with an estimate.`);
}

function renderSGTrend(rounds, chartId, summaryId) {
  const pts = rounds.filter(r => r.sg?.total != null);
  if (!pts.length) { noData(chartId, 'No strokes-gained estimate yet'); setSummary(summaryId, ''); return; }
  trendLine(chartId, summaryId, pts.map(r => r.date), pts.map(r => r1(r.sg.total)), 'Total SG', C_TEAL, null, true);
}

// ── Focus This Week (prescriptive card driven by the worst SG category) ─────────
const SG_FOCUS = {
  off_tee: {
    title: 'Off the Tee',
    body: 'You\'re leaking the most strokes from the tee — usually a mix of missed fairways and the recoveries they force. Getting the ball in play more often is the fastest fix.',
    drills: [
      'Hit a "fairway finder" club (3-wood/hybrid) on the 3 tightest holes instead of driver.',
      'On the range, play 9 imaginary tee shots to a 30-yard-wide fairway; score each in/out.',
      'Pick one start line and one shot shape for the round — commit to it on every tee.',
    ],
  },
  approach: {
    title: 'Approach Play',
    body: 'Approach is your single biggest opportunity — more greens in regulation is the highest-leverage change you can make to your scores. Prioritise solid contact and realistic targets over distance.',
    drills: [
      'Aim for the center of the green, never the pin — this alone raises GIR fast.',
      'Ladder drill: hit 5 balls each to 100/125/150 yds, note your real carry numbers.',
      'Club up one and swing at 80% on mid-irons to improve strike consistency.',
    ],
  },
  short_game: {
    title: 'Short Game',
    body: 'You\'re losing strokes around the green — converting more up-and-downs turns bogeys into pars without changing your ball-striking at all.',
    drills: [
      'Up-and-down game: 10 chips from 20–30 yds, get each within a putter-length.',
      'Practice one reliable "go-to" chip (same club, same motion) for normal lies.',
      'Spend half your short-game time on the 3–6 ft putts you\'ll have left.',
    ],
  },
  putting: {
    title: 'Putting',
    body: 'Putting is where you can save the most right now. Most lost strokes on the green come from lag distance control leading to 3-putts, not missed short putts.',
    drills: [
      'Lag ladder: roll putts to 20/30/40 ft, finishing within a 3-ft circle.',
      'Make 25 straight 3-footers before you leave — builds the tap-in habit.',
      'On the course, read every first putt for speed first, line second.',
    ],
  },
};

function renderFocus(rounds, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const agg = aggregateSG(rounds);
  if (!agg) {
    el.innerHTML = `<div class="insights-empty">⛳ Play a few more tracked rounds to unlock your focus area.</div>`;
    return;
  }
  const cats = SG_CATS.map(([k, l]) => ({ k, l, v: agg[k] })).filter(o => o.v != null);
  const worst = cats.filter(o => o.v < 0).sort((a, b) => a.v - b.v)[0];
  if (!worst) {
    el.innerHTML = `<div class="bd-focus good"><div>
      <div class="eyebrow">No weak link</div>
      <h4>Gaining strokes in every category</h4>
      <p>You're ahead of scratch across the board. Keep doing what you're doing — the next gains come from consistency.</p>
    </div></div>`;
    return;
  }
  const f = SG_FOCUS[worst.k];
  const gap = worst.v - SG_BENCHMARK_15[worst.k];
  el.innerHTML = `<div class="bd-focus">
    <div class="bd-focus-num"><b>${fmtSigned(worst.v)}</b><span>est. strokes / round</span><small>${fmtSigned(gap)} vs ~15 handicap</small></div>
    <div>
      <div class="eyebrow">Your #1 opportunity</div>
      <h4>${f.title}</h4>
      <p>${f.body}</p>
      <div class="eyebrow" style="margin-top:10px">Practice this week</div>
      <ol>${f.drills.map(d => `<li>${d}</li>`).join('')}</ol>
    </div>
  </div>`;
}

// ── Goals & projection ──────────────────────────────────────────────────────────
const GOALS_KEY = 'golfstats.goals';
const loadGoal = () => { try { return JSON.parse(localStorage.getItem(GOALS_KEY)) || null; } catch { return null; } };
const saveGoal = g => localStorage.setItem(GOALS_KEY, JSON.stringify(g));

const daysBetweenISO = (a, b) => (new Date(b) - new Date(a)) / 86400000;
function addDaysISO(iso, days) {
  const d = new Date(iso); d.setDate(d.getDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

// Linear projection of a goal. Lower is better for both score and handicap.
function projectGoal(rounds, type, target) {
  const pts = (type === 'handicap'
    ? rounds.filter(r => r.hcap_index != null).map(r => ({ d: r.date, v: r.hcap_index }))
    : rounds.filter(r => r.score != null).map(r => ({ d: r.date, v: r.score })));
  if (pts.length < 3) return null;
  const current = type === 'handicap' ? pts.at(-1).v : avg(pts.slice(-5).map(p => p.v));
  const start = type === 'handicap' ? pts[0].v : avg(pts.slice(0, 5).map(p => p.v));
  // least-squares slope (per round)
  const n = pts.length, xs = pts.map((_, i) => i), ys = pts.map(p => p.v);
  const mx = avg(xs), my = avg(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  const fittedStart = intercept;                  // line value at first round
  const fittedNow   = intercept + slope * (n - 1); // line value at latest round
  const reached = current <= target;
  let eta = null, direction = 'toward';
  if (reached) direction = 'reached';
  else if (slope >= -0.002) direction = 'away';   // not improving
  else {
    const roundsNeeded = (current - target) / (-slope);
    const span = daysBetweenISO(pts[0].d, pts.at(-1).d);
    const cadence = span > 0 ? span / (n - 1) : 7;  // avg days between rounds
    eta = addDaysISO(pts.at(-1).d, roundsNeeded * cadence);
  }
  // progress along the fitted trend from its start toward the target, so the bar
  // and the projection always agree in direction.
  const denom = fittedStart - target;
  const progress = reached ? 1
    : denom > 0 ? Math.max(0, Math.min(1, (fittedStart - fittedNow) / denom)) : 0;
  return { current, start, slope, eta, direction, reached, progress, n };
}

function goalSetterHtml(goal, rounds) {
  const hasHcap = rounds.some(r => r.hcap_index != null);
  const scores  = rounds.map(r => r.score).filter(v => v != null);
  const curScore = scores.length ? Math.round(avg(scores.slice(-5))) : 90;
  const curHcap  = hasHcap ? rounds.filter(r => r.hcap_index != null).at(-1).hcap_index : null;
  const type = goal?.type || (hasHcap ? 'handicap' : 'score');
  const target = goal?.target ?? (type === 'handicap' ? Math.max(0, Math.floor((curHcap ?? 20) - 3)) : Math.max(70, curScore - 5));
  return `<div class="goal-setter chart-card">
    <div class="goal-setter-title">Set a goal</div>
    <div class="goal-setter-row">
      <select id="goal-type" class="form-input">
        <option value="handicap"${type === 'handicap' ? ' selected' : ''}${hasHcap ? '' : ' disabled'}>Handicap index</option>
        <option value="score"${type === 'score' ? ' selected' : ''}>Round score (18h)</option>
      </select>
      <input id="goal-target" class="form-input" type="number" step="0.1" value="${target}" placeholder="Target">
      <button id="goal-save" class="btn btn-primary">Save goal</button>
      ${goal ? '<button id="goal-clear" class="btn btn-secondary">Clear</button>' : ''}
    </div>
  </div>`;
}

function wireGoalSetter(rounds) {
  const save = document.getElementById('goal-save');
  if (save) save.addEventListener('click', () => {
    const type = document.getElementById('goal-type').value;
    const target = parseFloat(document.getElementById('goal-target').value);
    if (isNaN(target)) { alert('Enter a numeric target.'); return; }
    saveGoal({ type, target });
    renderGoals(rounds);
  });
  const clear = document.getElementById('goal-clear');
  if (clear) clear.addEventListener('click', () => { localStorage.removeItem(GOALS_KEY); renderGoals(rounds); });
}

function renderGoals(rounds) {
  const el = document.getElementById('goals-overall');
  if (!el) return;
  const goal = loadGoal();
  if (!goal) { el.innerHTML = goalSetterHtml(null, rounds); wireGoalSetter(rounds); return; }

  const proj = projectGoal(rounds, goal.type, goal.target);
  const unit = goal.type === 'handicap' ? '' : '';
  const label = goal.type === 'handicap' ? 'Handicap index' : 'Avg score (last 5)';
  if (!proj) {
    el.innerHTML = `<div class="goal-card chart-card">
      <div class="goal-line"><span class="goal-label">${label} → target ${goal.target}</span></div>
      <div class="goal-sub">Not enough ${goal.type === 'handicap' ? 'rated rounds' : 'rounds'} in the current filter to project yet.</div>
      </div>${goalSetterHtml(goal, rounds)}`;
    wireGoalSetter(rounds);
    return;
  }

  const pct = Math.round(proj.progress * 100);
  let projText;
  if (proj.direction === 'reached')
    projText = `🎉 Goal reached — current ${fmt(proj.current)} is at or under ${goal.target}.`;
  else if (proj.direction === 'away')
    projText = `Trending the wrong way — no improvement slope in the current filter. ${fmt(proj.current)} vs target ${goal.target}.`;
  else
    projText = `On current trend, projected to hit ${goal.target} around <strong>${proj.eta}</strong>.`;

  el.innerHTML = `<div class="goal-card chart-card">
      <div class="goal-line">
        <span class="goal-label">${label}</span>
        <span class="goal-values"><strong>${fmt(proj.current)}</strong> <span class="goal-arrow">→</span> ${goal.target}${unit}</span>
      </div>
      <div class="goal-bar"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
      <div class="goal-sub">${projText}</div>
    </div>${goalSetterHtml(goal, rounds)}`;
  wireGoalSetter(rounds);
}

// ── Insights engine ─────────────────────────────────────────────────────────────
//
// Each rule returns null (not enough data) or an insight object:
//   { category, title, stat, statLabel, body, tip, severity, score }
//   severity: 'high' | 'med' | 'low' | 'good'
//   score: 0–1, higher = more urgent (used to rank + cap visible cards)
//
// Rules are evaluated against the filtered rounds + holes for the current view.

const INSIGHT_RULES = [

  // ── Putting ──────────────────────────────────────────────────────────────────
  function ruleAvgPutts(rounds, holes) {
    const vals = rounds.map(r => r.putts).filter(v => v != null && v > 0);
    if (vals.length < 2) return null;
    const a = avg(vals);
    // Baseline refs: scratch ~28, 10-hdcp ~31, 20-hdcp ~34, 30-hdcp ~36
    const score = Math.min(1, Math.max(0, (a - 28) / 10));
    const severity = a >= 35 ? 'high' : a >= 32 ? 'med' : a >= 30 ? 'low' : 'good';
    if (severity === 'good') return null;
    return {
      category: 'Putting', title: 'High average putt count',
      stat: fmt(a), statLabel: 'putts / round',
      body: `Averaging ${fmt(a)} putts per round. A scratch player averages ~28; a 20-handicap ~34. Every putt over 36 is a stroke you're giving away on the green.`,
      tip: a >= 35
        ? 'Prioritize lag putting — most extra putts come from long-range 3-putts, not missed short putts.'
        : 'Work on mid-range putts (10–20 ft). Converting one more per round saves a stroke immediately.',
      group: 'putting', severity, score,
    };
  },

  function ruleThreePuttPct(rounds, holes) {
    const hp = holes.filter(h => h.putts != null);
    if (hp.length < 18) return null;
    const threePct = hp.filter(h => h.putts >= 3).length / hp.length * 100;
    if (threePct < 8) return null;
    const score = Math.min(1, (threePct - 8) / 20);
    const severity = threePct >= 20 ? 'high' : threePct >= 14 ? 'med' : 'low';
    return {
      category: 'Putting', title: '3-putt rate is elevated',
      stat: `${threePct.toFixed(1)}%`, statLabel: 'of greens 3-putted',
      body: `You're 3-putting ${threePct.toFixed(1)}% of greens. Tour average is ~3%; a solid amateur target is under 10%.`,
      tip: 'Practice distance control on putts over 20 feet. Getting to within 3 feet eliminates almost all 3-putts.',
      group: 'putting', severity, score,
    };
  },

  // ── Greens in Regulation ─────────────────────────────────────────────────────
  function ruleGIR(rounds, holes) {
    const vals = rounds.map(r => r.gir_pct).filter(v => v != null);
    if (vals.length < 2) return null;
    const a = avg(vals);
    // 10-hdcp ~35%, 20-hdcp ~20%, 30-hdcp ~10%
    if (a >= 40) return null;
    const score = Math.min(1, (40 - a) / 35);
    const severity = a < 15 ? 'high' : a < 25 ? 'med' : 'low';
    return {
      category: 'Approach', title: 'Low greens in regulation %',
      stat: `${fmt(a)}%`, statLabel: 'GIR',
      body: `Hitting ${fmt(a)}% of greens in regulation. A 20-handicap averages around 20–25%. Missing greens forces recoveries that cost strokes even when you scramble well.`,
      tip: severity === 'high'
        ? 'Focus on iron contact before distance. Solid, centred strikes at 80% produce more GIRs than hard swings.'
        : 'Identify your most reliable iron distance and position tee shots to that yardage more often.',
      severity, score,
    };
  },

  // ── Scrambling ───────────────────────────────────────────────────────────────
  function ruleScrambling(rounds, holes) {
    const byId = {};
    for (const h of holes) (byId[h.activity_id] ||= []).push(h);
    const pts = rounds.map(r => {
      const hs = byId[r.activity_id] || [];
      const missed = hs.filter(h => h.gir === false && h.par != null && h.score != null);
      if (!missed.length) return null;
      return missed.filter(h => (h.score - h.par) <= 0).length / missed.length * 100;
    }).filter(v => v != null);
    if (pts.length < 2) return null;
    const a = avg(pts);
    // Tour ~60%, 10-hdcp ~40%, 20-hdcp ~25%
    if (a >= 45) return null;
    const score = Math.min(1, (45 - a) / 40);
    const severity = a < 20 ? 'high' : a < 30 ? 'med' : 'low';
    return {
      category: 'Short Game', title: 'Scrambling % needs work',
      stat: `${fmt(a)}%`, statLabel: 'scrambles',
      body: `You're saving par or better after a missed GIR ${fmt(a)}% of the time. A 20-handicap target is ~25–30%. This is the biggest leverage point after GIR for reducing scores.`,
      tip: 'Get up-and-down practice from within 30 yards. One extra chip to gimme range per round saves a stroke.',
      severity, score,
    };
  },

  // ── Fairways ─────────────────────────────────────────────────────────────────
  function ruleFairways(rounds, holes) {
    const vals = rounds.map(r => r.fairway_pct).filter(v => v != null);
    if (vals.length < 2) return null;
    const a = avg(vals);
    if (a >= 55) return null;
    const score = Math.min(1, (55 - a) / 50);
    const severity = a < 25 ? 'high' : a < 40 ? 'med' : 'low';
    return {
      category: 'Off the Tee', title: 'Low fairway hit %',
      stat: `${fmt(a)}%`, statLabel: 'fairways hit',
      body: `Hitting ${fmt(a)}% of fairways. Even a 20-handicap typically hits 40–50%. Fairways matter because second shots from rough cost roughly half a stroke each.`,
      tip: severity === 'high'
        ? 'Consider using a 3-wood or hybrid off tight tees. Fairway from 220 yds beats rough from 250 yds.'
        : 'Check your miss pattern below — a consistent left or right miss points to a fixable ball-flight tendency.',
      severity, score,
    };
  },

  // ── Fairway miss bias ────────────────────────────────────────────────────────
  function ruleFwyBias(rounds, holes) {
    const left  = holes.filter(h => h.fairway_missed === 'LEFT').length;
    const right = holes.filter(h => h.fairway_missed === 'RIGHT').length;
    const total = left + right;
    if (total < 10) return null;
    const ratio = Math.max(left, right) / total;
    if (ratio < 0.65) return null;
    const dominant = left > right ? 'left' : 'right';
    const pct = (ratio * 100).toFixed(0);
    const score = Math.min(1, (ratio - 0.65) / 0.25);
    const severity = ratio >= 0.80 ? 'high' : ratio >= 0.72 ? 'med' : 'low';
    return {
      category: 'Off the Tee', title: `Consistent miss ${dominant}`,
      stat: `${pct}%`, statLabel: `misses go ${dominant}`,
      body: `${pct}% of your fairway misses go ${dominant}. A strong bias this consistent is almost always a swing pattern issue, not bad luck.`,
      tip: dominant === 'left'
        ? 'A left miss for a right-hander usually means early extension or a closed face at impact. Try strengthening your grip slightly or delaying the release.'
        : 'A right miss for a right-hander often means an over-the-top path or open face. Focus on dropping the club into the slot from the top.',
      severity, score,
    };
  },

  // ── Penalties ────────────────────────────────────────────────────────────────
  function rulePenalties(rounds, holes) {
    const byId = {};
    for (const h of holes) (byId[h.activity_id] ||= []).push(h);
    const vals = rounds.map(r => sum((byId[r.activity_id] || []).map(h => h.penalties || 0)));
    if (vals.length < 2) return null;
    const a = avg(vals);
    if (a < 1) return null;
    const score = Math.min(1, (a - 1) / 3);
    const severity = a >= 3 ? 'high' : a >= 2 ? 'med' : 'low';
    return {
      category: 'Course Management', title: 'Penalty strokes piling up',
      stat: fmt(a), statLabel: 'penalties / round',
      body: `Averaging ${fmt(a)} penalty strokes per round. Penalties are the most expensive shots in golf — each one costs you the stroke plus distance.`,
      tip: 'On high-risk shots, ask: "What\'s the cost of the worst outcome?" Laying up to a comfortable yardage often costs less than a penalty.',
      severity, score,
    };
  },

  // ── Par type ─────────────────────────────────────────────────────────────────
  function ruleParType(rounds, holes) {
    const data = [3, 4, 5].map(par => {
      const hs = holes.filter(h => h.par === par && h.score != null);
      if (hs.length < 6) return null;
      return { par, avg: avg(hs.map(h => h.score - h.par)), n: hs.length };
    }).filter(Boolean);
    if (data.length < 2) return null;
    const worst = data.reduce((a, b) => b.avg > a.avg ? b : a);
    const best  = data.reduce((a, b) => b.avg < a.avg ? b : a);
    if (worst.avg - best.avg < 0.4) return null;   // not a meaningful gap
    const score = Math.min(1, (worst.avg - best.avg) / 2);
    const severity = worst.avg - best.avg >= 1.2 ? 'high' : worst.avg - best.avg >= 0.7 ? 'med' : 'low';
    const tips = {
      3: 'Par 3s reward reliable iron consistency over power. Club down one and make a smooth swing to the middle of the green.',
      4: 'Par 4s: fairway first, then distance. One extra fairway hit typically saves ~0.5 strokes vs. rough.',
      5: 'Par 5s are birdie opportunities. If you can\'t reach in 2 reliably, lay up to your favourite wedge distance instead of guessing.',
    };
    return {
      category: 'Par Type', title: `Struggling on par ${worst.par}s`,
      stat: fmtSigned(worst.avg), statLabel: `avg vs par on par ${worst.par}s`,
      body: `Your par ${worst.par}s average ${fmtSigned(worst.avg)} vs par, compared to ${fmtSigned(best.avg)} on par ${best.par}s — a gap of ${(worst.avg - best.avg).toFixed(1)} strokes per hole.`,
      tip: tips[worst.par],
      severity, score,
    };
  },

  // ── Handicap trend ───────────────────────────────────────────────────────────
  function ruleHcapTrend(rounds) {
    const pts = rounds.map(r => {
      const meta = getCourseMeta(r.course);
      if (!meta?.rating || !meta?.slope || r.score == null) return null;
      return { date: r.date, diff: (r.score - meta.rating) / meta.slope * 113 };
    }).filter(Boolean);
    if (pts.length < 5) return null;
    const half = Math.floor(pts.length / 2);
    const early = avg(pts.slice(0, half).map(p => p.diff));
    const late  = avg(pts.slice(half).map(p => p.diff));
    const delta = late - early;
    if (delta <= 0.5) return null;   // improving or flat
    const score = Math.min(1, delta / 5);
    const severity = delta >= 3 ? 'high' : delta >= 1.5 ? 'med' : 'low';
    return {
      category: 'Trend', title: 'Handicap differential is rising',
      stat: `+${delta.toFixed(1)}`, statLabel: 'diff rise (first half → recent)',
      body: `Your handicap differential has risen by ${delta.toFixed(1)} points comparing your first ${half} rounds to your most recent ${pts.length - half}. Something in your game has regressed.`,
      tip: 'Compare your GIR %, putts, and penalties between early and recent rounds to identify the specific category that changed.',
      severity, score,
    };
  },
];

// Benchmarks that should surface as positive reinforcement when truly strong
const GOOD_RULES = [
  function goodScrambling(rounds, holes) {
    const byId = {};
    for (const h of holes) (byId[h.activity_id] ||= []).push(h);
    const pts = rounds.map(r => {
      const hs = byId[r.activity_id] || [];
      const missed = hs.filter(h => h.gir === false && h.par != null && h.score != null);
      if (!missed.length) return null;
      return missed.filter(h => (h.score - h.par) <= 0).length / missed.length * 100;
    }).filter(v => v != null);
    if (pts.length < 2) return null;
    const a = avg(pts);
    if (a < 45) return null;
    return {
      category: 'Short Game', title: 'Strong short game',
      stat: `${fmt(a)}%`, statLabel: 'scrambles',
      body: `Scrambling ${fmt(a)}% — that's genuinely good. Your short game is compensating well for missed greens.`,
      tip: 'Keep it up. Maintaining this while improving GIR would compound quickly into lower scores.',
      severity: 'good', score: 0,
    };
  },
  function goodFairways(rounds, holes) {
    const vals = rounds.map(r => r.fairway_pct).filter(v => v != null);
    if (vals.length < 2) return null;
    const a = avg(vals);
    if (a < 60) return null;
    return {
      category: 'Off the Tee', title: 'Accurate off the tee',
      stat: `${fmt(a)}%`, statLabel: 'fairways hit',
      body: `Hitting ${fmt(a)}% of fairways is above average for most amateurs. You're giving yourself good looks at the green regularly.`,
      tip: 'With tee accuracy this strong, the next lever is iron consistency — closing the gap between fairway and GIR %.',
      severity: 'good', score: 0,
    };
  },
];

function generateInsights(rounds, holes) {
  const allRules = [...INSIGHT_RULES, ...GOOD_RULES];
  const insights = allRules
    .map(fn => {
      try { return fn(rounds, holes); } catch { return null; }
    })
    .filter(Boolean);

  // Deduplicate: within each group keep only the highest-scoring insight
  const seen = new Map();
  for (const i of insights) {
    if (!i.group) { seen.set(Symbol(), i); continue; }
    const existing = seen.get(i.group);
    if (!existing || i.score > existing.score) seen.set(i.group, i);
  }
  const deduped = [...seen.values()];

  // Rank: problems first (by score desc), then good news at the end
  const problems = deduped.filter(i => i.severity !== 'good').sort((a, b) => b.score - a.score);
  const good     = deduped.filter(i => i.severity === 'good');

  // Show top 4 problems + up to 1 good-news card
  return [...problems.slice(0, 4), ...good.slice(0, 1)];
}

function renderInsights(rounds, holes, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const insights = generateInsights(rounds, holes);
  const expanded = el.dataset.expanded === 'true';

  if (!insights.length) {
    el.innerHTML = `<div class="insights-empty">⛳ Not enough data yet — play a few more rounds to unlock personalised insights.</div>`;
    return;
  }

  const sevLabel = sv => sv === 'high' ? 'Priority' : sv === 'med' ? 'Watch' : sv === 'low' ? 'Minor' : 'Strength';
  // Compact rows: category, headline, severity and the number; tap a row for the detail and tip.
  const rowsHtml = insights.map(i => `
    <details class="insight-row">
      <summary>
        <span class="tag">${i.category}</span>
        <span class="ttl">${i.title}</span>
        <span class="sev ${i.severity}">${sevLabel(i.severity)}</span>
        <span class="v ${i.severity === 'good' ? 'up' : i.severity === 'high' ? 'down' : ''}">${i.stat}<small>${i.statLabel}</small></span>
      </summary>
      <div class="detail">${i.body}<div class="tip">💡 ${i.tip}</div></div>
    </details>`).join('');

  if (expanded) {
    el.innerHTML = `<div class="insight-rows">${rowsHtml}</div>`;
    return;
  }

  // Preserve open/closed state across re-renders
  const wasOpen = el.querySelector('details')?.open ?? false;
  const priorities = insights.filter(i => i.severity !== 'good');
  const highCount  = priorities.filter(i => i.severity === 'high').length;
  const label = priorities.length
    ? `${priorities.length} insight${priorities.length !== 1 ? 's' : ''}${highCount ? ` · ${highCount} priority` : ''}`
    : 'Looking good';

  el.innerHTML = `
    <details class="insights-details"${wasOpen ? ' open' : ''}>
      <summary class="insights-summary">
        <span class="insights-summary-label">
          <span class="insights-toggle-icon"></span>
          ${label}
        </span>
        <span class="insights-summary-pills">${priorities.slice(0, 3).map(i =>
          `<span class="insight-pill severity-${i.severity}">${i.title}</span>`
        ).join('')}</span>
      </summary>
      <div class="insight-rows">${rowsHtml}</div>
    </details>`;
}

function switchPanel(panel) {
  currentPanel = panel;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  const activeView = document.querySelector('.mode-view.active');
  if (!activeView) return;
  activeView.querySelectorAll('.sub-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === panel));
  // Tabs and filters apply to both Stats and Insights panels
  const showFilters = panel === 'stats' || panel === 'insights';
  document.querySelector('.filter-bar')?.classList.toggle('filter-bar--hidden', !showFilters);
  document.querySelector('.tabs-filter-row')?.classList.toggle('tabs-filter-row--hidden', !showFilters);
}

// ── Mode + setup ────────────────────────────────────────────────────────────────
function switchMode(newMode) {
  mode = newMode;
  document.querySelectorAll('.mode-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('view-course').classList.toggle('active', mode === 'course');
  document.getElementById('view-overall').classList.toggle('active', mode === 'overall');
  document.getElementById('view-manage').classList.toggle('active', mode === 'manage');
  // Course selector only shown on the By Course tab.
  document.body.classList.toggle('filters-hidden', mode !== 'course');
  // Hide left nav for manage view (no sub-panels); reset to stats otherwise.
  const leftNav = document.getElementById('left-nav');
  if (leftNav) leftNav.style.display = mode === 'manage' ? 'none' : '';
  switchPanel('stats');
  render();
}

function render() {
  const base = baseFilteredRounds();
  const n = base.length;
  document.getElementById('round-count').textContent = `${n} round${n !== 1 ? 's' : ''} (all courses)`;
  if (mode === 'course') renderCourseView();
  else if (mode === 'overall') renderOverallView();
  else renderManageView();
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

  // Default to the last 20 rounds (WHS handicap window); date pickers only
  // apply under "Custom dates".
  const rangeSel = document.getElementById('filter-range');
  const syncRangeInputs = () => {
    const custom = rangeSel.value === 'custom';
    document.getElementById('filter-date-from').disabled = !custom;
    document.getElementById('filter-date-to').disabled = !custom;
  };
  rangeSel.value = 'last20';
  syncRangeInputs();
  rangeSel.addEventListener('change', () => { syncRangeInputs(); render(); });

  sel.addEventListener('change', () => {
    selectedCourse = sel.value;
    localStorage.setItem(LS_KEY, selectedCourse);
    render();
  });
  document.getElementById('filter-holes').addEventListener('change', render);
  ['filter-date-from','filter-date-to'].forEach(id =>
    document.getElementById(id).addEventListener('change', () => {
      rangeSel.value = 'custom';
      syncRangeInputs();
      render();
    }));
  const ringerStart = document.getElementById('ringer-start-date');
  if (ringerStart) {
    ringerStart.addEventListener('change', () => {
      localStorage.setItem(RINGER_START_KEY, ringerStart.value || '');
      if (mode === 'course') renderCourseView();
    });
  }
  document.getElementById('c-scorecard-selector').addEventListener('change', e => {
    const base = baseFilteredRounds().filter(r => r.course === selectedCourse);
    const { holes, shots } = bundle(base);
    renderScorecard(e.target.value, holes, shots);
  });
  document.querySelectorAll('.mode-tabs .tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchMode(btn.dataset.mode)));
  document.getElementById('btn-export-courses').addEventListener('click', exportCoursesJson);
  // Sidebar filters only apply to the By Course view; hide elsewhere.
  document.body.classList.toggle('filters-hidden', mode !== 'course');
  // Wire left nav buttons.
  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel)));
  // Set initial sub-panel state.
  switchPanel('stats');
}

// ── Course Manager ────────────────────────────────────────────────────────────

// Returns true if the given Garmin course string resolves to a known course.
function resolvesCourse(courseStr) {
  if (!courseStr || courseStr === 'Unknown') return true;
  const key = courseStr.toLowerCase();
  if (aliasIndex[key]) return true;
  for (const alias of Object.keys(aliasIndex)) {
    if (key.includes(alias) || alias.includes(key)) return true;
  }
  return false;
}

function getUnmatchedCourseStrings() {
  return [...new Set(allRounds.map(r => r.course))].filter(s => !resolvesCourse(s));
}

function saveAliasOverride(garminStr, canonicalName) {
  const saved = JSON.parse(localStorage.getItem('golfstats.aliases') || '{}');
  saved[garminStr] = canonicalName;
  localStorage.setItem('golfstats.aliases', JSON.stringify(saved));
}

function saveNewCourseOverride(courseObj) {
  const saved = JSON.parse(localStorage.getItem('golfstats.new_courses') || '[]');
  const idx = saved.findIndex(c => c.name === courseObj.name);
  if (idx >= 0) saved[idx] = courseObj; else saved.push(courseObj);
  localStorage.setItem('golfstats.new_courses', JSON.stringify(saved));
}

function exportCoursesJson() {
  const output = JSON.parse(JSON.stringify(rawCoursesData));
  const savedAliases = JSON.parse(localStorage.getItem('golfstats.aliases') || '{}');
  const savedCourses = JSON.parse(localStorage.getItem('golfstats.new_courses') || '[]');
  for (const c of savedCourses) {
    if (!output.find(x => x.name === c.name)) output.push(c);
  }
  for (const [alias, canon] of Object.entries(savedAliases)) {
    const course = output.find(c => c.name === canon);
    if (course) {
      if (!course.aliases) course.aliases = [];
      if (!course.aliases.map(a => a.toLowerCase()).includes(alias.toLowerCase())) course.aliases.push(alias);
    }
  }
  const blob = new Blob([JSON.stringify({ courses: output }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'courses.json'; a.click();
  URL.revokeObjectURL(url);
}

function renderManageView() {
  const unmatched = getUnmatchedCourseStrings();

  // Update badge on the tab
  const badge = document.getElementById('manage-badge');
  if (badge) { badge.textContent = unmatched.length; badge.style.display = unmatched.length ? 'inline-flex' : 'none'; }

  const knownCourses = Object.values(courseMeta).sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById('manage-summary').textContent =
    `${knownCourses.length} known course${knownCourses.length !== 1 ? 's' : ''} · ${unmatched.length} unmatched Garmin string${unmatched.length !== 1 ? 's' : ''}`;

  // ── Unmatched section ──
  const unmatchedEl = document.getElementById('manage-unmatched');
  if (!unmatched.length) {
    unmatchedEl.innerHTML = '<div class="no-data" style="height:80px">All rounds are matched to a known course ✓</div>';
  } else {
    const existingOpts = knownCourses.map(c =>
      `<option value="${c.name.replace(/"/g,'&quot;')}">${c.name}</option>`).join('');
    unmatchedEl.innerHTML = unmatched.map(garminStr => {
      const rounds = allRounds.filter(r => r.course === garminStr);
      const dates  = rounds.map(r => r.date).sort();
      const slug   = garminStr.replace(/[^a-z0-9]/gi, '_');
      return `<div class="unmatched-card" data-garmin="${garminStr.replace(/"/g,'&quot;')}">
        <div class="unmatched-header">
          <div class="unmatched-name">${garminStr}</div>
          <div class="unmatched-meta">${rounds.length} round${rounds.length !== 1 ? 's' : ''} · ${dates[0]} – ${dates.at(-1)}</div>
        </div>
        <div class="manage-actions-grid">
          <div class="manage-form-panel">
            <div class="manage-form-label">Map to existing course</div>
            <select class="form-input map-select" data-slug="${slug}">
              <option value="">Select course…</option>${existingOpts}
            </select>
            <button class="btn btn-primary map-save" data-garmin="${garminStr.replace(/"/g,'&quot;')}" data-slug="${slug}">Save &amp; Reload</button>
          </div>
          <div class="manage-form-panel">
            <div class="manage-form-label">Create new course entry</div>
            <div class="form-grid-2">
              <input class="form-input" placeholder="Canonical name *" data-field="name" data-slug="${slug}">
              <input class="form-input" placeholder="Tee box" data-field="tee_box" data-slug="${slug}">
              <input class="form-input" type="number" placeholder="Par" data-field="par" data-slug="${slug}">
              <input class="form-input" type="number" step="0.1" placeholder="Course rating" data-field="rating" data-slug="${slug}">
              <input class="form-input" type="number" placeholder="Slope" data-field="slope" data-slug="${slug}">
              <input class="form-input" type="number" placeholder="Yards" data-field="yards" data-slug="${slug}">
            </div>
            <button class="btn btn-primary new-course-save" data-garmin="${garminStr.replace(/"/g,'&quot;')}" data-slug="${slug}">Save &amp; Reload</button>
          </div>
        </div>
      </div>`;
    }).join('');

    // Attach listeners for "map to existing"
    unmatchedEl.querySelectorAll('.map-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const sel = unmatchedEl.querySelector(`.map-select[data-slug="${btn.dataset.slug}"]`);
        if (!sel.value) { alert('Please select a course.'); return; }
        saveAliasOverride(btn.dataset.garmin, sel.value);
        location.reload();
      });
    });

    // Attach listeners for "create new course"
    unmatchedEl.querySelectorAll('.new-course-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const slug = btn.dataset.slug;
        const get = f => unmatchedEl.querySelector(`input[data-field="${f}"][data-slug="${slug}"]`)?.value.trim() || '';
        const name = get('name');
        if (!name) { alert('Canonical name is required.'); return; }
        const num = (v, float) => { const n = float ? parseFloat(v) : parseInt(v, 10); return isNaN(n) ? null : n; };
        saveNewCourseOverride({
          name,
          aliases: [btn.dataset.garmin],
          tee_box: get('tee_box') || null,
          par:     num(get('par')),
          rating:  num(get('rating'), true),
          slope:   num(get('slope')),
          yards:   num(get('yards')),
          holes:   [],
        });
        location.reload();
      });
    });
  }

  // ── Known courses table ──
  const knownEl = document.getElementById('manage-known');
  const rows = knownCourses.map(c => {
    const roundCount = allRounds.filter(r => {
      const k = r.course.toLowerCase();
      if (aliasIndex[k] === c.name) return true;
      for (const a of Object.keys(aliasIndex)) {
        if (aliasIndex[a] === c.name && (k.includes(a) || a.includes(k))) return true;
      }
      return false;
    }).length;
    const savedAliasesForCourse = Object.entries(JSON.parse(localStorage.getItem('golfstats.aliases') || '{}'))
      .filter(([,v]) => v === c.name).map(([k]) => k);
    const allAliases = [...(rawCoursesData.find(x => x.name === c.name)?.aliases || []), ...savedAliasesForCourse];
    return `<tr>
      <td class="metric-label">${c.name}</td>
      <td>${c.par ?? '—'}</td>
      <td>${c.rating ?? '—'}</td>
      <td>${c.slope ?? '—'}</td>
      <td>${roundCount}</td>
      <td class="alias-cell">${allAliases.join(', ') || '—'}</td>
    </tr>`;
  }).join('');
  knownEl.innerHTML = `<div class="chart-card" style="padding:0;overflow:hidden">
    <table class="compare-table">
      <thead><tr><th style="text-align:left">Course</th><th>Par</th><th>Rating</th><th>Slope</th><th>Rounds</th><th style="text-align:left">Aliases</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Init ────────────────────────────────────────────────────────────────────────
const HERO_IMAGES = [
  'IMG_4552.gif', 'IMG_4555.gif', 'IMG_4690.gif', 'IMG_4873.gif', 'IMG_4967.gif',
  'IMG_6071.gif', 'IMG_6654.gif', 'IMG_6611.gif', 'IMG_6615.gif', 'IMG_6701.gif',
];

function setupHero() {
  const img = document.getElementById('hero-img');
  if (!img) return;
  const pick = HERO_IMAGES[Math.floor(Math.random() * HERO_IMAGES.length)];
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  img.src = `../images/${pick}`;
}

async function init() {
  try {
    setupHero();
    await loadData();
    setupChrome();
    if (lastUpdated) document.getElementById('last-updated').textContent = `Last synced: ${lastUpdated.slice(0, 10)}`;
    // Update manage badge immediately so it shows even before user clicks the tab
    const _badge = document.getElementById('manage-badge');
    if (_badge) { const _n = getUnmatchedCourseStrings().length; _badge.textContent = _n; _badge.style.display = _n ? 'inline-flex' : 'none'; }
    render();
    tidyCardText();
    // Lazy-load shot data, then refresh shot-dependent sections.
    loadShots().then(() => render());
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `
      <div style="padding:40px;font-family:sans-serif;color:#dc2626">
        <h2>Failed to load data</h2><p>${err.message}</p>
        <p style="color:#64748b;margin-top:8px">Serve via HTTP, not file:// — run: python3 -m http.server 8765</p>
      </div>`;
  }
}

// Tuck each card's verbose description behind an (i) toggle, and drop the
// per-panel intro paragraphs. Keeps the one-line .chart-summary visible.
function tidyCardText() {
  document.querySelectorAll('.panel-intro').forEach(el => el.remove());

  document.querySelectorAll('.chart-card > .chart-desc')
    .forEach((desc, i) => {
      const title = desc.parentElement.querySelector('.chart-title');
      if (!title || !desc.textContent.trim() || desc.dataset.tucked) return;
      desc.dataset.tucked = '1';
      desc.classList.add('tucked');
      const id = desc.id || (desc.id = `chart-desc-${i}`);

      const row = document.createElement('div');
      row.className = 'chart-title-row';
      title.replaceWith(row);
      row.appendChild(title);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chart-info-btn';
      btn.textContent = 'i';
      btn.setAttribute('aria-label', 'About this chart');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', id);
      btn.addEventListener('click', () => {
        const open = desc.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
      });
      row.appendChild(btn);
    });
}

// SVG breakdown charts are drawn at their container's width, so redraw when
// the width changes (Plotly charts resize themselves).
(function redrawOnResize() {
  let timer = null, lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(() => { if (allRounds.length) render(); }, 200);
  });
})();

// Collapse the hero header to a slim bar once the user scrolls (hysteresis so it
// doesn't flicker at the threshold when the page height changes).
(function stickyHeader() {
  let collapsed = false;
  const onScroll = () => {
    const y = window.scrollY;
    if (!collapsed && y > 120) { collapsed = true; document.body.classList.add('header-collapsed'); }
    else if (collapsed && y < 40) { collapsed = false; document.body.classList.remove('header-collapsed'); }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

init();
