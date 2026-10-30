// ── Round report ─────────────────────────────────────────────────────────────
// One page per round in an editorial layout. Strokes gained is computed here
// shot by shot: each shot's GPS start/end is measured against the point where the
// hole finished (the last recorded shot's end, i.e. roughly the pin), valued with a
// scratch baseline, then shifted by the strokes the player's handicap gives on
// that hole so 0 means "played to handicap".

const SC = 180 / 2 ** 31;           // Garmin semicircles -> degrees
const YD_PER_M = 1.09361;
const SHORT_GAME_YD = 50;
const HERO_IMAGES = [
  'IMG_4552.gif', 'IMG_4555.gif', 'IMG_4690.gif', 'IMG_4873.gif', 'IMG_4967.gif',
  'IMG_6071.gif', 'IMG_6654.gif', 'IMG_6611.gif', 'IMG_6615.gif', 'IMG_6701.gif',
];
const CATS = [
  { key: 'off_tee',    label: 'Off the tee', short: 'TEE' },
  { key: 'approach',   label: 'Approach',    short: 'APP' },
  { key: 'short_game', label: 'Short game',  short: 'SHORT' },
  { key: 'putting',    label: 'Putting',     short: 'PUTT' },
];
// How a handicap's extra strokes are shared across categories (typical
// mid-handicap split vs scratch). Par 3s have no off-the-tee share.
const HCP_SPLIT = { off_tee: 0.25, approach: 0.40, short_game: 0.15, putting: 0.20 };
const COL = {
  ink: '#1d2b24', muted: '#6e736d', faint: '#a3a69f', line: '#e5e0d4', panel: '#eeede6',
  green: '#3f7a5b', greenD: '#1f4a36', sage: '#8db59a', sageL: '#d6e6d9',
  rose: '#eec3bc', red: '#c95b4f', yellow: '#e2c46c', gold: '#b38b3d',
};
const RESULT = [
  { key: 'eagle',  label: 'Eagle',    color: COL.yellow, test: d => d <= -2 },
  { key: 'birdie', label: 'Birdies',  color: '#7fae8c',  test: d => d === -1 },
  { key: 'par',    label: 'Pars',     color: '#cfe1d2',  test: d => d === 0 },
  { key: 'bogey',  label: 'Bogeys',   color: '#ecbdb5',  test: d => d === 1 },
  { key: 'double', label: 'Doubles+', color: '#d06a5d',  test: d => d >= 2 },
];

// ── Scratch baseline (expected strokes to hole out) ──
const BASE = {
  tee: [[100,2.92],[120,2.99],[140,2.97],[160,2.99],[180,3.05],[200,3.12],[220,3.17],[240,3.25],[260,3.45],[280,3.65],[300,3.71],[320,3.79],[340,3.86],[360,3.92],[380,3.96],[400,3.99],[420,4.02],[440,4.08],[460,4.17],[480,4.28],[500,4.41],[520,4.54],[540,4.65],[560,4.74],[600,4.82]],
  fairway: [[0,1.9],[5,2.1],[10,2.18],[20,2.40],[40,2.60],[60,2.70],[80,2.75],[100,2.80],[120,2.85],[140,2.91],[160,2.98],[180,3.08],[200,3.19],[220,3.32],[240,3.45],[260,3.58],[280,3.69],[300,3.78],[350,3.95],[400,4.10],[500,4.50]],
  rough: [[0,2.0],[5,2.2],[10,2.34],[20,2.59],[40,2.78],[60,2.91],[80,2.96],[100,3.02],[120,3.08],[140,3.15],[160,3.23],[180,3.31],[200,3.42],[220,3.53],[240,3.64],[260,3.74],[280,3.83],[300,3.90],[400,4.20],[500,4.60]],
  sand: [[0,2.2],[10,2.43],[20,2.53],[40,2.82],[60,3.15],[80,3.24],[100,3.23],[120,3.21],[140,3.22],[160,3.28],[180,3.40],[200,3.55],[220,3.70],[240,3.84],[260,3.93],[300,4.10]],
  // putts, keyed by feet
  putt: [[1,1.0],[2,1.01],[3,1.04],[4,1.13],[5,1.23],[6,1.34],[7,1.42],[8,1.50],[9,1.56],[10,1.61],[15,1.78],[20,1.87],[30,1.98],[40,2.06],[50,2.14],[60,2.21],[90,2.40]],
};
function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) { const [x0, y0] = table[i - 1]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  const [xa, ya] = table.at(-2), [xb, yb] = table.at(-1);
  return yb + (yb - ya) * (x - xb) / (xb - xa);
}
// The pin isn't recorded, so the first putt's length is a typical proximity for
// the distance the green was reached from.
const firstPuttFt = fromYd => Math.max(3, 0.21 * fromYd + 3);
const expPutts = fromYd => interp(BASE.putt, firstPuttFt(fromYd));
function expected(lie, yd) {
  if (lie === 'tee') return interp(BASE.tee, Math.max(yd, 100));
  if (lie === 'green') return interp(BASE.putt, Math.max(1, yd * 3));
  if (lie === 'sand') return interp(BASE.sand, yd);
  if (lie === 'fairway') return interp(BASE.fairway, yd);
  if (lie === 'recovery') return interp(BASE.rough, yd) + 0.25;
  return interp(BASE.rough, yd);
}
function lieOf(s, i) {
  if (i === 0 && (s.lie === 'TeeBox' || s.shot_type === 'TEE')) return 'tee';
  if (s.shot_type === 'RECOVERY') return 'recovery';
  return { TeeBox: 'fairway', Fairway: 'fairway', Bunker: 'sand', Green: 'green' }[s.lie] || 'rough';
}

// ── Small helpers ──
const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => a.length ? sum(a) / a.length : null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = x => x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1);
const sg1 = x => x == null ? '—' : (x > 0.049 ? '+' : '') + f1(x);
const sgInt = x => x == null ? '—' : (x > 0 ? '+' : '') + Math.round(x);
const toPar = d => d === 0 ? 'E' : (d > 0 ? `+${d}` : `${d}`);
const pct = (n, d) => d ? Math.round(100 * n / d) : null;
const signCls = x => x > 0.05 ? 'pos' : x < -0.05 ? 'neg' : '';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const shortDate = iso => { const [, m, d] = iso.split('-'); return `${MONTHS[+m - 1]} ${+d}`; };
const longDate = iso => { const [y, m, d] = iso.split('-'); return `${MONTHS[+m - 1]} ${+d}, ${y}`; };
const words = n => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][n] ?? String(n);
const plural = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;
const CLUB_SHORT = {
  'Driver': 'Driver', '2-Wood': '2W', '3-Wood': '3W', '4-Wood': '4W', '5-Wood': '5W', '6-Wood': '6W', '7-Wood': '7W',
  'Hybrid': 'Hy', '1-Iron': '1i', '2-Iron': '2i', '3-Iron': '3i', '4-Iron': '4i', '5-Iron': '5i', '6-Iron': '6i',
  '7-Iron': '7i', '8-Iron': '8i', '9-Iron': '9i', 'Pitching Wedge': 'PW', 'Approach Wedge': 'AW', 'Sand Wedge': 'SW',
  'Lob Wedge': 'LW', 'Chipper': 'Chip', 'Putter': 'Putter',
};
const CLUB_ORDER = Object.keys(CLUB_SHORT);
const clubShort = n => CLUB_SHORT[n] || n;

function resultOf(d) { return RESULT.find(r => r.test(d)); }
function resultColor(d) { return resultOf(d).color; }
function sgFill(v) {
  if (v == null) return 'transparent';
  const t = Math.min(1, Math.abs(v) / 1.5);
  if (Math.abs(v) < 0.15) return '#efeee8';
  return v > 0 ? `rgba(95,160,115,${0.18 + 0.45 * t})` : `rgba(214,110,96,${0.18 + 0.45 * t})`;
}

// ── Data ──
let rounds = [], holesBy = {}, shotsBy = {};
const analysisCache = new Map();

async function load() {
  const [r, h, s] = await Promise.all(['rounds', 'holes', 'shots'].map(f => fetch(`../data/${f}.json`).then(x => x.json())));
  // Some rounds were synced twice under different activity IDs.
  const seen = new Set();
  const key = x => `${x.date}|${x.course}|${x.totals.score}|${x.totals.holes_played}`;
  rounds = r.rounds.filter(x => x.totals?.score && !seen.has(key(x)) && seen.add(key(x)))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const x of h.holes) (holesBy[x.activity_id] ||= []).push(x);
  for (const x of s.shots) (shotsBy[x.activity_id] ||= []).push(x);
}

// Handicap index going into the round: the latest index from an earlier round.
function indexBefore(r) {
  const prior = rounds.find(x => x.date < r.date && x.hcap_index != null);
  return prior?.hcap_index ?? r.hcap_index ?? rounds.find(x => x.hcap_index != null)?.hcap_index ?? null;
}

