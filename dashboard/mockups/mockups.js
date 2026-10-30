// Mock-ups of polished dashboard sections, rendered from the real data files.
// Self-contained on purpose: nothing here is wired into app.js yet.

const COURSE = 'Manchester Country Club';
const C = {
  green: '#16a34a', greenD: '#15803d', greenL: '#dcfce7', red: '#dc2626', redL: '#fecaca', blue: '#3b82f6', orange: '#f97316',
  text: '#0f172a', muted: '#64748b', subtle: '#94a3b8', border: '#e8edf3', light: '#f1f5f9', panel: '#f8fafc',
};
const RESULTS = [
  { key: 'eagle',  label: 'Eagle+',  color: '#eab308', test: d => d <= -2 },
  { key: 'birdie', label: 'Birdie',  color: '#16a34a', test: d => d === -1 },
  { key: 'par',    label: 'Par',     color: '#bbf7d0', test: d => d === 0 },
  { key: 'bogey',  label: 'Bogey',   color: '#fecaca', test: d => d === 1 },
  { key: 'double', label: 'Double',  color: '#f87171', test: d => d === 2 },
  { key: 'triple', label: 'Triple+', color: '#991b1b', test: d => d >= 3 },
];
const SG_CATS = [
  { key: 'off_tee', label: 'Off the tee' }, { key: 'approach', label: 'Approach' },
  { key: 'short_game', label: 'Short game' }, { key: 'putting', label: 'Putting' },
];
const SG_BENCHMARK_15 = { off_tee: -2.5, approach: -5.5, short_game: -2.5, putting: -2.5 };

const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => a.length ? sum(a) / a.length : null;
const r1 = x => x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1);
const signed = x => x == null ? '—' : (x > 0.04 ? '+' : '') + r1(x);
const pct = (n, d) => d ? Math.round(100 * n / d) : null;
const resultColor = d => RESULTS.find(r => r.test(d)).color;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const md = iso => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8)}`;
const svg = (w, h, extra = '') => `<svg viewBox="0 0 ${w} ${h}" width="100%" ${extra}>`;
const t = (x, y, s, a = '') => `<text x="${x}" y="${y}" ${a}>${s}</text>`;
// Lower-is-better metrics flip the colour of a delta.
function delta(now, before, lowerBetter, unit = '') {
  if (now == null || before == null) return '<span class="delta flat">—</span>';
  const d = now - before;
  if (Math.abs(d) < 0.05) return '<span class="delta flat">no change</span>';
  const good = lowerBetter ? d < 0 : d > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${r1(Math.abs(d))}${unit} vs prev 20</span>`;
}
function spark(vals, color = C.green, w = 120, h = 26) {
  const v = vals.filter(x => x != null);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  const pts = vals.map((x, i) => x == null ? null : [w * i / (vals.length - 1), h - 3 - (h - 6) * (x - lo) / ((hi - lo) || 1)]).filter(Boolean);
  const last = pts.at(-1);
  return `${svg(w, h, `style="max-width:${w}px"`)}<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="1.6" opacity=".8"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${color}"/></svg>`;
}
function mock(cls, replaces, title, body, hint = '') {
  return `<div class="mock ${cls}"><p class="replaces">Replaces <b>${replaces}</b></p>
    <div class="chart-card"><div class="card-title"><span>${title}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>${body}</div></div>`;
}

// ── Data ──
let rounds = [], holesBy = {}, shotsBy = {};
async function load() {
  const [r, h, s] = await Promise.all(['rounds', 'holes', 'shots'].map(f => fetch(`../../data/${f}.json`).then(x => x.json())));
  const seen = new Set();
  const key = x => `${x.date}|${x.course}|${x.totals.score}`;
  rounds = r.rounds.filter(x => x.totals?.score && (x.totals.holes_played || 0) >= 14 && !seen.has(key(x)) && seen.add(key(x)))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const x of h.holes) if (x.score != null) (holesBy[x.activity_id] ||= []).push(x);
  for (const x of s.shots) (shotsBy[x.activity_id] ||= []).push(x);
}
const holesOf = rs => rs.flatMap(r => holesBy[r.activity_id] || []);
function stats(rs) {
  const hs = holesOf(rs);
  const withPutts = rs.filter(r => r.totals.putts != null);
  const fw = hs.filter(h => h.par >= 4 && h.fairway_hit != null);
  const girHoles = hs.filter(h => h.putts != null);
  return {
    score: avg(rs.map(r => r.totals.score)),
    putts: avg(withPutts.map(r => r.totals.putts)),
    gir: girHoles.length ? 100 * girHoles.filter(h => h.score - h.putts <= h.par - 2).length / girHoles.length : null,
    fw: fw.length ? 100 * fw.filter(h => h.fairway_hit).length / fw.length : null,
  };
}