function analyze(r) {
  if (analysisCache.has(r.activity_id)) return analysisCache.get(r.activity_id);
  const holes = (holesBy[r.activity_id] || []).filter(h => h.score != null).sort((a, b) => a.hole - b.hole);
  const allShots = shotsBy[r.activity_id] || [];
  const n = holes.length;
  const idx = indexBefore(r);
  const par = sum(holes.map(h => h.par || 4));
  let ch = null;
  if (idx != null && r.tee_box_slope && r.tee_box_rating) {
    const ratingPar = n >= 18 ? par : par * 2;          // 9-hole rounds carry a 9-hole rating
    const rating18 = r.tee_box_rating < 50 ? r.tee_box_rating * 2 : r.tee_box_rating;
    const ch18 = idx * r.tee_box_slope / 113 + (rating18 - ratingPar);
    ch = Math.max(0, Math.round(ch18 * n / 18));
  }
  const ranked = [...holes].sort((a, b) => (a.hole_handicap_index ?? 99) - (b.hole_handicap_index ?? 99) || a.hole - b.hole);
  const strokesOn = {};
  ranked.forEach((h, i) => { strokesOn[h.hole] = ch == null || !n ? 0 : Math.floor(ch / n) + (i < ch % n ? 1 : 0); });

  const out = { round: r, holes: [], ch, idx, par, n };
  for (const h of holes) out.holes.push(analyzeHole(h, allShots.filter(s => s.hole === h.hole), strokesOn[h.hole]));

  out.score = sum(out.holes.map(x => x.score));
  out.expected = par + (ch ?? 0);
  out.vsHcp = out.expected - out.score;
  out.cats = {};
  for (const c of CATS) out.cats[c.key] = sum(out.holes.map(x => x.cats[c.key]));
  out.nine = side => {
    const hs = out.holes.filter(x => side === 'out' ? x.hole <= 9 : x.hole > 9);
    const o = { total: sum(hs.map(x => x.total)), score: sum(hs.map(x => x.score)), par: sum(hs.map(x => x.par)), holes: hs };
    for (const c of CATS) o[c.key] = sum(hs.map(x => x.cats[c.key]));
    return o;
  };
  out.partialHoles = out.holes.filter(x => x.partial).length;
  analysisCache.set(r.activity_id, out);
  return out;
}

function analyzeHole(h, rawShots, strokes) {
  const par = h.par || 4;
  const shots = rawShots.filter(s => s.shot_type !== 'PUTT' && s.lat != null && s.end_lat != null)
    .sort((a, b) => a.shot_number - b.shot_number);
  const pen = h.penalties || 0;
  const putts = h.putts;
  const res = { hole: h.hole, par, score: h.score, putts, pen, strokes, yardage: h.yardage, raw: h, shots: [],
    cats: { off_tee: 0, approach: 0, short_game: 0, putting: 0 }, partial: false };

  const pinSC = h.end_lat != null ? [h.end_lat, h.end_lon] : shots.length ? [shots.at(-1).end_lat, shots.at(-1).end_lon] : null;
  let eStart;
  if (shots.length && pinSC) {
    const ref = { lat: pinSC[0] * SC, lon: pinSC[1] * SC };
    const xy = (lat, lon) => {
      const k = Math.PI / 180 * 6371000 * YD_PER_M;
      return [(lon * SC - ref.lon) * k * Math.cos(ref.lat * Math.PI / 180), (lat * SC - ref.lat) * k];
    };
    shots.forEach((s, i) => {
      const a = xy(s.lat, s.lon), b = xy(s.end_lat, s.end_lon);
      res.shots.push({ s, i, a, b, startYd: Math.hypot(...a), endYd: Math.hypot(...b), lie: lieOf(s, i),
        club: s.club_type_name || null, dist: s.distance_yards });
    });
    const first = res.shots[0];
    eStart = first.lie === 'tee' ? expected('tee', first.startYd) : expected('tee', h.yardage || [0, 0, 0, 150, 340, 460][par]);
    if (first.lie !== 'tee') res.partial = true;
    res.shots.forEach((x, i) => {
      const next = res.shots[i + 1];
      const es = x.lie === 'tee' && i > 0 ? expected('tee', x.startYd) : expected(x.lie, x.startYd);
      const ee = next ? (next.lie === 'tee' ? expected('tee', next.startYd) : expected(next.lie, next.startYd))
        : (putts === 0 ? 0 : expPutts(x.startYd));
      x.sg = es - ee - 1;
      x.cat = i === 0 && x.lie === 'tee' && par >= 4 ? 'off_tee'
        : x.lie === 'green' ? 'putting'
        : x.startYd <= SHORT_GAME_YD ? 'short_game' : 'approach';
      res.cats[x.cat] += x.sg;
    });
    const last = res.shots.at(-1);
    if (putts != null && putts > 0) res.cats.putting += expPutts(last.startYd) - putts;
    res.puttFromYd = last.startYd;
  } else {
    eStart = expected('tee', h.yardage || [0, 0, 0, 150, 340, 460][par]);
    res.partial = true;
  }

  // Penalties count against the tee shot on par 4/5s, the approach otherwise.
  const penCat = par >= 4 && res.shots[0]?.cat === 'off_tee' ? 'off_tee' : 'approach';
  res.cats[penCat] -= pen;
  res.penCat = penCat;

  // Anything the recorded shots don't explain (missed sensor taps, no putt count).
  const scratchTotal = eStart - h.score;
  const residual = scratchTotal - sum(Object.values(res.cats));
  if (Math.abs(residual) > 0.01) {
    res.partial = true;
    if (res.shots.length) res.cats.short_game += residual;
    else spread(res.cats, residual, par);
  }
  // Shift from scratch to this player's handicap on this hole.
  const shift = par + strokes - eStart;
  const shares = spread(res.cats, shift, par);
  res.total = par + strokes - h.score;

  // Per-shot value vs handicap (for club-by-club), sharing each category's shift across its shots.
  const counts = {};
  res.shots.forEach(x => counts[x.cat] = (counts[x.cat] || 0) + 1);
  res.shots.forEach(x => { x.sgH = x.sg + shares[x.cat] / counts[x.cat]; });
  const penShot = res.shots.find(x => x.cat === penCat);
  if (penShot) penShot.sgH -= pen;
  res.puttSgH = putts != null && res.shots.length ? (putts > 0 ? expPutts(res.puttFromYd) - putts : 0) + shares.putting : null;

  res.gir = h.gir ?? (putts != null ? h.score - putts <= par - 2 : null);
  return res;
}
function spread(cats, amount, par) {
  const keys = CATS.map(c => c.key).filter(k => par >= 4 || k !== 'off_tee');
  const tot = sum(keys.map(k => HCP_SPLIT[k]));
  const shares = { off_tee: 0, approach: 0, short_game: 0, putting: 0 };
  for (const k of keys) { shares[k] = amount * HCP_SPLIT[k] / tot; cats[k] += shares[k]; }
  return shares;
}

// Tee shots on par 4/5s.
function teeShots(a) {
  return a.holes.filter(h => h.par >= 4 && h.raw.fairway_hit != null).map(h => {
    const t = h.shots[0]?.lie === 'tee' ? h.shots[0] : null;
    const dir = h.raw.fairway_hit ? 'hit' : (h.raw.fairway_missed_direction || '').toLowerCase() || 'miss';
    let lateral = 0;
    if (t) {
      const [ax, ay] = t.a, [bx, by] = t.b;
      const ux = -ax / Math.hypot(ax, ay), uy = -ay / Math.hypot(ax, ay);   // tee -> pin
      lateral = (bx - ax) * uy - (by - ay) * ux;                           // + = right
    }
    return { hole: h.hole, dir, dist: t ? Math.round(t.dist ?? Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1])) : null, lateral };
  });
}
function teeRates(a) {
  const t = teeShots(a);
  const c = d => t.filter(x => x.dir === d).length;
  return { n: t.length, hit: c('hit'), left: c('left'), right: c('right') };
}

// One approach per hole: the last full shot (from beyond short-game range).
function approaches(a) {
  const out = [];
  for (const h of a.holes) {
    let k = -1;
    h.shots.forEach((x, i) => { if (x.startYd > SHORT_GAME_YD && x.lie !== 'green') k = i; });
    if (k < 0) continue;
    const x = h.shots[k];
    const onGreen = k === h.shots.length - 1 && !h.partial;
    const [ax, ay] = x.a, [bx, by] = x.b;
    const L = Math.hypot(ax, ay);
    const ux = -ax / L, uy = -ay / L;
    const long = bx * ux + by * uy, right = bx * uy - by * ux;
    const miss = onGreen ? 'on' : Math.abs(long) >= Math.abs(right) ? (long > 0 ? 'long' : 'short') : (right > 0 ? 'right' : 'left');
    out.push({ hole: h.hole, onGreen, long, right, miss, fromYd: x.startYd, club: x.club });
  }
  return out;
}

const isFull = r => (r.totals.holes_played || 0) >= 14;
function previous(r, count = 10) {
  return rounds.filter(x => x.date < r.date && isFull(x) === isFull(r)).slice(0, count);
}

// ── SVG helpers ──
const svgOpen = (w, h, extra = '') => `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" ${extra}>`;
const txt = (x, y, s, a = '') => `<text x="${x}" y="${y}" ${a}>${s}</text>`;

// ── Sections ──
function section(num, eyebrow, name, aside = '') {
  return `<div class="sec-head"><div class="sec-title"><span class="sec-num">${String(num).padStart(2, '0')}</span><div>
    ${eyebrow ? `<div class="sec-eyebrow">${eyebrow}</div>` : ''}<h2 class="sec-name">${name}</h2></div></div>${aside}</div>`;
}

function heroHtml(a) {
  const r = a.round, d = a.score - a.par;
  const potential = a.score - sum(a.holes.map(h => h.pen)) - sum(a.holes.map(h => Math.max(0, (h.putts ?? 0) - 2)));
  const putts = a.holes.every(h => h.putts != null) ? sum(a.holes.map(h => h.putts)) : null;
  const best = [...CATS].sort((x, y) => a.cats[y.key] - a.cats[x.key])[0];
  const birdies = a.holes.filter(h => h.score - h.par <= -1).length;
  const pars = a.holes.filter(h => h.score === h.par).length;
  const headline = birdies ? `${words(birdies)} ${birdies === 1 ? 'birdie' : 'birdies'} gave your round its spark.`
    : pars >= 6 ? `${words(pars)} pars kept the card steady.`
    : a.vsHcp >= 0 ? 'A round that beat your handicap.' : 'Every round is a lesson.';
  const sub = a.cats[best.key] > 0 ? `${best.label} gained ${f1(a.cats[best.key])} strokes.` : `${a.n} holes in ${fmtDuration(r.duration_seconds)}.`;
  const img = HERO_IMAGES[[...r.activity_id].reduce((s, c) => s + c.charCodeAt(0), 0) % HERO_IMAGES.length];
  return `<section class="hero">
    <div class="hero-main">
      <div>
        <div class="gross-label">Gross score</div>
        <div class="gross"><span class="gross-num">${a.score}</span><span class="gross-par ${d > 0 ? 'neg' : 'pos'}">${toPar(d)}</span></div>
      </div>
      <div>
        <h1 class="course-name">${esc(r.course)}</h1>
        <div class="course-sub">${longDate(r.date)} · ${esc(r.tee_box || '—')} tees · ${a.n} holes</div>
        <div class="hero-stats">
          <div class="hero-stat"><b class="${signCls(a.vsHcp)}">${a.ch != null ? sg1(a.vsHcp) : '—'}</b><span>vs handicap</span></div>
          <div class="hero-stat"><b>${a.ch != null ? a.expected : '—'}</b><span>expected</span></div>
          <div class="hero-stat"><b>${potential}</b><span>potential</span></div>
          <div class="hero-stat"><b>${putts ?? '—'}</b><span>putts</span></div>
        </div>
      </div>
    </div>
    <div class="hero-photo" style="background-image:url('../images/${img}')">
      <div class="caption"><b>${headline}</b><span>${sub}</span></div>
    </div>
  </section>`;
}

function scorecardHtml(a) {
  const nines = [a.holes.filter(h => h.hole <= 9), a.holes.filter(h => h.hole > 9)].filter(x => x.length);
  const chip = h => {
    const d = h.score - h.par;
    const cls = d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'double' : '';
    return `<span class="sc-chip ${cls}">${h.score}</span>`;
  };
  const table = (hs, label) => `<table class="scorecard">
    <tr class="hole-row"><th>Hole</th>${hs.map(h => `<th>${h.hole}</th>`).join('')}<th class="tot">${label}</th></tr>
    <tr class="muted"><td>Par</td>${hs.map(h => `<td>${h.par}</td>`).join('')}<td class="tot">${sum(hs.map(h => h.par))}</td></tr>
    <tr class="muted"><td>Yards</td>${hs.map(h => `<td>${h.yardage ?? ''}</td>`).join('')}<td class="tot">${sum(hs.map(h => h.yardage || 0)) || ''}</td></tr>
    <tr><td>Score</td>${hs.map(h => `<td>${chip(h)}</td>`).join('')}<td class="tot">${sum(hs.map(h => h.score))}</td></tr>
    <tr class="muted"><td>Putts</td>${hs.map(h => `<td>${h.putts ?? '–'}</td>`).join('')}<td class="tot">${hs.every(h => h.putts != null) ? sum(hs.map(h => h.putts)) : '–'}</td></tr>
    <tr class="muted"><td>Strokes</td>${hs.map(h => `<td>${h.strokes ? '•'.repeat(h.strokes) : ''}</td>`).join('')}<td class="tot">${sum(hs.map(h => h.strokes))}</td></tr>
  </table>`;
  const putts = a.holes.every(h => h.putts != null) ? sum(a.holes.map(h => h.putts)) : '—';
  const legend = RESULT.slice(0, 2).concat(RESULT.slice(3)).map(x => `<span><i style="background:${x.color}"></i>${x.label.replace(/s\+?$/, '')}</span>`).join('');
  return `<section class="card w7">
    ${section(1, '', 'Your scorecard', `<div class="sc-legend">${legend}</div>`)}
    <div class="scorecard-wrap">${nines.map((hs, i) => table(hs, i ? 'IN' : 'OUT')).join('')}</div>
    <div class="sc-total"><div>TOTAL</div><div>PAR <b>${a.par}</b></div><div>SCORE <b class="${a.score > a.par ? 'neg' : 'pos'}">${a.score} (${toPar(a.score - a.par)})</b></div><div>PUTTS <b>${putts}</b></div></div>
    <p class="note">Dots mark handicap strokes received${a.ch != null ? ` (course handicap ${a.ch}, index ${a.idx})` : ''}.</p>
  </section>`;
}