// ── Overall mocks ──
function kpiMock(cur, prev) {
  const a = stats(cur), b = stats(prev);
  const series = [...cur].reverse();
  const hcap = cur.find(r => r.hcap_index != null)?.hcap_index;
  const hcapPrev = prev.find(r => r.hcap_index != null)?.hcap_index;
  const perRound = f => series.map(r => f(stats([r])));
  const cell = (lbl, val, d, sp) => `<div><div class="lbl">${lbl}</div><div class="val">${val}</div>${d}${sp}</div>`;
  const courses = new Set(cur.map(r => r.course)).size;
  return `<div class="mock wide"><p class="replaces">Replaces <b>the seven KPI tiles</b>: one band, handicap as the headline, each number with its direction and a sparkline</p>
  <div class="kpis">
    ${cell(`Handicap index · ${cur.length} rounds, ${courses} courses`, hcap ?? '—', delta(hcap, hcapPrev, true), spark(series.map(r => r.hcap_index)))}
    ${cell('Avg score', r1(a.score), delta(a.score, b.score, true), spark(series.map(r => r.totals.score)))}
    ${cell('Avg putts', r1(a.putts), delta(a.putts, b.putts, true), spark(perRound(s => s.putts)))}
    ${cell('GIR', `${r1(a.gir)}%`, delta(a.gir, b.gir, false, ' pts'), spark(perRound(s => s.gir)))}
    ${cell('Fairways', `${r1(a.fw)}%`, delta(a.fw, b.fw, false, ' pts'), spark(perRound(s => s.fw)))}
    ${cell('Best round', Math.min(...cur.map(r => r.totals.score)), `<span class="delta flat">${md(cur.reduce((p, q) => q.totals.score < p.totals.score ? q : p).date)}</span>`, '')}
  </div></div>`;
}

function sgMock(cur, prev) {
  const sg = k => avg(cur.map(r => r.strokes_gained?.[k]).filter(v => v != null));
  const sgPrev = k => avg(prev.map(r => r.strokes_gained?.[k]).filter(v => v != null));
  const vals = SG_CATS.map(c => ({ ...c, v: sg(c.key), p: sgPrev(c.key), bm: SG_BENCHMARK_15[c.key] }));
  const lim = Math.ceil(Math.max(6, ...vals.map(x => Math.abs(x.v)))) + 1;
  const W = 720, L = 100, R = 50, rowH = 42, H = vals.length * rowH + 34;
  const x = v => L + (W - L - R) * (v + lim) / lim;   // only the negative side plus a little room
  const xs = v => Math.min(W - R, x(v));
  let s = svg(W, H);
  for (let g = -lim; g <= 0; g += 2) {
    s += `<line x1="${x(g)}" x2="${x(g)}" y1="6" y2="${H - 20}" stroke="${g === 0 ? C.subtle : C.light}"/>` + t(x(g), H - 6, g, `font-size="10" fill="${C.subtle}" text-anchor="middle"`);
  }
  vals.forEach((c, i) => {
    const y = 14 + i * rowH;
    s += t(0, y + 11, c.label, `font-size="12" font-weight="600" fill="${C.text}"`);
    s += `<rect x="${L}" y="${y}" width="${W - L - R}" height="16" rx="4" fill="${C.panel}"/>`;
    s += `<rect x="${xs(c.v)}" y="${y}" width="${x(0) - xs(c.v)}" height="16" rx="4" fill="${C.red}" opacity="${c.v < c.bm ? .85 : .45}"/>`;
    s += `<line x1="${x(c.bm)}" x2="${x(c.bm)}" y1="${y - 4}" y2="${y + 20}" stroke="${C.text}" stroke-width="2"/>`;
    if (c.p != null) s += `<circle cx="${xs(c.p)}" cy="${y + 8}" r="3.5" fill="#fff" stroke="${C.muted}" stroke-width="1.5"/>`;
    s += t(W, y + 12, r1(c.v), `font-size="12.5" font-weight="800" fill="${C.red}" text-anchor="end"`);
    s += t(L, y + 30, `${r1(c.v - c.bm)} vs 15-hcp`, `font-size="9.5" fill="${C.subtle}"`);
  });
  s += '</svg>';
  const worst = [...vals].sort((a, b) => (a.v - a.bm) - (b.v - b.bm))[0];
  const best = [...vals].sort((a, b) => (b.v - b.bm) - (a.v - a.bm))[0];
  const total = sum(vals.map(v => v.v)), totalPrev = sum(vals.map(v => v.p ?? 0));
  const body = `<div class="sg-wrap"><div>${s}
      <div class="legend"><span><i style="background:${C.red}"></i>You (avg / round)</span><span><i style="background:${C.text};width:2px"></i>~15 handicap</span><span><i style="background:#fff;border:1.5px solid ${C.muted};border-radius:50%"></i>Previous 20</span></div></div>
    <div class="side-cards">
      <div class="side-card bad"><b class="down">${r1(total)}</b><strong>strokes / round vs scratch</strong><br>previous 20: ${r1(totalPrev)}</div>
      <div class="side-card bad"><b class="down">${r1(worst.v - worst.bm)}</b><strong>${worst.label}</strong> is furthest behind a 15-handicap</div>
      <div class="side-card"><b class="up">${signed(best.v - best.bm)}</b><strong>${best.label}</strong> ${best.v >= best.bm ? 'already beats a 15-handicap' : 'is closest to a 15-handicap'}</div>
    </div></div>`;
  return mock('wide', 'Strokes Gained by Category (Plotly bars)', 'Strokes gained by category', body, '<span class="pill">ESTIMATE</span>');
}