function clubDistances(r) {
  const by = {};
  for (const s of shotsBy[r.activity_id] || []) {
    if (!['TEE', 'APPROACH', 'LAYUP'].includes(s.shot_type) || !s.club_type_name || !s.distance_yards) continue;
    if (s.club_type_name === 'Putter') continue;
    (by[s.club_type_name] ||= []).push(s.distance_yards);
  }
  return by;
}
function clubsHtml(a) {
  const now = clubDistances(a.round);
  const prev = {};
  for (const p of previous(a.round)) for (const [k, v] of Object.entries(clubDistances(p))) (prev[k] ||= []).push(...v);
  const clubs = CLUB_ORDER.filter(c => now[c] || (prev[c] && prev[c].length >= 3));
  if (!clubs.length) return '';
  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
  const max = Math.max(...clubs.flatMap(c => [...(now[c] || []), ...(prev[c] || []).map(() => 0)]), ...clubs.map(c => prev[c] ? q(prev[c], 0.75) : 0)) * 1.05;
  const W = 460, rowH = 22, L = 64, R = 70, H = clubs.length * rowH + 26;
  const x = v => L + (W - L - R) * v / max;
  let s = svgOpen(W, H);
  const ticks = [0, Math.round(max / 2 / 10) * 10, Math.round(max / 10) * 10];
  ticks.forEach(t => { s += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H - 20}" stroke="${COL.line}"/>` + txt(x(t), H - 6, `${t} yd`, `font-size="9.5" fill="${COL.muted}" text-anchor="middle"`); });
  clubs.forEach((c, i) => {
    const y = i * rowH + 6;
    const n = now[c] ? avg(now[c]) : null;
    const p = prev[c]?.length >= 3 ? prev[c] : null;
    s += txt(0, y + 10, clubShort(c), `font-size="11" font-weight="600" fill="${COL.ink}"`);
    if (p) s += `<rect x="${x(q(p, .25))}" y="${y + 1}" width="${Math.max(2, x(q(p, .75)) - x(q(p, .25)))}" height="12" rx="2" fill="${COL.panel}"/>`;
    if (n != null) s += `<rect x="${L}" y="${y + 4}" width="${x(n) - L}" height="6" rx="3" fill="${COL.green}"/>`;
    if (p) s += `<line x1="${x(avg(p))}" x2="${x(avg(p))}" y1="${y}" y2="${y + 14}" stroke="${COL.gold}" stroke-width="1.5"/>`;
    const delta = n != null && p ? Math.round(n - avg(p)) : null;
    s += txt(W - R + 8, y + 10, n != null ? `<tspan font-weight="700">${Math.round(n)} yd</tspan>` : 'Not used', `font-size="10.5" fill="${n != null ? COL.ink : COL.faint}"`);
    if (delta != null) s += txt(W, y + 10, (delta > 0 ? '+' : '') + delta, `font-size="10" fill="${COL.muted}" text-anchor="end"`);
  });
  s += '</svg>';
  return `<section class="card w5">
    ${section(2, '', 'Your clubs, in yards', '<span class="tag">Full swings</span>')}
    <div class="legend" style="justify-content:flex-start;margin:-6px 0 8px"><span><i class="sq" style="background:${COL.green};height:5px"></i>This round</span><span><i class="sq" style="background:${COL.gold};width:2px"></i>Previous 10 avg</span><span><i class="sq" style="background:${COL.panel}"></i>Previous typical range</span></div>
    ${s}
    <p class="note">Average carry + roll of tee shots, approaches and lay-ups. The range is the middle half of the last 10 rounds.</p>
  </section>`;
}

function sgHtml(a) {
  const prev = previous(a.round).map(analyze).filter(x => x.ch != null);
  const prevAvg = prev.length ? avg(prev.map(x => x.vsHcp)) : null;
  const max = Math.max(4, ...CATS.map(c => Math.abs(a.cats[c.key]))) ;
  const lim = Math.ceil(max / 2) * 2;
  const W = 440, L = 80, R = 40, rowH = 30, H = CATS.length * rowH + 30;
  const x = v => L + (W - L - R) * (v + lim) / (2 * lim);
  let s = svgOpen(W, H);
  s += txt(0, 10, '◂ Lost strokes', `font-size="10" font-weight="600" fill="${COL.red}"`) + txt(W, 10, 'Gained strokes ▸', `font-size="10" font-weight="600" fill="${COL.green}" text-anchor="end"`);
  for (let t = -lim; t <= lim; t += 2) {
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="20" y2="${H - 16}" stroke="${t === 0 ? COL.faint : COL.line}" ${t ? 'stroke-dasharray="2 3"' : ''}/>`;
    s += txt(x(t), H - 3, t > 0 ? `+${t}` : t, `font-size="9.5" fill="${COL.muted}" text-anchor="middle"`);
  }
  CATS.forEach((c, i) => {
    const v = a.cats[c.key], y = 24 + i * rowH;
    s += txt(0, y + 12, c.label, `font-size="11" fill="${COL.ink}"`);
    s += `<rect x="${L}" y="${y + 4}" width="${W - L - R}" height="10" rx="2" fill="#f1f0ea"/>`;
    s += `<rect x="${Math.min(x(0), x(v))}" y="${y + 4}" width="${Math.abs(x(v) - x(0))}" height="10" rx="2" fill="${v >= 0 ? COL.green : COL.red}" opacity=".85"/>`;
    s += txt(W, y + 13, sg1(v), `font-size="11" font-weight="700" fill="${v >= 0 ? COL.green : COL.red}" text-anchor="end"`);
  });
  s += '</svg>';
  const worst = [...CATS].sort((p, q) => a.cats[p.key] - a.cats[q.key])[0];
  const best = [...CATS].sort((p, q) => a.cats[q.key] - a.cats[p.key])[0];
  return `<section class="card w7">
    ${section(3, '', 'Strokes gained')}
    <p class="note" style="margin:-8px 0 10px">vs handicap · expected ${a.ch != null ? a.expected : '—'}</p>
    <div class="sg-layout">
      <div>${s}</div>
      <div class="sg-cards">
        <div class="sg-card ${a.vsHcp < 0 ? 'bad' : ''}"><b class="${signCls(a.vsHcp)}">${sg1(a.vsHcp)}</b><span class="lbl">strokes vs handicap</span><br><span>previous 10 avg ${prevAvg != null ? sg1(prevAvg) : '—'}</span></div>
        ${a.cats[worst.key] < 0 ? `<div class="sg-card bad"><b class="neg">${sg1(a.cats[worst.key])}</b><span class="lbl neg">${worst.label}</span><br>strokes lost</div>` : ''}
        ${a.cats[best.key] > 0 ? `<div class="sg-card"><span class="lbl">⚑ ${best.label}</span><br>${best.label} led your round at ${sg1(a.cats[best.key])}.</div>` : ''}
      </div>
    </div>
  </section>`;
}

function shapeHtml(a) {
  const hs = a.holes;
  let cp = 0, ch = 0;
  const vsPar = [0], vsH = [0];
  hs.forEach(h => { cp += h.score - h.par; ch += h.score - h.par - h.strokes; vsPar.push(cp); vsH.push(ch); });
  const lo = Math.min(...vsPar, ...vsH), hi = Math.max(...vsPar, ...vsH);
  const W = 460, H = 220, L = 30, T = 10, B = 26;
  const x = i => L + (W - L - 10) * i / hs.length;
  const y = v => T + (H - T - B) * (v - lo) / Math.max(1, hi - lo);
  let s = svgOpen(W, H);
  [lo, 0, hi].filter((v, i, arr) => arr.indexOf(v) === i).forEach(v => {
    s += `<line x1="${L}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? COL.faint : COL.line}" stroke-dasharray="${v === 0 ? '3 3' : ''}"/>`;
    s += txt(L - 6, y(v) + 3, v === 0 ? 'E' : toPar(v), `font-size="9.5" fill="${COL.muted}" text-anchor="end"`);
  });
  hs.forEach((h, i) => { s += txt(x(i + 1), H - 8, h.hole, `font-size="9" fill="${COL.muted}" text-anchor="middle"`); });
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  s += `<path d="${path(vsPar)}" fill="none" stroke="${COL.faint}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  s += `<path d="${path(vsH)}" fill="none" stroke="${COL.greenD}" stroke-width="2.2"/>`;
  hs.forEach((h, i) => {
    s += `<circle cx="${x(i + 1)}" cy="${y(vsPar[i + 1])}" r="2.6" fill="${COL.faint}"/>`;
    s += `<circle cx="${x(i + 1)}" cy="${y(vsH[i + 1])}" r="3.6" fill="${resultColor(h.score - h.par)}" stroke="#fff" stroke-width="1"/>`;
  });
  s += '</svg>';
  const out = a.nine('out'), inn = a.nine('in');
  return `<section class="card">
    ${section(4, 'Scoring timeline', 'The shape of your round')}
    <p class="note" style="margin:-8px 0 8px">Cumulative score · lower is better · dot colours show each hole's result</p>
    <div class="legend" style="justify-content:flex-start;margin:0 0 6px"><span><i class="sq" style="background:${COL.greenD};height:2px;width:14px"></i>Vs handicap <b>${toPar(vsH.at(-1))}</b></span><span style="color:${COL.faint}"><i class="dash"></i>Vs par <b>${toPar(vsPar.at(-1))}</b></span></div>
    ${s}
    <div class="strip" style="margin:10px 0 0;background:none;padding:0">
      ${out.holes.length ? `<div><span>Out</span> <b>${out.score}</b><small>${toPar(out.score - out.par)}</small></div>` : ''}
      ${inn.holes.length ? `<div><span>In</span> <b>${inn.score}</b><small>${toPar(inn.score - inn.par)}</small></div>` : ''}
      <div><span>Finish</span> <b>${toPar(a.score - a.par)}</b><small>to par</small></div>
    </div>
  </section>`;
}

function puttingHtml(a) {
  const hs = a.holes.filter(h => h.putts != null);
  if (!hs.length) return '';
  const total = sum(hs.map(h => h.putts));
  const sg = a.cats.putting;
  const gir = hs.filter(h => h.gir);
  const ppg = gir.length ? sum(gir.map(h => h.putts)) / gir.length : null;
  const c = k => hs.filter(h => k === 3 ? h.putts >= 3 : h.putts === k).length;
  const prev = previous(a.round).flatMap(r => (holesBy[r.activity_id] || []).filter(h => h.putts != null));
  const prevPerRound = prev.length ? sum(prev.map(h => h.putts)) / prev.length * a.n : null;
  const one = c(1), three = c(3);
  return `<section class="card w5">
    ${section(5, 'Putting', 'On the greens')}
    <div class="stat-row" style="margin-bottom:14px">
      <div><b>${total}</b><span>putts</span><small>${hs.length < a.n ? `${hs.length} holes recorded` : ''}</small></div>
      <div><b class="${signCls(sg)}">${sg1(sg)}</b><span>strokes gained</span><small>vs handicap</small></div>
      <div><b>${ppg != null ? ppg.toFixed(2) : '—'}</b><span>putts per GIR</span><small>${plural(gir.length, 'green')}</small></div>
      <div><b>${prevPerRound != null ? prevPerRound.toFixed(1) : '—'}</b><span>previous 10</span><small>avg putts per round</small></div>
    </div>
    <div class="strip">
      <div><b>${c(0)}</b><span>0 putts</span></div><div><b>${one}</b><span>1 putt</span></div>
      <div><b>${c(2)}</b><span>2 putts</span></div><div><b class="${three ? 'neg' : ''}">${three}</b><span>3+ putts</span></div>
    </div>
    <p class="note">${plural(one, 'one-putt hole')}${three ? ` and ${three} with three or more` : ', no three-putts'}. Putting strokes gained assumes a typical first-putt length for where each green was reached from.</p>
  </section>`;
}

function teeHtml(a) {
  const shots = teeShots(a);
  if (!shots.length) return '';
  const t = teeRates(a);
  // Fairway illustration
  const W = 200, H = 330, cx = 110, half = 26;
  const ds = shots.map(x => x.dist).filter(Boolean);
  const maxD = Math.max(250, Math.ceil((Math.max(...ds, 0) + 20) / 50) * 50);
  const minD = Math.max(0, Math.floor((Math.min(...ds, maxD) - 30) / 50) * 50);
  const y = d => H - 10 - (H - 20) * (d - minD) / (maxD - minD);
  let s = svgOpen(W, H, 'style="max-width:220px;margin:0 auto"');
  s += `<defs><linearGradient id="rough" x1="0" x2="1"><stop offset="0" stop-color="#cfdcc4"/><stop offset=".5" stop-color="#dfe8d4"/><stop offset="1" stop-color="#cfdcc4"/></linearGradient></defs>`;
  s += `<rect x="40" y="0" width="${W - 40}" height="${H}" rx="8" fill="url(#rough)"/>`;
  const edge = off => Array.from({ length: 11 }, (_, i) => [cx + off + Math.sin(i * 0.9) * 5, H * i / 10]);
  const wig = off => edge(off).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1]}`).join('');
  s += `<path d="${wig(-half)}${edge(half).reverse().map(p => `L${p[0].toFixed(1)},${p[1]}`).join('')}Z" fill="#a9c79a"/>`;
  s += `<path d="${wig(-half)}" fill="none" stroke="#8fb283" stroke-width="2"/><path d="${wig(half)}" fill="none" stroke="#8fb283" stroke-width="2"/>`;
  for (let d = minD; d <= maxD; d += 50) {
    if (d === minD) continue;
    s += `<path d="M42,${y(d)} Q${cx},${y(d) - 8} ${W - 2},${y(d)}" fill="none" stroke="#6e8b66" stroke-dasharray="3 4" opacity=".5"/>`;
    s += txt(36, y(d) + 3, `${d} yd`, `font-size="9" fill="${COL.muted}" text-anchor="end"`);
  }
  shots.filter(x => x.dist).forEach((x, i) => {
    let lx;
    if (x.dir === 'hit') lx = Math.max(-half + 6, Math.min(half - 6, x.lateral * 0.8));
    else lx = (x.dir === 'left' ? -1 : 1) * (half + 8 + Math.min(40, Math.abs(x.lateral) * 0.6));
    if (!isFinite(lx)) lx = ((i * 7) % 20) - 10;
    lx = Math.max(-(cx - 46), Math.min(W - cx - 6, lx));
    const col = x.dir === 'hit' ? COL.greenD : x.dir === 'left' ? COL.red : COL.yellow;
    s += `<circle cx="${cx + lx}" cy="${y(x.dist)}" r="5" fill="${col}" stroke="#fff" stroke-width="1.2"><title>Hole ${x.hole}: ${x.dist} yd</title></circle>`;
  });
  s += '</svg>';

  // Trend: this round + previous 10
  const series = [...previous(a.round)].reverse().concat([a.round]).map(r => ({ r, t: teeRates(analyze(r)) })).filter(x => x.t.n);
  const TW = 300, TH = 210, TL = 26, TB = 30, TT = 18;
  const bw = (TW - TL) / series.length;
  let tr = svgOpen(TW, TH);
  [0, 50, 100].forEach(p => {
    const yy = TT + (TH - TT - TB) * (1 - p / 100);
    tr += txt(TL - 4, yy + 3, p + '%', `font-size="9" fill="${COL.muted}" text-anchor="end"`);
  });
  series.forEach((x, i) => {
    const bx = TL + i * bw + 2, w = bw - 4, hh = TH - TT - TB;
    const parts = [[x.t.hit, '#6a9a7d'], [x.t.left, '#d58b80'], [x.t.right, '#e6cd8b']];
    let yy = TT + hh;
    parts.forEach(([n, c]) => { const h = hh * n / x.t.n; yy -= h; tr += `<rect x="${bx}" y="${yy}" width="${w}" height="${h}" fill="${c}"/>`; });
    tr += txt(bx + w / 2, TT + hh - 4, pct(x.t.hit, x.t.n), `font-size="8.5" fill="#fff" font-weight="700" text-anchor="middle"`);
    tr += txt(bx + w / 2, TT - 6, x.r.totals.score, `font-size="9" font-weight="700" fill="${COL.ink}" text-anchor="middle"`);
    if (x.r === a.round) tr += `<rect x="${bx - 1.5}" y="${TT - 1.5}" width="${w + 3}" height="${hh + 3}" rx="2" fill="none" stroke="${COL.ink}" stroke-width="1.5"/>`;
  });
  tr += txt(TW - bw / 2, TH - 12, 'This round', `font-size="9" fill="${COL.muted}" text-anchor="end"`) + txt(TL, TH - 12, `−${series.length - 1}`, `font-size="9" fill="${COL.muted}"`);
  tr += '</svg>';
  const prevT = series.slice(0, -1);
  const prevRate = prevT.length ? pct(sum(prevT.map(x => x.t.hit)), sum(prevT.map(x => x.t.n))) : null;
  const rate = pct(t.hit, t.n);
  return `<section class="card">
    ${section(6, 'Off the tee', 'Find your starting line', `<span class="sec-aside">${t.n} par 4 &amp; 5 tee shots</span>`)}
    <div class="strip">
      <div><b class="neg">${pct(t.left, t.n)}%</b><span>Left</span></div>
      <div class="big"><b>${rate}%</b><span>Fairway</span></div>
      <div><b style="color:#b8953a">${pct(t.right, t.n)}%</b><span>Right</span></div>
    </div>
    <div class="split">
      <div>${s}<div class="legend" style="gap:18px"><span><b>${t.left}</b> left</span><span><b>${t.hit}</b> fairway</span><span><b>${t.right}</b> right</span></div></div>
      <div>
        <h3 class="sub-title">Your tee-shot trend</h3>
        ${tr}
        <div class="legend"><span><i style="background:#6a9a7d"></i>Fairway</span><span><i style="background:#d58b80"></i>Left</span><span><i style="background:#e6cd8b"></i>Right</span></div>
        <div class="strip" style="margin:12px 0 0">
          <div><b>${prevRate ?? '—'}%</b><span>previous 10 avg</span></div>
          <div><b class="${rate >= (prevRate ?? 0) ? 'pos' : 'neg'}">${prevRate != null ? (rate - prevRate > 0 ? '+' : '') + (rate - prevRate) + ' pts' : '—'}</b><span>vs average</span></div>
        </div>
      </div>
    </div>
    <p class="note">Dots sit at each drive's distance; side-to-side placement is illustrative.</p>
  </section>`;
}

function approachHtml(a) {
  const apps = approaches(a);
  if (!apps.length) return '';
  const on = apps.filter(x => x.onGreen).length;
  const rate = pct(on, apps.length);
  const cnt = k => apps.filter(x => x.miss === k).length;
  const misses = ['short', 'long', 'left', 'right'].map(k => [k, cnt(k)]).sort((p, q) => q[1] - p[1]);
  const W = 340, H = 300, cx = 170, cy = 150, G = 70;
  let s = svgOpen(W, H, 'style="max-width:380px;margin:0 auto"');
  s += `<defs><radialGradient id="apron"><stop offset=".55" stop-color="#cfe0c2"/><stop offset="1" stop-color="#cfe0c2" stop-opacity="0"/></radialGradient>
    <radialGradient id="green"><stop offset="0" stop-color="#b9d39e"/><stop offset="1" stop-color="#93b97c"/></radialGradient></defs>`;
  s += `<ellipse cx="${cx}" cy="${cy}" rx="${G * 2}" ry="${G * 1.8}" fill="url(#apron)"/>`;
  s += `<path d="M${cx - G},${cy - 10} C${cx - G},${cy - G - 10} ${cx - 10},${cy - G - 6} ${cx + 4},${cy - G + 14} C${cx + 20},${cy - G - 8} ${cx + G + 10},${cy - G + 4} ${cx + G},${cy + 6} C${cx + G},${cy + G} ${cx + 10},${cy + G + 4} ${cx - 16},${cy + G - 6} C${cx - G - 6},${cy + G - 12} ${cx - G},${cy + 20} ${cx - G},${cy - 10}Z" fill="url(#green)" stroke="#5f8f5a" stroke-width="3" stroke-opacity=".55"/>`;
  s += `<ellipse cx="${cx + G - 6}" cy="${cy + G - 4}" rx="26" ry="15" fill="#efe6d1" stroke="#d9cdb2" transform="rotate(-25 ${cx + G - 6} ${cy + G - 4})"/>`;
  s += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 26}" stroke="${COL.ink}" stroke-width="1.2"/><path d="M${cx},${cy - 26} l12,4 l-12,4z" fill="${COL.red}"/>`;
  // Dots: frame is the shot's line — long is up, right is right.
  const scale = G / 12;   // ~12 yd from centre to the green's edge
  apps.forEach((p, i) => {
    let dx, dy;
    if (p.onGreen) { const ang = i * 2.4; const rr = 10 + (i * 13) % (G - 24); dx = Math.cos(ang) * rr; dy = Math.sin(ang) * rr * 0.85; }
    else {
      const d = Math.hypot(p.long, p.right) || 1;
      const rr = Math.min(G * 1.9, G + 6 + (d - 12) * scale * 0.5);
      dx = p.right / d * Math.max(rr, G + 8); dy = -p.long / d * Math.max(rr, G + 8);
    }
    const px = Math.max(8, Math.min(W - 8, cx + dx)), py = Math.max(8, Math.min(H - 8, cy + dy));
    s += `<circle cx="${px}" cy="${py}" r="${p.onGreen ? 4.5 : 4}" fill="${p.onGreen ? COL.ink : COL.red}" stroke="#fff" stroke-width="1"><title>Hole ${p.hole}${p.club ? ' · ' + p.club : ''} from ${Math.round(p.fromYd)} yd</title></circle>`;
  });
  const lab = (k, x0, y0, anchor) => txt(x0, y0, `${k.toUpperCase()} <tspan class="serif" font-size="17" fill="${COL.red}" font-weight="600">${cnt(k)}</tspan>`, `font-size="9.5" font-weight="700" letter-spacing="1.2" fill="${COL.ink}" text-anchor="${anchor}"`);
  s += lab('long', cx + 70, 18, 'start') + lab('short', cx - 70, H - 8, 'end') + lab('left', 8, cy - 30, 'start') + lab('right', W - 8, cy - 30, 'end');
  s += '</svg>';

  // Trend line
  const series = [...previous(a.round)].reverse().concat([a.round]).map(r => {
    const ap = approaches(analyze(r));
    return ap.length ? pct(ap.filter(x => x.onGreen).length, ap.length) : null;
  });
  const prevVals = series.slice(0, -1).filter(v => v != null);
  const prevAvg = prevVals.length ? Math.round(avg(prevVals)) : null;
  const TW = 400, TH = 130, TL = 34, TR = 40, TT = 10, TB = 22;
  const tx = i => TL + (TW - TL - TR) * i / Math.max(1, series.length - 1);
  const ty = v => TT + (TH - TT - TB) * (1 - v / 100);
  let t = svgOpen(TW, TH);
  [0, 50, 100].forEach(v => { t += `<line x1="${TL}" x2="${TW - TR}" y1="${ty(v)}" y2="${ty(v)}" stroke="${COL.line}"/>` + txt(TL - 6, ty(v) + 3, v + '%', `font-size="9" fill="${COL.muted}" text-anchor="end"`); });
  if (prevAvg != null) t += `<line x1="${TL}" x2="${TW - TR}" y1="${ty(prevAvg)}" y2="${ty(prevAvg)}" stroke="${COL.greenD}" stroke-dasharray="4 3" opacity=".6"/>`;
  const pts = series.map((v, i) => v == null ? null : [tx(i), ty(v)]).filter(Boolean);
  t += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('')}" fill="none" stroke="${COL.greenD}" stroke-width="2"/>`;
  pts.forEach((p, i) => { t += `<circle cx="${p[0]}" cy="${p[1]}" r="${i === pts.length - 1 ? 6 : 3}" fill="${COL.greenD}"/>`; });
  t += txt(TW - TR + 10, ty(rate) + 4, `${rate}%`, `font-size="12" font-weight="700" fill="${COL.greenD}"`);
  t += txt(TL, TH - 4, `−${series.length - 1}`, `font-size="9" fill="${COL.muted}"`) + txt(TW - TR, TH - 4, 'This round', `font-size="9" fill="${COL.muted}" text-anchor="end"`);
  t += '</svg>';
  const diff = prevAvg != null ? rate - prevAvg : null;
  return `<section class="card w5">
    ${section(7, 'Approaches', 'Finding the green', '<span class="tag">Illustrative green</span>')}
    <div class="strip">
      <div class="lead"><b>${rate}%</b><small>${on} of ${apps.length}</small><span>On the green</span></div>
      <div><b>${prevAvg ?? '—'}%</b><span>previous 10</span></div>
      <div><b class="${signCls(diff ?? 0)}">${diff != null ? (diff > 0 ? '+' : '') + diff : '—'}</b><span>pts vs average</span></div>
    </div>
    ${s}
    <p class="note" style="text-align:right">${misses[0][1] ? `Most common miss: ${misses[0][0]}` : 'No missed greens'}</p>
    <h3 class="sub-title">Your approach trend</h3>
    ${t}
    <p class="note">One approach per hole: the last shot from beyond ${SHORT_GAME_YD} yd. Misses are placed by direction relative to where the hole finished.</p>
  </section>`;
}