function scoreTrendMock(cur) {
  const rs = [...cur].reverse();
  const sc = rs.map(r => r.totals.score);
  const ma = sc.map((_, i) => i < 2 ? null : avg(sc.slice(i - 2, i + 1)));
  const lo = Math.min(...sc) - 2, hi = Math.max(...sc) + 2;
  const W = 520, H = 200, L = 30, B = 22, T = 16;
  const x = i => L + (W - L - 12) * i / (rs.length - 1);
  const y = v => T + (H - T - B) * (hi - v) / (hi - lo);
  const mean = avg(sc);
  let s = svg(W, H);
  s += `<rect x="${L}" y="${y(mean + 3)}" width="${W - L - 12}" height="${y(mean - 3) - y(mean + 3)}" fill="${C.greenL}" opacity=".55"/>`;
  s += `<line x1="${L}" x2="${W - 12}" y1="${y(mean)}" y2="${y(mean)}" stroke="${C.greenD}" stroke-dasharray="4 3" opacity=".6"/>`;
  s += t(L + 4, y(mean + 3) - 4, `normal range · avg ${r1(mean)}`, `font-size="10" fill="${C.greenD}" font-weight="600"`);
  [Math.ceil(lo / 5) * 5, Math.floor(hi / 5) * 5].forEach(v => { s += t(L - 6, y(v) + 3, v, `font-size="10" fill="${C.subtle}" text-anchor="end"`); });
  s += `<path d="${ma.map((v, i) => v == null ? '' : `${ma[i - 1] == null ? 'M' : 'L'}${x(i)},${y(v)}`).join('')}" fill="none" stroke="${C.greenD}" stroke-width="2.5" opacity=".35"/>`;
  s += `<path d="${sc.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')}" fill="none" stroke="${C.text}" stroke-width="1.4"/>`;
  const best = sc.indexOf(Math.min(...sc)), worst = sc.indexOf(Math.max(...sc));
  sc.forEach((v, i) => {
    const col = v < mean - 3 ? C.green : v > mean + 3 ? C.red : C.text;
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="${i === sc.length - 1 ? 5 : 3.5}" fill="${col}" stroke="#fff" stroke-width="1.2"><title>${rs[i].date} · ${rs[i].course} · ${v}</title></circle>`;
  });
  const tag = (i, label, col, above) => {
    const tx = Math.max(L + 40, Math.min(W - 52, x(i))), ty = y(sc[i]) + (above ? -12 : 20);
    return `<rect x="${tx - 42}" y="${ty - 11}" width="84" height="16" rx="8" fill="#fff" stroke="${col}"/>` + t(tx, ty + 1, label, `font-size="9.5" font-weight="700" fill="${col}" text-anchor="middle"`);
  };
  s += tag(best, `Best ${sc[best]} · ${md(rs[best].date)}`, C.green, false) + tag(worst, `Worst ${sc[worst]} · ${md(rs[worst].date)}`, C.red, true);
  s += t(L, H - 4, md(rs[0].date), `font-size="10" fill="${C.subtle}"`) + t(W - 12, H - 4, md(rs.at(-1).date), `font-size="10" fill="${C.subtle}" text-anchor="end"`);
  s += '</svg>';
  const first5 = avg(sc.slice(0, 5)), last5 = avg(sc.slice(-5));
  const within = sc.filter(v => Math.abs(v - mean) <= 3).length;
  const body = `${s}
    <div class="legend"><span><i style="background:${C.text};height:2px"></i>Score</span><span><i style="background:${C.greenD};opacity:.35;height:3px"></i>3-round avg</span><span><i style="background:${C.greenL}"></i>Your normal range (avg ±3)</span></div>
    <div class="strip" style="margin-top:14px">
      <div class="big"><b>${r1(mean)}</b><span>Average</span></div>
      <div><b>${within}/${sc.length}</b><span>In normal range</span></div>
      <div><b class="${last5 < first5 ? 'up' : 'down'}">${last5 < first5 ? '▼' : '▲'} ${r1(Math.abs(last5 - first5))}</b><span>First 5 → last 5</span></div>
    </div>`;
  return mock('w7', 'Score trend (line + summary text)', 'Score trend', body, `Last ${sc.length} rounds`);
}

function mixMock(cur) {
  const hs = holesOf(cur);
  const counts = RESULTS.map(r => ({ ...r, n: hs.filter(h => r.test(h.score - h.par)).length }));
  const bar = counts.filter(c => c.n).map(c => `<div style="flex:${c.n};background:${c.color};color:${['double', 'triple', 'birdie'].includes(c.key) ? '#fff' : C.text}">${pct(c.n, hs.length) >= 6 ? pct(c.n, hs.length) + '%' : ''}</div>`).join('');
  const par = p => { const x = hs.filter(h => h.par === p); return x.length ? avg(x.map(h => h.score - h.par)) : null; };
  const pt = [3, 4, 5].map(p => ({ p, v: par(p) }));
  const best = [...pt].sort((a, b) => a.v - b.v)[0];
  const body = `<div class="mix-bar">${bar}</div>
    <div class="mix-keys">${counts.map(c => `<div><i style="background:${c.color}"></i><b>${c.n}</b><span>${c.label}</span></div>`).join('')}</div>
    <div class="strip">${pt.map(x => `<div><b class="${x === best ? 'up' : ''}">+${r1(x.v)}</b><span>Par ${x.p}s · avg to par</span></div>`).join('')}</div>
    <p class="quote">${pct(counts[0].n + counts[1].n + counts[2].n, hs.length)}% of holes at par or better. Par ${best.p}s are your strongest hole type.</p>`;
  return mock('w5', 'Scoring Summary donut + Scoring by Par Type', 'Scoring mix', body, `${hs.length} holes`);
}

function puttingMock(cur) {
  const hs = holesOf(cur).filter(h => h.putts != null);
  const c = k => hs.filter(h => k === 3 ? h.putts >= 3 : h.putts === k).length;
  const rs = [...cur].reverse().filter(r => r.totals.putts != null);
  const W = 420, H = 110, B = 16, bw = W / rs.length;
  const max = Math.max(...rs.map(r => r.totals.putts)), min = Math.min(28, ...rs.map(r => r.totals.putts));
  const target = 34;
  const y = v => 10 + (H - B - 10) * (max - v) / (max - min + 2);
  let s = svg(W, H);
  s += `<line x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}" stroke="${C.greenD}" stroke-dasharray="4 3"/>` + `<rect x="0" y="${y(target) - 8}" width="78" height="15" rx="7" fill="#fff" stroke="${C.greenD}"/>` + t(39, y(target) + 3, '20-hcp avg 34', `font-size="9" fill="${C.greenD}" text-anchor="middle" font-weight="700"`);
  const targetLine = s.slice(s.indexOf('<line')); s = s.slice(0, s.indexOf('<line'));
  rs.forEach((r, i) => {
    const v = r.totals.putts;
    s += `<rect x="${i * bw + 3}" y="${y(v)}" width="${bw - 6}" height="${H - B - y(v)}" rx="3" fill="${v <= target ? C.green : '#fca5a5'}"><title>${r.date}: ${v}</title></rect>`;
    s += t(i * bw + bw / 2, y(v) - 3, v, `font-size="8.5" fill="${C.muted}" text-anchor="middle"`);
  });
  s += targetLine + '</svg>';
  const three = c(3);
  const body = `<div class="strip">
      <div><b>${pct(c(0) + c(1), hs.length)}%</b><span>0–1 putt</span></div>
      <div class="big"><b>${pct(c(2), hs.length)}%</b><span>2 putts</span></div>
      <div><b class="down">${pct(three, hs.length)}%</b><span>3+ putts</span></div>
      <div><b>${r1(three / cur.length)}</b><span>3-putts / round</span></div>
    </div>
    <p style="font-size:11px;color:${C.muted};margin:14px 0 6px;font-weight:600">PUTTS PER ROUND</p>${s}`;
  return mock('', 'Putting Summary donut', 'Putting', body);
}

function fairwayMock(cur) {
  const per = r => {
    const hs = (holesBy[r.activity_id] || []).filter(h => h.par >= 4 && h.fairway_hit != null);
    return { n: hs.length, hit: hs.filter(h => h.fairway_hit).length, left: hs.filter(h => h.fairway_missed_direction === 'LEFT').length, right: hs.filter(h => h.fairway_missed_direction === 'RIGHT').length };
  };
  const all = cur.map(per);
  const tot = k => sum(all.map(a => a[k]));
  const rs = [...cur].reverse().filter(r => per(r).n).slice(-12);
  const W = 420, H = 150, B = 16, T = 14, bw = W / rs.length;
  let s = svg(W, H);
  rs.forEach((r, i) => {
    const p = per(r); if (!p.n) return;
    let yy = H - B;
    [[p.hit, C.green], [p.left, C.blue], [p.right, C.orange], [p.n - p.hit - p.left - p.right, '#cbd5e1']].forEach(([n, col]) => { const h = (H - B - T) * n / p.n; yy -= h; s += `<rect x="${i * bw + 3}" y="${yy}" width="${bw - 6}" height="${h}" fill="${col}" opacity=".85"/>`; });
    s += t(i * bw + bw / 2, T - 4, r.totals.score, `font-size="9" fill="${C.muted}" text-anchor="middle" font-weight="600"`);
  });
  s += t(0, H - 3, md(rs[0].date), `font-size="9.5" fill="${C.subtle}"`) + t(W, H - 3, 'Latest', `font-size="9.5" fill="${C.subtle}" text-anchor="end"`);
  s += '</svg>';
  const n = tot('n');
  const bias = tot('right') > tot('left') ? 'right' : 'left';
  const body = `<div class="strip">
      <div><b style="color:${C.blue}">${pct(tot('left'), n)}%</b><span>Miss left</span></div>
      <div class="big"><b class="up">${pct(tot('hit'), n)}%</b><span>Fairway</span></div>
      <div><b style="color:${C.orange}">${pct(tot('right'), n)}%</b><span>Miss right</span></div>
    </div>
    <p style="font-size:11px;color:${C.muted};margin:14px 0 6px;font-weight:600">EACH ROUND (SCORE ON TOP)</p>${s}
    <div class="legend"><span><i style="background:${C.green}"></i>Fairway</span><span><i style="background:${C.blue}"></i>Left</span><span><i style="background:${C.orange}"></i>Right</span><span><i style="background:#cbd5e1"></i>Missed, side not recorded</span></div>
    <p class="quote">${Math.round(100 * Math.max(tot('left'), tot('right')) / (tot('left') + tot('right')))}% of your misses go ${bias}.</p>`;
  return mock('', 'Fairway Miss Direction bar', 'Off the tee', body, `${n} par 4 & 5 drives`);
}

function clubMock(cur) {
  const by = {};
  for (const r of cur) for (const s of shotsBy[r.activity_id] || []) {
    if (!['TEE', 'APPROACH', 'LAYUP'].includes(s.shot_type) || !s.distance_yards || !s.club_name || s.club_type_name === 'Putter') continue;
    (by[s.club_name] ||= { type: s.club_type_name, d: [] }).d.push(s.distance_yards);
  }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.round(p * (s.length - 1))]; };
  const clubs = Object.entries(by).filter(([, v]) => v.d.length >= 5)
    .map(([name, v]) => ({ name, type: v.type, n: v.d.length, med: q(v.d, .5), lo: q(v.d, .25), hi: q(v.d, .75) }))
    .sort((a, b) => b.med - a.med);
  const max = Math.ceil(Math.max(...clubs.map(c => c.hi)) / 25) * 25 + 10;
  const W = 760, L = 150, R = 110, rowH = 26, H = clubs.length * rowH + 24;
  const x = v => L + (W - L - R) * v / max;
  let s = svg(W, H, 'style="min-width:520px"');
  for (let g = 0; g <= max; g += 50) s += `<line x1="${x(g)}" x2="${x(g)}" y1="0" y2="${H - 18}" stroke="${C.light}"/>` + t(x(g), H - 4, `${g} yd`, `font-size="10" fill="${C.subtle}" text-anchor="middle"`);
  clubs.forEach((c, i) => {
    const y = i * rowH + 4;
    s += t(0, y + 12, c.name, `font-size="12" font-weight="600" fill="${C.text}"`) + t(0, y + 22, c.type, `font-size="9" fill="${C.subtle}"`);
    s += `<rect x="${x(c.lo)}" y="${y + 3}" width="${x(c.hi) - x(c.lo)}" height="12" rx="6" fill="${C.greenL}"/>`;
    s += `<line x1="${x(c.med)}" x2="${x(c.med)}" y1="${y}" y2="${y + 18}" stroke="${C.greenD}" stroke-width="2.5"/>`;
    s += t(x(c.med) + 6, y + 13, Math.round(c.med), `font-size="10.5" font-weight="700" fill="${C.greenD}"`);
    const next = clubs[i + 1];
    const gap = next ? c.med - next.med : null;
    const gapTxt = gap == null ? '' : gap < 6 ? `<tspan fill="${C.red}" font-weight="700">gap ${Math.round(gap)} yd — overlap</tspan>` : gap > 25 ? `<tspan fill="${C.orange}" font-weight="700">gap ${Math.round(gap)} yd</tspan>` : `gap ${Math.round(gap)} yd`;
    s += t(W - R + 10, y + 12, gapTxt, `font-size="10" fill="${C.muted}"`) + t(W, y + 12, `${c.n}×`, `font-size="9.5" fill="${C.subtle}" text-anchor="end"`);
  });
  s += '</svg>';
  const body = `<div style="overflow-x:auto">${s}</div>
    <div class="legend"><span><i style="background:${C.greenD};width:3px"></i>Median distance</span><span><i style="background:${C.greenL};width:18px;border-radius:6px"></i>Typical range (middle half)</span><span>Gap = drop to the next club down; red flags clubs that overlap</span></div>`;
  return mock('wide', 'Distance Distribution by Club (box plots)', 'Club gapping', body, `${clubs.length} clubs · full swings · last ${cur.length} rounds`);
}