function roundStatsHtml(a) {
  const gir = a.holes.filter(h => h.gir != null);
  const girN = gir.filter(h => h.gir).length;
  const fw = a.holes.filter(h => h.par >= 4 && h.raw.fairway_hit != null);
  const fwN = fw.filter(h => h.raw.fairway_hit).length;
  const three = a.holes.filter(h => (h.putts ?? 0) >= 3);
  const pens = a.holes.filter(h => h.pen > 0);
  const potentialGap = sum(a.holes.map(h => h.pen)) + sum(a.holes.map(h => Math.max(0, (h.putts ?? 0) - 2)));
  const list = hs => hs.length ? 'Hole ' + hs.map(h => h.hole).join(', ') : 'None';
  return `<section class="card">
    ${section(8, '', 'Round stats')}
    <div class="stat-row">
      <div><b>${pct(girN, gir.length) ?? '—'}%</b><span>Greens in regulation</span><small>${girN} of ${gir.length} holes</small></div>
      <div><b>${pct(fwN, fw.length) ?? '—'}%</b><span>Fairways hit</span><small>${fwN} of ${fw.length} · par 4–5</small></div>
      <div><b>${three.length}</b><span>Three-putts</span><small>${list(three)}</small></div>
      <div><b>${sum(pens.map(h => h.pen))}</b><span>Penalty strokes</span><small>${list(pens)}</small></div>
    </div>
    <p class="note" style="border-top:1px solid var(--line);padding-top:8px;margin-top:14px"><b style="color:var(--ink)">${plural(potentialGap, 'stroke')} to recover.</b> Potential is a what-if score: remove penalties and putts beyond two per hole.</p>
  </section>`;
}