function focusMock(cur) {
  const sg = k => avg(cur.map(r => r.strokes_gained?.[k]).filter(v => v != null));
  const hs = holesOf(cur);
  const worst = [...SG_CATS].sort((a, b) => (sg(a.key) - SG_BENCHMARK_15[a.key]) - (sg(b.key) - SG_BENCHMARK_15[b.key]))[0];
  const missedGir = hs.filter(h => h.putts != null && h.score - h.putts > h.par - 2);
  const scramble = pct(missedGir.filter(h => h.score <= h.par).length, missedGir.length);
  const putts = avg(cur.map(r => r.totals.putts).filter(v => v != null));
  const gir = stats(cur).gir;
  const pen = avg(cur.map(r => sum((holesBy[r.activity_id] || []).map(h => h.penalties || 0))));
  const row = (tag, text, v, sub, bad) => `<div class="insight"><span class="tag">${tag}</span><span>${text}</span><span class="v ${bad ? 'down' : 'up'}">${v}<small>${sub}</small></span></div>`;
  const body = `<div class="m-focus">
      <div class="m-focus-num"><b>${r1(sg(worst.key))}</b><span>strokes / round</span></div>
      <div><h3>${worst.label} is your #1 opportunity</h3>
        <p style="color:${C.muted};font-size:13px">${r1(Math.abs(sg(worst.key) - SG_BENCHMARK_15[worst.key]))} strokes behind a 15-handicap, more than any other part of your game.</p>
        <ol><li>Aim for the centre of the green, never the pin.</li><li>Ladder drill: 5 balls each to 100 / 125 / 150 yds.</li><li>Club up one and swing at 80% on mid-irons.</li></ol></div>
    </div>
    <div class="insight-list">
      ${row('Short game', 'Saving par after missing the green', `${scramble}%`, '20-hcp ~25%', scramble < 20)}
      ${row('Putting', 'Putts per round', r1(putts), '20-hcp ~34', putts > 34)}
      ${row('Approach', 'Greens in regulation', `${r1(gir)}%`, '20-hcp ~22%', gir < 20)}
      ${row('Penalties', 'Penalty strokes per round', r1(pen), 'target < 1', pen > 1)}
    </div>`;
  return mock('', 'Focus This Week + Insights cards', 'Focus & insights', body);
}