function turnHtml(a) {
  const out = a.nine('out'), inn = a.nine('in');
  if (!out.holes.length || !inn.holes.length) return '';
  const lim = Math.max(3, Math.ceil(Math.max(...CATS.flatMap(c => [Math.abs(out[c.key]), Math.abs(inn[c.key])]))));
  const W = 400, L = 90, R = 20, rowH = 34, H = CATS.length * rowH + 30;
  const x = v => L + (W - L - R) * (v + lim) / (2 * lim);
  let s = svgOpen(W, H);
  for (let t = -lim; t <= lim; t++) {
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="6" y2="${H - 22}" stroke="${t === 0 ? COL.faint : COL.line}"/>`;
    s += txt(x(t), H - 8, t > 0 ? `+${t}` : t, `font-size="9" fill="${COL.muted}" text-anchor="middle"`);
  }
  s += txt(L - 8, H - 8, 'Worse', `font-size="9.5" fill="${COL.red}" text-anchor="end"`) + txt(W, H - 8, 'Better', `font-size="9.5" fill="${COL.green}" text-anchor="end" dx="14"`);
  CATS.forEach((c, i) => {
    const y = 18 + i * rowH, o = out[c.key], n = inn[c.key];
    const better = n >= o;
    s += txt(0, y + 4, c.label, `font-size="11" fill="${COL.ink}"`);
    s += `<line x1="${x(o)}" x2="${x(n)}" y1="${y}" y2="${y}" stroke="${better ? COL.green : COL.red}" stroke-width="2.5"/>`;
    s += `<circle cx="${x(o)}" cy="${y}" r="5.5" fill="#fff" stroke="${o >= 0 ? COL.greenD : COL.red}" stroke-width="2"/>`;
    s += `<circle cx="${x(n)}" cy="${y}" r="5.5" fill="${n >= 0 ? COL.greenD : COL.red}"/>`;
    const lo = Math.min(o, n), hi = Math.max(o, n);
    s += txt(x(lo) - 9, y + 4, sg1(lo), `font-size="10" font-weight="700" fill="${lo >= 0 ? COL.green : COL.red}" text-anchor="end"`);
    s += txt(x(hi) + 9, y + 4, sg1(hi), `font-size="10" font-weight="700" fill="${hi >= 0 ? COL.green : COL.red}"`);
  });
  s += '</svg>';
  const delta = inn.total - out.total;
  const level = Math.abs(delta) < 0.5;
  const moved = [...CATS].sort((p, q) => Math.abs(inn[q.key] - out[q.key]) - Math.abs(inn[p.key] - out[p.key]))[0];
  const mv = inn[moved.key] - out[moved.key];
  const line = `${moved.label} ${mv > 0 ? 'came alive after the turn' : 'slipped after the turn'}.`;
  return `<section class="card">
    ${section(9, 'At the turn', level ? 'Level at the turn' : delta > 0 ? 'The back nine was better' : 'The turn cost you', '<span class="sec-aside" style="letter-spacing:.14em;text-transform:uppercase;font-size:9.5px">Strokes gained<br>vs handicap</span>')}
    ${s}
    <div class="legend"><span><i style="background:#fff;border:2px solid ${COL.greenD};width:8px;height:8px"></i>Out (front nine)</span><span><i style="background:${COL.greenD}"></i>In (back nine)</span></div>
    <div class="callout">
      <div class="big"><small>OUT</small> ${sg1(out.total)} → <small>IN</small> ${sg1(inn.total)} ${level ? '' : `<span class="${signCls(delta)}">${f1(Math.abs(delta))} ${delta > 0 ? 'better' : 'worse'}</span>`}</div>
      <div class="txt">${line}</div>
    </div>
  </section>`;
}

function mixHtml(a) {
  const counts = RESULT.map(r => ({ ...r, n: a.holes.filter(h => r.test(h.score - h.par)).length }));
  const bar = counts.filter(c => c.n).map(c => `<div style="flex:${c.n};background:${c.color};color:${c.key === 'double' ? '#fff' : COL.ink}">${c.n}</div>`).join('');
  const chips = hs => `<div class="chips">${hs.map(h => { const d = h.score - h.par; return `<div>${h.hole}<b style="background:${resultColor(d)};${d >= 2 || d === -1 ? 'color:#fff' : ''}">${toPar(d)}</b></div>`; }).join('')}</div>`;
  const out = a.holes.filter(h => h.hole <= 9), inn = a.holes.filter(h => h.hole > 9);
  const pt = p => { const hs = a.holes.filter(h => h.par === p); return hs.length ? `<div>Par ${p}s <b>${toPar(sum(hs.map(h => h.score - h.par)))}</b><small>${plural(hs.length, 'hole')} · to par</small></div>` : ''; };
  const birdie = a.holes.find(h => h.score - h.par <= -1);
  const pars = counts.find(c => c.key === 'par').n;
  const quote = birdie ? `A ${birdie.score - birdie.par <= -2 ? 'eagle' : 'birdie'} at the ${ordinal(birdie.hole)}. ${words(pars)} ${pars === 1 ? 'par' : 'pars'} along the way.`
    : `${words(pars)} ${pars === 1 ? 'par' : 'pars'} along the way.`;
  return `<section class="card">
    ${section(10, 'Scoring mix', `How your ${a.score} came together`)}
    <div class="mix-bar">${bar}</div>
    <div class="mix-keys">${counts.map(c => `<div><i style="background:${c.color}"></i><b>${c.n}</b><span>${c.label}</span></div>`).join('')}</div>
    <div class="mix-nines">
      ${out.length ? `<div><div class="lbl">OUT <span>(1–9)</span></div>${chips(out)}</div>` : ''}
      ${inn.length ? `<div><div class="lbl">IN <span>(10–18)</span></div>${chips(inn)}</div>` : ''}
    </div>
    <div class="par-types">${pt(3)}${pt(4)}${pt(5)}</div>
    <div class="quote">${quote}</div>
  </section>`;
}
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function sgGridHtml(a) {
  const grid = (hs, label) => {
    const totals = c => sum(hs.map(h => h.cats[c]));
    const row = (name, vals, tot, cls = '') => `<tr class="${cls}"><td>${name}</td>${vals.join('')}<td class="tot" style="background:${sgFill(tot)}">${sg1(tot)}</td></tr>`;
    return `<div class="sg-grid-wrap"><table class="sg-grid">
      <tr><th>Hole</th>${hs.map(h => `<th>${h.hole}</th>`).join('')}<th>${label}</th></tr>
      ${CATS.map(c => row(c.short, hs.map(h => h.par < 4 && c.key === 'off_tee' && Math.abs(h.cats[c.key]) < 0.01 ? '<td style="color:var(--faint)">–</td>' : `<td style="background:${sgFill(h.cats[c.key])}">${sg1(h.cats[c.key])}</td>`), totals(c.key))).join('')}
      <tr class="sep"><td>EXPECTED</td>${hs.map(h => `<td>${h.par + h.strokes}</td>`).join('')}<td class="tot">${sum(hs.map(h => h.par + h.strokes))}</td></tr>
      <tr><td>SCORE</td>${hs.map(h => `<td style="font-weight:600">${h.score}</td>`).join('')}<td class="tot">${sum(hs.map(h => h.score))}</td></tr>
      ${row('NET', hs.map(h => `<td class="${h.partial ? 'partial' : ''}" style="background:${sgFill(h.total)};font-weight:700">${sg1(h.total)}</td>`), sum(hs.map(h => h.total)))}
    </table></div>`;
  };
  const out = a.holes.filter(h => h.hole <= 9), inn = a.holes.filter(h => h.hole > 9);
  return `<section class="card wide">
    ${section(11, '', 'Strokes gained · every hole', `<div class="legend" style="margin:0;align-items:center"><span><i class="sq" style="background:rgba(214,110,96,.5)"></i>Lost</span><span><i class="sq" style="background:#efeee8"></i>Neutral</span><span><i class="sq" style="background:rgba(95,160,115,.5)"></i>Gained</span><span style="font:600 12px var(--sans);color:var(--ink);letter-spacing:.1em">TOTAL <b class="serif ${signCls(a.vsHcp)}" style="font-size:22px">${sg1(a.vsHcp)}</b></span></div>`)}
    <div class="sg-grids">${out.length ? grid(out, 'OUT') : ''}${inn.length ? grid(inn, 'IN') : ''}</div>
    ${a.partialHoles ? `<p class="note"><span style="color:var(--gold)">•</span> ${plural(a.partialHoles, 'hole')} had shots the sensors missed; the unexplained strokes are counted as short game.</p>` : ''}
  </section>`;
}

function holeMap(h) {
  if (!h.shots.length) return '';
  const W = 170, H = 280;
  // Rotate so the tee is at the bottom and the finish straight up.
  const t = h.shots[0].a;
  const ang = Math.atan2(-t[0], -t[1]);
  const rot = ([x, y]) => [x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang)];
  const pts = h.shots.map(x => rot(x.a)).concat([[0, 0]]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const spanY = Math.max(...ys) - Math.min(...ys) || 1, spanX = Math.max(...xs) - Math.min(...xs);
  const k = Math.min((H - 50) / spanY, (W - 60) / Math.max(spanX, 30));
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const P = ([x, y]) => [W / 2 + (x - midX) * k, H - 22 - (y - Math.min(...ys)) * k];
  const sp = pts.map(P);
  let s = svgOpen(W, H, `style="max-width:${W}px"`);
  const line = sp.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const fw = Math.max(16, 30 * k);
  s += `<path d="${line}" fill="none" stroke="#dfe7cf" stroke-width="${fw * 2.2}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (h.par >= 4 && sp.length > 2) s += `<path d="${sp.slice(1).map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('')}" fill="none" stroke="#b7d09a" stroke-width="${fw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const [gx, gy] = sp.at(-1);
  s += `<circle cx="${gx}" cy="${gy}" r="${Math.max(12, 14 * k)}" fill="#9fc387" stroke="#86ad73" stroke-width="2"/>`;
  s += `<rect x="${sp[0][0] - 8}" y="${sp[0][1] - 5}" width="16" height="10" rx="3" fill="#b7d09a"/>`;
  s += `<line x1="${gx}" y1="${gy}" x2="${gx}" y2="${gy - 18}" stroke="${COL.ink}"/><path d="M${gx},${gy - 18} l9,3 l-9,3z" fill="${COL.red}"/>`;
  s += `<path d="${line}" fill="none" stroke="${COL.greenD}" stroke-width="1.3"/>`;
  h.shots.forEach((x, i) => {
    const [px, py] = sp[i];
    if (x.club && x.dist && x.startYd > SHORT_GAME_YD) {
      const [nx, ny] = sp[i + 1];
      const mx = (px + nx) / 2, my = (py + ny) / 2;
      const label = `${clubShort(x.club)} · ${Math.round(x.dist)} yd`;
      const lw = label.length * 5.4 + 12;
      const lx = Math.max(2, Math.min(W - lw - 2, mx + 6));
      s += `<rect x="${lx}" y="${my - 9}" width="${lw}" height="17" rx="8.5" fill="#fffdf7" stroke="#d8cfb8"/>` + txt(lx + lw / 2, my + 3, label, `font-size="9.5" font-weight="600" fill="${COL.ink}" text-anchor="middle"`);
    }
    s += `<circle cx="${px}" cy="${py}" r="7" fill="#fff" stroke="${COL.greenD}" stroke-width="1.2"/>` + txt(px, py + 3, i + 1, `font-size="8.5" font-weight="700" fill="${COL.ink}" text-anchor="middle"`);
  });
  s += '</svg>';
  return s;
}
function holeStory(h) {
  const d = h.score - h.par;
  if (d < 0 && h.putts === 1) return `One putt to finish with a ${d <= -2 ? 'eagle' : 'birdie'}.`;
  if (d < 0 && h.putts === 0) return 'Holed from off the green.';
  if (d < 0) return `${h.putts ?? '—'} putts for a ${d <= -2 ? 'eagle' : 'birdie'}.`;
  if (h.pen) return `${plural(h.pen, 'penalty stroke')} on the way to ${d === 2 ? 'a double bogey' : d === 1 ? 'a bogey' : toPar(d) + ' to par'}.`;
  if ((h.putts ?? 0) >= 3) return `${h.putts} putts on the green cost this one.`;
  const worst = [...CATS].sort((p, q) => h.cats[p.key] - h.cats[q.key])[0];
  if (h.total < 0) return `${worst.label} cost ${f1(Math.abs(h.cats[worst.key]))} strokes here.`;
  const best = [...CATS].sort((p, q) => h.cats[q.key] - h.cats[p.key])[0];
  return `${best.label} gained ${f1(h.cats[best.key])} strokes.`;
}
function memorableHtml(a) {
  const withShots = a.holes.filter(h => h.shots.length >= 1);
  if (withShots.length < 3) return '';
  const byTotal = [...withShots].sort((p, q) => q.total - p.total);
  const good = byTotal.filter(h => h.total > 0).slice(0, 3);
  const bad = byTotal.filter(h => h.total < 0).reverse().slice(0, 5 - good.length).reverse();
  const pick = [...good, ...bad.reverse()].sort((p, q) => p.hole - q.hole);
  const name = d => ({ '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey' }[d] ?? `${toPar(d)} to par`);
  const cards = pick.map(h => `<div class="hole-card ${h.total < 0 ? 'bad' : ''}">
      <span class="ghost">${h.hole}</span>
      <h4>Hole ${h.hole}</h4>
      <div class="meta">Par ${h.par}${h.yardage ? ` · ${h.yardage} yd` : ''}</div>
      ${holeMap(h)}
      <div class="foot-row"><div><b>${h.score}</b><span>${name(h.score - h.par)}</span></div><div class="sg ${signCls(h.total)}">${sg1(h.total)}<small>SG</small></div></div>
      <p>${holeStory(h)}</p>
    </div>`).join('');
  return `<section class="card wide">
    ${section(12, '', 'The holes you’ll remember')}
    <div class="holes-row">${cards}</div>
    <p class="note">Shot paths drawn from GPS, turned so each hole plays up the page. Fairway and green shapes are illustrative.</p>
  </section>`;
}

function courseHtml(a) {
  const r = a.round;
  const past = rounds.filter(x => x.course === r.course && x.date <= r.date && isFull(x) === isFull(r)).slice(0, 10);
  if (past.length < 2) return '';
  const byHole = {};
  for (const p of past) for (const h of holesBy[p.activity_id] || []) if (h.score != null) (byHole[h.hole] ||= []).push(h.score - (h.par || 4));
  const holesN = Object.keys(byHole).map(Number).sort((p, q) => p - q);
  const avgDiff = hn => avg(byHole[hn]);
  const nine = hs => `<div class="heat-nine">${hs.map(hn => {
    const cells = [...byHole[hn]].sort((p, q) => p - q);
    const ad = avgDiff(hn);
    return `<div class="heat-col"><div class="hn" style="${ad >= 1.2 ? `color:${COL.red}` : ''}">${hn}</div>${cells.map(d => `<div class="cell" style="background:${resultColor(d)}"></div>`).join('')}<div class="av">${sg1(ad)}</div></div>`;
  }).join('')}</div>`;
  const nines = [holesN.filter(h => h <= 9), holesN.filter(h => h > 9)].filter(x => x.length);
  const sideAvg = hs => sum(hs.map(avgDiff));
  const scores = past.map(p => p.totals.score);
  const easiest = [...holesN].sort((p, q) => avgDiff(p) - avgDiff(q))[0];
  const hardest = [...holesN].sort((p, q) => avgDiff(q) - avgDiff(p))[0];
  return `<section class="card">
    ${section(13, 'Hole by hole', 'Where this course scores you', `<span class="sec-aside" style="letter-spacing:.12em;text-transform:uppercase;font-size:9.5px">Last ${past.length} ${isFull(r) ? 18 : 9}-hole<br>rounds here</span>`)}
    <div class="strip">
      ${nines[0] ? `<div><span>Out</span><b>${sg1(sideAvg(nines[0]))}</b><span style="text-transform:none;font-style:italic;font-weight:400">average</span></div>` : ''}
      <div class="big"><span>Round</span><b>${f1(avg(scores))}</b><span style="text-transform:none;font-style:italic;font-weight:400">average</span></div>
      ${nines[1] ? `<div><span>In</span><b>${sg1(sideAvg(nines[1]))}</b><span style="text-transform:none;font-style:italic;font-weight:400">average</span></div>` : ''}
    </div>
    <div class="heat" style="${nines.length === 1 ? 'grid-template-columns:1fr' : ''}">${nines.map(nine).join('')}</div>
    <div class="legend">${RESULT.map(x => `<span><i class="sq" style="background:${x.color}"></i>${x.label}</span>`).join('')}</div>
    <div class="quote">The ${ordinal(easiest)} gives strokes back. The ${ordinal(hardest)} takes them.</div>
  </section>`;
}

function recentHtml(a) {
  const r = a.round;
  const list = rounds.filter(x => x.course === r.course).slice(0, 4);
  if (list.length < 2) return '';
  const row = x => {
    const hs = (holesBy[x.activity_id] || []).filter(h => h.score != null).sort((p, q) => p.hole - q.hole);
    const par = sum(hs.map(h => h.par || 4));
    const nine = part => part.length ? `<div class="mini-card">${part.map(h => `<div style="background:${resultColor(h.score - (h.par || 4))}">${h.score}</div>`).join('')}${'<div style="background:none"></div>'.repeat(9 - part.length)}<div class="t">${sum(part.map(h => h.score))}</div></div>` : '';
    return `<a class="recent-row ${x === r ? 'current' : ''}" href="#${x.activity_id}">
      <div class="d"><b>${shortDate(x.date)}</b><small>${x.date.slice(0, 4)}</small><br><small>${fmtDuration(x.duration_seconds)}</small></div>
      <div class="s"><b>${x.totals.score}</b><small>${toPar(x.totals.score - par)} to par</small></div>
      <div style="display:flex;flex-direction:column;gap:3px">${nine(hs.filter(h => h.hole <= 9))}${nine(hs.filter(h => h.hole > 9))}</div>
    </a>`;
  };
  return `<section class="card">
    ${section(14, '', 'My recent rounds')}
    <p class="note" style="margin:-8px 0 10px">${esc(r.course)}</p>
    <div class="recent">${list.map(row).join('')}</div>
  </section>`;
}

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
function timeHtml(a) {
  const r = a.round;
  if (!r.duration_seconds) return '';
  const pace = x => x.duration_seconds / x.totals.holes_played / 60;
  const prev = previous(r).filter(x => x.duration_seconds);
  const prevPer = prev.length ? avg(prev.map(pace)) : null;
  const miles = r.distance_meters ? r.distance_meters / 1609.34 : null;
  const series = [...prev].reverse().concat([r]);
  const W = 400, H = 120, B = 18, T = 14, bw = W / series.length;
  const max = Math.max(...series.map(pace)) * 1.1;
  let s = svgOpen(W, H);
  series.forEach((x, i) => {
    const h = (H - B - T) * pace(x) / max, cur = x === r;
    s += `<rect x="${i * bw + 3}" y="${H - B - h}" width="${bw - 6}" height="${h}" rx="2" fill="${cur ? COL.greenD : COL.sageL}"/>`;
    s += txt(i * bw + bw / 2, H - B - h - 4, pace(x).toFixed(1), `font-size="9" fill="${cur ? COL.ink : COL.muted}" font-weight="${cur ? 700 : 400}" text-anchor="middle"`);
  });
  s += txt(0, H - 4, `−${series.length - 1}`, `font-size="9" fill="${COL.muted}"`) + txt(W, H - 4, 'This round', `font-size="9" fill="${COL.muted}" text-anchor="end"`);
  s += '</svg>';
  const diff = prevPer != null ? pace(r) - prevPer : null;
  return `<section class="card">
    ${section(15, 'Time & movement', 'A round well spent')}
    <div class="time">
      <div class="tot"><b>${fmtDuration(r.duration_seconds)}</b><span>Time in play</span></div>
      <div class="time-stats">
        <div><b>${pace(r).toFixed(1)}</b><span>min per hole</span></div>
        <div><b>${miles ? miles.toFixed(1) : '—'}</b><span>miles walked</span></div>
        <div><b>${(r.duration_seconds / 60 / a.score).toFixed(1)}</b><span>min per stroke</span></div>
      </div>
    </div>
    <h3 class="sub-title" style="margin-top:18px">Your pace, minutes per hole</h3>
    ${s}
    ${diff != null ? `<p class="note">${Math.abs(diff) < 0.3 ? 'Right on your usual pace' : `${f1(Math.abs(diff))} min per hole ${diff > 0 ? 'slower' : 'quicker'} than your previous 10 average`} (${prevPer.toFixed(1)}).</p>` : ''}
  </section>`;
}

function clubSG(a) {
  const by = {};
  for (const h of a.holes) {
    for (const x of h.shots) if (x.club && x.club !== 'Putter') { (by[x.club] ||= { v: 0, n: 0 }); by[x.club].v += x.sgH; by[x.club].n++; }
    if (h.puttSgH != null) { (by.Putter ||= { v: 0, n: 0 }); by.Putter.v += h.puttSgH; by.Putter.n += h.putts || 0; }
  }
  return by;
}
function clubSgHtml(a) {
  const now = clubSG(a);
  const prev = previous(a.round).map(r => clubSG(analyze(r)));
  const clubs = CLUB_ORDER.filter(c => now[c]);
  if (clubs.length < 3) return '';
  const histFor = c => prev.map(p => p[c]?.v ?? null);
  const all = clubs.flatMap(c => [now[c].v, ...histFor(c).slice(0, 5).filter(v => v != null)]);
  const lim = Math.max(2, ...all.map(Math.abs));
  const colW = 74, W = clubs.length * colW, H = 250, mid = 100, k = 80 / lim;
  let s = svgOpen(W, H, `style="min-width:${Math.max(560, W * 0.75)}px"`);
  s += `<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="${COL.faint}"/>`;
  clubs.forEach((c, i) => {
    const x0 = i * colW;
    if (i % 2 === 0) s += `<rect x="${x0}" y="0" width="${colW}" height="${H - 6}" fill="#f2f1ec"/>`;
    const hist5 = histFor(c).slice(0, 5).reverse();
    const bw = 7;
    hist5.forEach((v, j) => {
      if (v == null) return;
      const hgt = Math.abs(v) * k;
      s += `<rect x="${x0 + 6 + j * (bw + 2)}" y="${v >= 0 ? mid - hgt : mid}" width="${bw}" height="${hgt}" fill="${v >= 0 ? '#bcd8c2' : '#f0bdb5'}"/>`;
    });
    const h5 = hist5.filter(v => v != null), h10 = histFor(c).filter(v => v != null);
    const a5 = h5.length ? avg(h5) : null, a10 = h10.length ? avg(h10) : null;
    if (a5 != null) s += `<line x1="${x0 + 4}" x2="${x0 + 50}" y1="${mid - a5 * k}" y2="${mid - a5 * k}" stroke="${COL.ink}" stroke-width="1.6" stroke-dasharray="3 2"/>`;
    if (a10 != null) s += `<line x1="${x0 + 4}" x2="${x0 + 50}" y1="${mid - a10 * k + 3}" y2="${mid - a10 * k + 3}" stroke="${COL.red}" stroke-width="1.4" stroke-dasharray="3 2"/>`;
    const v = now[c].v, hgt = Math.abs(v) * k;
    s += `<rect x="${x0 + 52}" y="${v >= 0 ? mid - hgt : mid}" width="16" height="${Math.max(1, hgt)}" fill="${v >= 0 ? COL.green : COL.red}"/>`;
    s += txt(x0 + 60, v >= 0 ? mid - hgt - 5 : mid + hgt + 13, sg1(v), `font-size="12" font-weight="700" fill="${COL.ink}" text-anchor="middle"`);
    s += txt(x0 + 6, H - 52, `5: ${sg1(a5)}`, `font-size="9.5" fill="${COL.muted}"`) + txt(x0 + 6, H - 40, `10: ${sg1(a10)}`, `font-size="9.5" fill="${COL.red}"`);
    s += txt(x0 + colW - 6, H - 26, plural(now[c].n, c === 'Putter' ? 'putt' : 'shot'), `font-size="9" fill="${COL.muted}" text-anchor="end"`);
    s += txt(x0 + colW / 2, H - 8, clubShort(c), `font-size="12.5" font-weight="700" fill="${COL.ink}" text-anchor="middle"`);
  });
  s += '</svg>';
  return `<section class="card wide">
    ${section(16, 'Strokes gained', 'Club by club', '<span class="sec-aside" style="letter-spacing:.12em;text-transform:uppercase;font-size:9.5px">This round vs<br>last 10 rounds</span>')}
    <div class="legend" style="justify-content:flex-start;margin:-6px 0 8px"><span><i class="sq" style="background:${COL.green}"></i>This round</span><span><i class="sq" style="background:#bcd8c2"></i>Last 5 rounds, oldest first</span><span style="color:${COL.ink}"><i class="dash"></i>Last 5 average</span><span style="color:${COL.red}"><i class="dash"></i>Last 10 average</span></div>
    <div style="overflow-x:auto">${s}</div>
    <p class="note">Strokes gained added up over every shot hit with the club; a penalty counts against the club that caused it. Above the line gained strokes, below lost.</p>
  </section>`;
}

const FOCUS_TIPS = {
  off_tee: 'Pick a target line on every tee and commit — a fairway wood off the tee is fine when the driver is wandering.',
  approach: 'Take one more club into greens and aim for the middle; centre-of-green beats flag hunting.',
  short_game: 'Practise landing chips on one spot from a few different lies, and get every one inside a two-putt circle.',
  putting: 'Spend ten minutes on lag putts from 30–40 feet; the goal is a tap-in second putt.',
};
function focusHtml(a) {
  const worst = [...CATS].sort((p, q) => a.cats[p.key] - a.cats[q.key])[0];
  const best = [...CATS].sort((p, q) => a.cats[q.key] - a.cats[p.key])[0];
  const lead = a.cats[worst.key] < 0 ? `${worst.label} cost ${f1(Math.abs(a.cats[worst.key]))} strokes. ${FOCUS_TIPS[worst.key]}` : 'Every part of your game held up to your handicap.';
  const keep = a.cats[best.key] > 0 ? ` Keep trusting your ${best.label.toLowerCase()}: ${sg1(a.cats[best.key])} strokes this round.` : '';
  return `<section class="focus">
    <div class="sec-title"><span class="sec-num">17</span><h2 class="sec-name">Next round’s focus</h2></div>
    <p>${lead}${keep}</p>
  </section>`;
}

// ── Render ──
function render(id) {
  const r = rounds.find(x => x.activity_id === id) || rounds.find(isFull) || rounds[0];
  const el = document.getElementById('report');
  if (!r) { el.innerHTML = '<p class="empty">No rounds yet.</p>'; return; }
  document.getElementById('round-select').value = r.activity_id;
  const a = analyze(r);
  if (!a.holes.length) { el.innerHTML = heroHtml(a) + '<p class="empty">This round has no hole-by-hole detail.</p>'; return; }
  const stack = (cls, ...parts) => parts.some(Boolean) ? `<div class="stack ${cls}">${parts.join('')}</div>` : '';
  el.innerHTML = [
    heroHtml(a), scorecardHtml(a), clubsHtml(a), sgHtml(a), puttingHtml(a), shapeHtml(a), mixHtml(a),
    stack('w7', teeHtml(a), roundStatsHtml(a)), approachHtml(a), turnHtml(a), timeHtml(a), sgGridHtml(a), memorableHtml(a),
    courseHtml(a), recentHtml(a), clubSgHtml(a), focusHtml(a),
  ].filter(Boolean).join('');
  // Renumber so skipped sections don't leave gaps.
  el.querySelectorAll('.sec-num').forEach((n, i) => { n.textContent = String(i + 1).padStart(2, '0'); });
  document.title = `${a.score} at ${r.course} · Round Report`;
  window.scrollTo({ top: 0 });
}

async function init() {
  try { await load(); }
  catch (e) { document.getElementById('report').innerHTML = `<p class="empty">Couldn't load data (${esc(e.message)}). Serve the project root with <code>python3 -m http.server 8000</code>.</p>`; return; }
  const sel = document.getElementById('round-select');
  sel.innerHTML = rounds.map(r => `<option value="${r.activity_id}">${r.date} · ${esc(r.course)} · ${r.totals.score} (${r.totals.holes_played})</option>`).join('');
  sel.addEventListener('change', () => { location.hash = sel.value; });
  window.addEventListener('hashchange', () => render(location.hash.slice(1)));
  render(location.hash.slice(1));
}
init();