// ── By Course mocks ──
function courseMocks() {
  const rs = rounds.filter(r => r.course === COURSE);
  if (rs.length < 3) return '';
  const recent = rs.slice(0, 20);
  const hs = holesOf(recent);
  const holeNums = [...new Set(hs.map(h => h.hole))].sort((a, b) => a - b);
  const byHole = n => hs.filter(h => h.hole === n);
  const avgToPar = n => avg(byHole(n).map(h => h.score - h.par));

  // Records
  const nine = (r, side) => sum((holesBy[r.activity_id] || []).filter(h => side ? h.hole > 9 : h.hole <= 9).map(h => h.score));
  const bestRound = rs.reduce((a, b) => b.totals.score < a.totals.score ? b : a);
  const bestFront = rs.reduce((a, b) => nine(b, 0) < nine(a, 0) ? b : a);
  const bestBack = rs.reduce((a, b) => nine(b, 1) < nine(a, 1) ? b : a);
  const withPutts = rs.filter(r => r.totals.putts != null);
  const fewest = withPutts.reduce((a, b) => b.totals.putts < a.totals.putts ? b : a);
  const records = `<div class="records">
      <div><b>${bestRound.totals.score}</b><span>Best round</span><small>${md(bestRound.date)} ${bestRound.date.slice(0, 4)}</small></div>
      <div><b>${nine(bestFront, 0)}</b><span>Best front 9</span><small>${md(bestFront.date)} ${bestFront.date.slice(0, 4)}</small></div>
      <div><b>${nine(bestBack, 1)}</b><span>Best back 9</span><small>${md(bestBack.date)} ${bestBack.date.slice(0, 4)}</small></div>
      <div><b>${fewest.totals.putts}</b><span>Fewest putts</span><small>${md(fewest.date)} ${fewest.date.slice(0, 4)}</small></div>
    </div>
    <div class="strip" style="margin-top:16px">
      <div><b>${rs.length}</b><span>Rounds here</span></div>
      <div class="big"><b>${r1(avg(recent.map(r => r.totals.score)))}</b><span>Avg (last ${recent.length})</span></div>
      <div><b>${r1(avg(recent.slice(0, 5).map(r => r.totals.score)))}</b><span>Last 5 avg</span></div>
    </div>`;

  // Heatmap
  const nineHtml = ns => `<div class="heat-nine">${ns.map(n => {
    const cells = byHole(n).map(h => h.score - h.par).sort((a, b) => a - b);
    const a = avgToPar(n);
    return `<div class="heat-col"><div class="hn">${n}</div>${cells.map(d => `<div class="cell" style="background:${resultColor(d)}"></div>`).join('')}<div class="av" style="color:${a >= 1.5 ? C.red : a <= 0.8 ? C.greenD : C.text}">+${r1(a)}</div></div>`;
  }).join('')}</div>`;
  const easiest = [...holeNums].sort((a, b) => avgToPar(a) - avgToPar(b))[0];
  const hardest = [...holeNums].sort((a, b) => avgToPar(b) - avgToPar(a))[0];
  const heat = `<div class="heat">${nineHtml(holeNums.filter(n => n <= 9))}${nineHtml(holeNums.filter(n => n > 9))}</div>
    <div class="legend">${RESULTS.map(r => `<span><i style="background:${r.color}"></i>${r.label}</span>`).join('')}</div>
    <p class="quote">Hole ${easiest} gives strokes back (avg +${r1(avgToPar(easiest))}). Hole ${hardest} takes them (avg +${r1(avgToPar(hardest))}).</p>`;

  // Ringer
  const yr = rs[0].date.slice(0, 4);
  const season = rs.filter(r => r.date.startsWith(yr));
  const scoreOf = (r, n) => (holesBy[r.activity_id] || []).find(h => h.hole === n);
  const parOf = n => byHole(n)[0]?.par ?? 4;
  const best = holeNums.map(n => Math.min(...season.map(r => scoreOf(r, n)?.score ?? 99)));
  const chip = (s, p, isBest) => `<td style="background:${s == null ? 'transparent' : resultColor(s - p)};color:${s - p >= 2 || s - p === -1 ? '#fff' : C.text};${isBest ? `box-shadow:inset 0 0 0 2px ${C.text}` : ''}">${s ?? ''}</td>`;
  const ringer = `<div class="ringer-wrap"><table class="ringer">
      <tr><th></th>${holeNums.map(n => `<th>${n}</th>`).join('')}<th>Tot</th></tr>
      <tr><td style="color:${C.subtle}">Par</td>${holeNums.map(n => `<td style="color:${C.subtle}">${parOf(n)}</td>`).join('')}<td class="tot">${sum(holeNums.map(parOf))}</td></tr>
      <tr class="best"><td>Ringer</td>${holeNums.map((n, i) => chip(best[i], parOf(n))).join('')}<td class="tot" style="color:${C.greenD}">${sum(best)}</td></tr>
      ${season.slice(0, 6).map(r => `<tr><td>${md(r.date)}</td>${holeNums.map((n, i) => { const s = scoreOf(r, n)?.score; return chip(s, parOf(n), s === best[i]); }).join('')}<td class="tot">${r.totals.score}</td></tr>`).join('')}
    </table></div>
    <p class="quote">Ringer ${sum(best)} (${sum(best) - sum(holeNums.map(parOf)) > 0 ? '+' : ''}${sum(best) - sum(holeNums.map(parOf))}) across ${season.length} rounds in ${yr}. Outlined cells are where a round set the ringer.</p>`;

  // Course vs overall dumbbell
  const here = stats(recent), all = stats(rounds.slice(0, 20));
  const rows = [
    { label: 'GIR %', a: here.gir, b: all.gir, hi: true },
    { label: 'Fairway %', a: here.fw, b: all.fw, hi: true },
    { label: 'Putts / round', a: here.putts, b: all.putts, hi: false },
    { label: 'Score', a: here.score, b: all.score, hi: false },
  ];
  let d = '';
  rows.forEach(rw => {
    const lo = Math.min(rw.a, rw.b), hi = Math.max(rw.a, rw.b);
    const pad = Math.max(2, (hi - lo) * 1.5);
    const W = 300, L = 0, x = v => L + W * (v - (lo - pad)) / ((hi + pad) - (lo - pad));
    const better = rw.hi ? rw.a >= rw.b : rw.a <= rw.b;
    d += `<div style="display:grid;grid-template-columns:110px 1fr;align-items:center;margin-bottom:12px">
      <span style="font-weight:600;font-size:12.5px">${rw.label}</span>
      ${svg(W, 42)}<line x1="${x(rw.a)}" x2="${x(rw.b)}" y1="20" y2="20" stroke="${better ? C.green : C.red}" stroke-width="3"/>
      <circle cx="${x(rw.b)}" cy="20" r="6" fill="#fff" stroke="${C.muted}" stroke-width="2"/><circle cx="${x(rw.a)}" cy="20" r="6" fill="${better ? C.green : C.red}"/>
      ${t(x(rw.a), 8, r1(rw.a), `font-size="10.5" font-weight="800" fill="${better ? C.greenD : C.red}" text-anchor="middle"`)}${t(x(rw.b), 40, r1(rw.b), `font-size="10" fill="${C.muted}" text-anchor="middle"`)}</svg></div>`;
  });
  const dumbbell = `${d}<div class="legend"><span><i style="background:${C.green};border-radius:50%"></i>This course</span><span><i style="background:#fff;border:2px solid ${C.muted};border-radius:50%"></i>Overall (last 20)</span><span>Line colour: green where this course is better</span></div>`;

  return `<p class="view-label">By Course · ${COURSE}</p><div class="grid">
    ${mock('w7', 'Records & Milestones tiles + course KPIs', 'Records', records)}
    ${mock('w5', 'This Course vs Overall table', 'This course vs your overall', dumbbell)}
    ${mock('wide', 'Score / GIR / Putts by Hole charts', 'Where this course scores you', heat, `Every hole, last ${recent.length} rounds · best result on top`)}
    ${mock('wide', 'Division Days Ringer table', `Ringer card · ${yr}`, ringer, 'Best score on each hole this season')}
  </div>`;
}

async function init() {
  const el = document.getElementById('mocks');
  try { await load(); } catch (e) { el.innerHTML = `<p class="replaces">Couldn't load data: ${e.message}. Serve the project root with python3 -m http.server 8000.</p>`; return; }
  const cur = rounds.slice(0, 20), prev = rounds.slice(20, 40);
  el.innerHTML = `<p class="view-label">Overall · Stats</p><div class="grid">
      ${kpiMock(cur, prev)}
      ${sgMock(cur, prev)}
      ${scoreTrendMock(cur)}${mixMock(cur)}
      ${puttingMock(cur)}${fairwayMock(cur)}
      ${clubMock(cur)}
    </div>
    <p class="view-label">Overall · Insights</p><div class="grid">${focusMock(cur).replace('class="mock "', 'class="mock wide"')}</div>
    ${courseMocks()}`;
}
init();
