// Token Radar terminal. No network: every byte shown is in data.js beside it.
const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function money(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n);
}
function moneyShort(n) {
  if (n >= 1e9) return '$' + (n / 1e9) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3) + 'K';
  return '$' + n;
}
function pct(n) { if (n === null || n === undefined) return '-'; return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
function ageText(d) {
  if (d === null || d === undefined) return '-';
  if (d < 30) return d + 'd';
  if (d < 365) return Math.round(d / 30) + 'mo';
  return (d / 365).toFixed(1) + 'y';
}
function shiftText(s) {
  if (s === null || s === undefined) return '-';
  const cls = s < 0 ? 'shift-down' : s > 0 ? 'shift-up' : '';
  return `<span class="${cls}">${s > 0 ? '+' : ''}${s.toFixed(2)} dex</span>`;
}
const watchSet = new Set(R.watchlist_slugs || []);
let view = 'all';
function spark(series) {
  if (!series || series.length < 2) return '<span class="dim">-</span>';
  const w = 76, h = 22, lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => `${(i / (series.length - 1) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const up = series[series.length - 1] >= series[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? '#2dd4bf' : '#f87171'}" stroke-width="1.4"/></svg>`;
}
function filteredRows() {
  const q = $('q').value.trim().toLowerCase();
  const chain = $('chain').value;
  const cat = $('cat').value;
  const rows = R.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    if (chain && !r.chains.includes(chain)) return false;
    if (cat && (r.category || 'Uncategorised') !== cat) return false;
    if (view === 'watch' && !watchSet.has(r.slug)) return false;
    if (view === 'hot' && !(r.change_7d !== null && r.change_7d >= 20)) return false;
    if (view === 'early' && !(r.age_days !== null && r.age_days < 180)) return false;
    if (view === 'new' && !(r.age_days !== null && r.age_days <= 90)) return false;
    return true;
  });
  const by = {
    implied: (a, b) => b.implied_value_usd - a.implied_value_usd,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    growth: (a, b) => (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9),
    age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
    name: (a, b) => (a.name < b.name ? -1 : 1),
  }[$('sort').value];
  return rows.sort(by);
}
function badge(s) {
  const cls = s === 'heating up' || s === 'early mover' ? 'badge hot' : s === 'young' ? 'badge new' : 'badge';
  return `<span class="${cls}">${esc(s)}</span>`;
}
function renderTickers() {
  const top = (R.chain_totals || []).slice(0, 10).map((c) => `<b>${esc(c.chain.toUpperCase())}</b> ${money(c.tvl_usd)} TVL · ${c.protocols} protocols · ${c.watchlist} watchlist`).join(' &nbsp;|&nbsp; ');
  const movers = [...R.rows].sort((a, b) => Math.abs(b.change_7d ?? 0) - Math.abs(a.change_7d ?? 0)).slice(0, 10)
    .map((r) => `<b>${esc(r.slug.toUpperCase())}</b> <span class="${(r.change_7d ?? 0) >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</span> 7d`).join(' &nbsp;|&nbsp; ');
  $('tick-top').innerHTML = `SNAPSHOT ${esc(R.as_of)} &nbsp;|&nbsp; ${top} &nbsp;|&nbsp; ${top}`;
  $('tick-bottom').innerHTML = `TOP MOVERS 7D &nbsp;|&nbsp; ${movers} &nbsp;|&nbsp; ${movers}`;
}
function renderPicks() {
  const top = R.rows[0];
  const top50 = R.rows.slice(0, 50);
  const hottest = top50.reduce((a, b) => ((b.change_7d ?? -1e9) > (a.change_7d ?? -1e9) ? b : a), top50[0]);
  const young20 = R.rows.slice(0, 20).filter((r) => r.age_days !== null);
  const youngest = young20.reduce((a, b) => (b.age_days < a.age_days ? b : a), young20[0]);
  const pick = (label, r, why) => `<div class="pick"><span class="pick-label">${esc(label)}</span><a href="#/protocol/${esc(r.slug)}">${esc(r.name)}</a><span class="pick-why">${esc(why)}</span></div>`;
  $('picks').innerHTML =
    pick('Top value', top, `${money(top.implied_value_usd)} implied · ${money(top.tvl_usd)} TVL`) +
    pick('Heating up', hottest, `${pct(hottest.change_7d)} TVL in 7 days · rank #${hottest.rank}`) +
    pick('Youngest in the top 20', youngest, `tracked ${ageText(youngest.age_days)} · rank #${youngest.rank}`);
}
function renderModelStrip() {
  const v = R.calibration.tilt_validation;
  $('modelstrip').innerHTML =
    `<span class="ms-label">How this board is priced</span>` +
    `<span class="ms-formula">implied = calibrate(TVL x category median x size tilt x growth x maturity x chain reach)</span>` +
    `<span class="ms-valid">Nested 5-fold, ${v.peers} live-token peers: calibration reduced median APE from ${v.full_median_ape_sized_pct.toFixed(1)}% to ${v.full_cal_median_ape_pct.toFixed(1)}%, trimmed mean from ${v.full_trimmed_mean_ape_sized_pct.toFixed(1)}% to ${v.full_cal_trimmed_mean_ape_pct.toFixed(1)}%, and improved within-2x from ${v.full_within2x_sized_pct.toFixed(1)}% to ${v.full_cal_within2x_pct.toFixed(1)}%; Spearman fell from ${v.full_spearman_sized.toFixed(3)} to ${v.full_cal_spearman.toFixed(3)}. This is a cross-sectional market-cap/TVL proxy check, not validation of token-launch prices. Full detail in The model.</span>`;
}
function renderBoard() {
  const rows = filteredRows();
  $('count').textContent = `${rows.length} of ${R.rows.length} protocols - ranked by implied launch value`;
  $('rows').innerHTML = rows.map((r) => {
    const g = r.change_7d === null ? '<span class="dim">-</span>' : `<span class="${r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</span>`;
    const watch = watchSet.has(r.slug) ? '<span class="badge watch">watchlist</span>' : '';
    return `<tr>
      <td class="num">${r.rank}</td>
      <td><span class="name">${esc(r.name)}</span><span class="sub">${esc(r.slug)}</span></td>
      <td>${spark(R.series ? R.series[r.slug] : null)}</td>
      <td>${esc(r.category || '-')}</td>
      <td>${r.chains.slice(0, 3).map(esc).join(', ')}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num">${g}</td>
      <td class="num">${ageText(r.age_days)}</td>
      <td class="num val">${money(r.implied_value_usd)}</td>
      <td>${watch}${r.signals.map(badge).join('')}</td>
      <td><button class="link" type="button" data-slug="${esc(r.slug)}">Farm plan &gt;</button></td>
    </tr>`;
  }).join('');
}
function renderLive() {
  $('live').innerHTML = R.live.map((p) => `<tr>
    <td><span class="name">${esc(p.name)}</span><span class="sub">${esc(p.slug)}</span></td>
    <td>${esc(p.category || '-')}</td>
    <td class="num">${money(p.tvl_usd)}</td>
    <td class="num">${p.mcap_usd === null ? '-' : money(p.mcap_usd)}</td>
    <td class="num">${p.ratio === null ? '-' : p.ratio.toFixed(3) + 'x'}</td>
    <td class="num">${p.change_7d === null ? '-' : pct(p.change_7d)}</td>
  </tr>`).join('');
}
function renderNews() {
  $('newslist').innerHTML = (R.news || []).map((n) => `<article class="newsitem"><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p><span class="newssrc">Source: ${esc(n.source)} · ${esc(n.date)}</span></article>`).join('') ||
    '<p class="note">No news items in data.js.</p>';
}
function renderCalib() {
  $('calib').innerHTML = R.calibration.categories.map((c) => `<tr>
    <td>${esc(c.category)}</td><td class="num">${c.multiple.toFixed(3)}x</td>
    <td class="num">${c.peers}</td><td>${c.fallback ? 'whole-market median (too few peers)' : 'median of live peers'}</td>
  </tr>`).join('');
  const v = R.calibration.tilt_validation;
  const pl = R.calibration.power_law;
  $('cand').innerHTML = v.candidates.map((c) => `<tr>
    <td>${esc(c.candidate)}</td><td class="num">${c.median_ape_pct.toFixed(1)}%</td>
    <td class="num">${c.trimmed_mean_ape_pct.toFixed(1)}%</td><td class="num">${c.wins} / ${c.peers}</td>
    <td class="num">${c.spearman.toFixed(2)}</td><td class="num">${c.log_mae.toFixed(3)}</td>
    <td class="num">${c.within2x_pct.toFixed(1)}%</td>
  </tr>`).join('');
  $('valid').innerHTML = `<strong>The tilt, checked on six metrics:</strong> one pooled regression of log(market cap) on log(TVL) over ${pl.peers} live peers (slope ${pl.slope.toFixed(2)}, R2 ${pl.r2.toFixed(2)}, reference TVL ${money(pl.median_tvl_usd)}). A 5-fold check prices each held-out token two ways - the pooled tilt's median error is ${v.median_ape_sized_pct.toFixed(1)}% against ${v.median_ape_flat_pct.toFixed(1)}% for the flat category median, its log-space error ${v.log_mae_sized.toFixed(3)} against ${v.log_mae_flat.toFixed(3)}, and it ranks the held-out tokens at Spearman ${v.spearman_sized.toFixed(2)} against ${v.spearman_flat.toFixed(2)} flat. It prices ${v.sized_wins} of ${v.peers} tokens closer, and ${v.within2x_sized_pct.toFixed(1)}% of them land within twice their true value (flat: ${v.within2x_flat_pct.toFixed(1)}%). <strong>The full formula</strong> is checked the same way: median error ${v.full_median_ape_sized_pct.toFixed(1)}% vs ${v.full_median_ape_flat_pct.toFixed(1)}% flat, trimmed mean ${v.full_trimmed_mean_ape_sized_pct.toFixed(1)}% vs ${v.full_trimmed_mean_ape_flat_pct.toFixed(1)}%, log error ${v.full_log_mae_sized.toFixed(3)} vs ${v.full_log_mae_flat.toFixed(3)}. Pricing from TVL alone is very noisy either way; the tilt is a small, measured edge, so it is applied at half strength and clamped.`;
  renderByCategory();
  renderCalibration();
  renderAvpPlot();
}
function renderByCategory() {
  const v = R.calibration.tilt_validation;
  $('bycat').innerHTML = v.by_category.map((c) => {
    const wins = c.median_ape_sized_pct < c.median_ape_flat_pct;
    return `<tr>
    <td>${esc(c.category)}</td><td class="num">${c.peers}</td>
    <td class="num">${c.median_ape_flat_pct.toFixed(1)}%</td><td class="num">${c.median_ape_sized_pct.toFixed(1)}%</td>
    <td class="num">${c.sized_wins} / ${c.peers}</td><td>${wins ? 'tilt wins' : 'tilt loses'}</td>
  </tr>`;
  }).join('');
  $('btcat').innerHTML = R.backtest.by_category.map((c) => {
    const verdict = c.median_ape_shipped_pct < c.median_ape_flat_pct && c.median_ape_shipped_pct < c.median_ape_persistence_pct ? 'shipped wins' : c.median_ape_shipped_pct < c.median_ape_flat_pct ? 'beats flat, loses to persistence' : 'shipped loses';
    return `<tr><td>${esc(c.category)}</td><td class="num">${c.peers}</td><td class="num">${c.median_ape_shipped_pct.toFixed(1)}%</td><td class="num">${c.median_ape_flat_pct.toFixed(1)}%</td><td class="num">${c.median_ape_persistence_pct.toFixed(1)}%</td><td class="num">${c.shipped_wins} / ${c.peers}</td><td>${verdict}</td></tr>`;
  }).join('');
}
function renderCalibration() {
  const rep = R.calibration.calibration_report;
  const cal = R.calibration.calibration;
  const v = R.calibration.tilt_validation;
  $('calibtext').innerHTML = cal.identity
    ? `<strong>The calibration:</strong> the log-log fit on the out-of-fold predictions was degenerate (too few pairs or a non-positive slope), so the layer is deliberately an identity - it changes no value. The board below is the raw formula, and the nested validation row for the calibrated formula equals the uncalibrated one.`
    : `<strong>The calibration:</strong> a winsorized log-space line fitted on the out-of-fold full-formula predictions of ${cal.peers} live peers - log(calibrated) = ${cal.slope.toFixed(3)} x log(raw) + ${cal.intercept.toFixed(3)} (R2 ${cal.r2.toFixed(2)}), training predictions clipped to [${cal.winsor_lo.toFixed(2)}, ${cal.winsor_hi.toFixed(2)}] in log10, every row's shift capped at +-${cal.shift_cap_dex} decades. It improves five of six nested-validation metrics; it does not establish that calibrated values are launch prices. The nested 5-fold measure - each fold's map fitted without that fold's peers - is median error ${v.full_cal_median_ape_pct.toFixed(1)}% vs ${v.full_median_ape_sized_pct.toFixed(1)}% uncalibrated, trimmed mean ${v.full_cal_trimmed_mean_ape_pct.toFixed(1)}% vs ${v.full_trimmed_mean_ape_sized_pct.toFixed(1)}%, log error ${v.full_cal_log_mae.toFixed(3)} vs ${v.full_log_mae_sized.toFixed(3)}, within 2x ${v.full_cal_within2x_pct.toFixed(1)}% vs ${v.full_within2x_sized_pct.toFixed(1)}%.`;
  $('calibtable').innerHTML =
    `<tr><td>Before calibration (raw full formula)</td><td class="num">${rep.oof_log_mae_before.toFixed(3)}</td><td class="num">${rep.oof_median_ape_before_pct.toFixed(1)}%</td><td class="num">${rep.oof_trimmed_mean_ape_before_pct.toFixed(1)}%</td></tr>` +
    `<tr><td>After calibration (fitted view - same predictions the map was fitted on)</td><td class="num">${rep.oof_log_mae_after.toFixed(3)}</td><td class="num">${rep.oof_median_ape_after_pct.toFixed(1)}%</td><td class="num">${rep.oof_trimmed_mean_ape_after_pct.toFixed(1)}%</td></tr>`;
  $('shrunk').innerHTML = rep.most_shrunk.map((s) => `<tr>
    <td><span class="name">${esc(s.name)}</span><span class="sub">${esc(s.slug)}</span></td>
    <td class="num">${money(s.raw_implied_value_usd)}</td>
    <td class="num">${money(s.calibrated_implied_value_usd)}</td>
    <td class="num">${shiftText(s.shift_dex)}</td>
  </tr>`).join('');
}

function renderAvpPlot() {
  const v = R.calibration.tilt_validation;
  const pairs = v.heldout_pairs || [];
  const host = $('avp-plot');
  if (!host) return;
  if (pairs.length === 0) { host.innerHTML = '<p class="note">No held-out pairs in data.js.</p>'; return; }
  const W = 680, H = 440, ML = 64, MR = 16, MT = 14, MB = 52;
  let lo = Infinity, hi = -Infinity;
  for (const p of pairs) for (const val of [p.raw, p.calibrated, p.actual]) { const l = Math.log10(val); if (l < lo) lo = l; if (l > hi) hi = l; }
  lo = Math.floor(lo); hi = Math.ceil(hi);
  const x = (val) => ML + ((Math.log10(val) - lo) / (hi - lo)) * (W - ML - MR);
  const y = (val) => MT + (1 - (Math.log10(val) - lo) / (hi - lo)) * (H - MT - MB);
  const line = (a, b, cls) => `<line x1="${x(a).toFixed(1)}" y1="${y(a).toFixed(1)}" x2="${x(b).toFixed(1)}" y2="${y(b).toFixed(1)}" class="${cls}"/>`;
  const top = Math.pow(10, hi), bottom = Math.pow(10, lo);
  let grid = '';
  for (let d = lo; d <= hi; d++) {
    const val = Math.pow(10, d);
    grid += `<line x1="${x(val).toFixed(1)}" y1="${y(top).toFixed(1)}" x2="${x(val).toFixed(1)}" y2="${y(bottom).toFixed(1)}" class="avp-grid"/>` +
      `<line x1="${x(bottom).toFixed(1)}" y1="${y(val).toFixed(1)}" x2="${x(top).toFixed(1)}" y2="${y(val).toFixed(1)}" class="avp-grid"/>` +
      `<text x="${x(val).toFixed(1)}" y="${(H - MB + 18).toFixed(1)}" class="avp-axis">${moneyShort(val)}</text>` +
      `<text x="${(ML - 8).toFixed(1)}" y="${(y(val) + 4).toFixed(1)}" class="avp-axis avp-y">${moneyShort(val)}</text>`;
  }
  let dots = '';
  for (const p of pairs) {
    dots += `<circle cx="${x(p.actual).toFixed(1)}" cy="${y(p.raw).toFixed(1)}" r="3.2" class="avp-raw"/>` +
      `<circle cx="${x(p.actual).toFixed(1)}" cy="${y(p.calibrated).toFixed(1)}" r="3.2" class="avp-cal"/>`;
  }
  const rawIn2x = pairs.filter((p) => p.raw >= p.actual / 2 && p.raw <= p.actual * 2).length;
  const calIn2x = pairs.filter((p) => p.calibrated >= p.actual / 2 && p.calibrated <= p.actual * 2).length;
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Actual vs predicted market cap, log scale, ${pairs.length} held-out live tokens">` +
    grid + line(bottom, top, 'avp-one') + line(bottom / 2, top / 2, 'avp-bound') + line(bottom * 2, top * 2, 'avp-bound') + dots +
    `<text x="${(W / 2).toFixed(1)}" y="${(H - 8).toFixed(1)}" class="avp-label">true market cap (log scale)</text>` +
    `<text x="14" y="${(H / 2).toFixed(1)}" class="avp-label avp-y-label" transform="rotate(-90 14 ${(H / 2).toFixed(1)})">predicted value (log scale)</text></svg>` +
    `<p class="avp-legend"><span class="avp-key avp-key-raw">o</span> raw full formula - Spearman ${v.full_spearman_sized.toFixed(3)}, ${rawIn2x} of ${pairs.length} within 2x &nbsp; <span class="avp-key avp-key-cal">&#9679;</span> nested-calibrated - Spearman ${v.full_cal_spearman.toFixed(3)}, ${calIn2x} of ${pairs.length} within 2x</p>`;
}
function loadState() {
  $('meta').textContent = `Snapshot ${R.as_of} · ${R.source} · floor ${money(R.floor_usd)} · model ${R.model_version}`;
  $('src').textContent = `${R.source} (as of ${R.as_of})`;
}
function renderStats() {
  const top = R.rows[0];
  const median = R.rows[Math.floor(R.rows.length / 2)];
  const hotN = R.rows.filter((r) => (r.change_7d ?? 0) >= 20).length;
  $('stats').innerHTML =
    `<div class="stat"><div class="stat-n">${money(top.implied_value_usd)}</div><div class="stat-l">top implied value - ${esc(top.name)}</div></div>` +
    `<div class="stat"><div class="stat-n">${money(median.implied_value_usd)}</div><div class="stat-l">median implied value</div></div>` +
    `<div class="stat"><div class="stat-n">${R.rows.length}</div><div class="stat-l">protocols scored</div></div>` +
    `<div class="stat"><div class="stat-n">${hotN}</div><div class="stat-l">heating up (7d &gt;= 20%)</div></div>`;
}
function initFilters() {
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
  const cats = [...new Set(R.rows.map((r) => r.category || 'Uncategorised'))].sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const topChains = (R.chain_totals || []).slice(0, 8).map((c) => c.chain);
  $('chainpills').innerHTML = '<button type="button" data-chain="" class="active">All chains</button>' + topChains.map((c) => `<button type="button" data-chain="${esc(c)}">${esc(c)}</button>`).join('');
  $('chainpills').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-chain]');
    if (!b) return;
    $('chain').value = b.dataset.chain;
    document.querySelectorAll('#chainpills button').forEach((x) => x.classList.toggle('active', x === b));
    renderBoard();
  });
  $('rows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-slug]');
    if (btn) location.hash = '#/protocol/' + btn.dataset.slug;
  });
  document.querySelectorAll('#viewpills button').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('#viewpills button').forEach((x) => x.classList.toggle('active', x === b));
    renderBoard();
  }));
}
function splitStep(s) {
  const m = s.match(/^(.*?) Cost: (.*?)\. Time: (.*?)\.?$/);
  if (!m) return { text: s, cost: '', time: '' };
  return { text: m[1], cost: m[2], time: m[3] };
}
function calibEntry(r) { return R.calibration.categories.find((c) => c.category === (r.category || 'Uncategorised')); }
function calibPeers(r) { return calibEntry(r)?.peers ?? 0; }
function calibFallback(r) { return calibEntry(r)?.fallback ?? true; }
function drawChart(canvas, series) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth * 2 || 1400, H = canvas.height = 480;
  ctx.clearRect(0, 0, W, H);
  const lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const px = (i) => 70 + (i / (series.length - 1)) * (W - 90);
  const py = (v) => 30 + (1 - (v - lo) / span) * (H - 70);
  ctx.strokeStyle = '#1d2634'; ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) { const yv = 30 + (g / 3) * (H - 70); ctx.beginPath(); ctx.moveTo(70, yv); ctx.lineTo(W - 20, yv); ctx.stroke(); }
  ctx.fillStyle = '#7e8ba1'; ctx.font = '22px monospace'; ctx.textAlign = 'left';
  ctx.fillText(money(hi), 8, 40); ctx.fillText(money(lo), 8, H - 44);
  ctx.beginPath(); series.forEach((v, i) => { if (i === 0) ctx.moveTo(px(i), py(v)); else ctx.lineTo(px(i), py(v)); });
  ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 3; ctx.stroke();
  ctx.lineTo(px(series.length - 1), H - 40); ctx.lineTo(px(0), H - 40); ctx.closePath();
  ctx.fillStyle = 'rgba(45,212,191,0.10)'; ctx.fill();
  const last = series[series.length - 1];
  ctx.beginPath(); ctx.arc(px(series.length - 1), py(last), 7, 0, 7); ctx.fillStyle = '#2dd4bf'; ctx.fill();
}
function openDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const tvl = r.tvl_usd;
  const base = tvl * r.fitted_multiple;
  const series = (R.series || {})[r.slug] || [tvl];
  let buys = 0, sells = 0;
  for (let i = 1; i < series.length; i++) { if (series[i] > series[i - 1]) buys++; else if (series[i] < series[i - 1]) sells++; }
  const flow = { buys, sells, net: series[series.length - 1] - series[0] };
  const steps = r.farm_steps.map((s) => {
    const p = splitStep(s);
    return `<li>${esc(p.text)}<br><span class="ct">Cost: ${esc(p.cost)} · Time: ${esc(p.time)}</span></li>`;
  }).join('');
  const basis = R.calibration.category_basis.find((c) => c.category === (r.category || 'Uncategorised'));
  const pl = R.calibration.power_law;
  const fitLine = `Size tilt: one pooled fit on all ${pl.peers} live-token peers (slope ${pl.slope.toFixed(2)}, damped ${pl.slope_damped.toFixed(2)}, R2 ${pl.r2.toFixed(2)}), measured against the market's median live TVL of ${money(pl.median_tvl_usd)}. Per-category fits were tested and rejected - they lose to this fit on five of six validation checks, so no category carries its own slope.`;
  const catVal = R.calibration.tilt_validation.by_category.find((c) => c.category === (r.category || 'Uncategorised'));
  const tiltLine = !catVal ? '' : `<p>In ${esc(r.category || 'Uncategorised')} the tilt ${catVal.median_ape_sized_pct < catVal.median_ape_flat_pct ? 'wins' : 'loses'} the median-error comparison on ${catVal.peers} live-token peer${catVal.peers === 1 ? '' : 's'} (${catVal.median_ape_sized_pct.toFixed(1)}% vs ${catVal.median_ape_flat_pct.toFixed(1)}% flat; ${catVal.sized_wins} of ${catVal.peers} priced closer). See the per-category table in The model.</p>`;
  const basisHtml = !basis ? '' : `
    <h3>Peer basis - the live tokens this multiple stands on</h3>
    <p>${calibFallback(r)
      ? `Only ${basis.peers.length} live-token peer${basis.peers.length === 1 ? '' : 's'} in this category - too few for its own median - so the multiple borrows the whole-market median (${r.category_multiple.toFixed(3)}x). Quartiles ${basis.q1.toFixed(3)}x / ${basis.median.toFixed(3)}x / ${basis.q3.toFixed(3)}x (Q1 / median / Q3).`
      : `The category multiple is the median market-cap / TVL of these ${basis.peers.length} live-token peer${basis.peers.length === 1 ? '' : 's'} in ${esc(r.category || 'Uncategorised')}. Quartiles ${basis.q1.toFixed(3)}x / ${basis.median.toFixed(3)}x / ${basis.q3.toFixed(3)}x (Q1 / median / Q3).`} ${esc(fitLine)}</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">mcap / TVL</th></tr></thead>
      <tbody>${basis.peers.map((p) => `<tr>
      <td><span class="name">${esc(p.name)}</span><span class="sub">${esc(p.slug)}</span></td>
      <td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td>
      <td class="num">${p.ratio.toFixed(3)}x</td>
    </tr>`).join('')}</tbody>
    </table></div>`;
  const calLine = r.calibration_shift_dex === 0
    ? `Calibration: no shift - the raw value stands as priced.`
    : `Calibration: ${money(r.raw_implied_value_usd)} raw -&gt; ${money(r.implied_value_usd)} calibrated, a shift of ${r.calibration_shift_dex > 0 ? '+' : ''}${r.calibration_shift_dex.toFixed(2)} decades - a correction to the formula's spread, not a claim that the calibrated value is what the market would pay.`;
  const tradesRows = series.slice(-10).map((v, i) => {
    const idx = series.length - 10 + i;
    const prev = idx > 0 ? series[idx - 1] : series[0];
    const d = v - prev;
    return `<tr><td class="num">day ${idx - 29}</td><td class="num">${money(v)}</td><td class="num ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${money(Math.abs(d))}</td><td class="${d >= 0 ? 'up' : 'down'}">${idx === 0 ? 'OPEN' : d >= 0 ? 'BUY' : 'SELL'}</td></tr>`;
  }).join('');
  const tfRow = (label, val, na) => `<div><span>${esc(label)}</span><span class="${na ? 'na' : 'ok'}">${esc(val)}</span></div>`;
  const naNote = 'not in snapshot';
  const tf = [['Token status', 'records no token', 0], ['Symbol', naNote, 1], ['Holders', naNote, 1], ['Total supply', naNote, 1], ['Circulating supply', naNote, 1], ['Fundraising', naNote, 1], ['Tokenomics', naNote, 1], ['Unlock schedule', naNote, 1], ['Chains', r.chains.join(', ') || 'none listed', 0], ['Category', r.category || 'none listed', 0], ['Listed since', r.listed_at || 'unknown', 0], ['TVL', money(tvl), 0], ['TVL change, 7 days', pct(r.change_7d), 0], ['Implied value', money(r.implied_value_usd), 0]];
  $('detail-body').innerHTML = `
    <h2>${esc(r.name)} <span class="sub">#${r.rank} · ${esc(r.slug)}</span></h2>
    <p>${esc(r.category || 'Uncategorised')} · ${r.chains.map(esc).join(', ') || 'no chain listed'} · tracked since ${esc(r.listed_at || 'unknown date')} (${ageText(r.age_days)}).
    DefiLlama's record carries no token for this protocol - that is the record, not proof it has none.</p>
    <div class="chartbox"><canvas id="dchart" aria-label="Modeled TVL path for ${esc(r.name)}"></canvas>
    <p class="chartnote"><b>MODELED PATH</b> - 30 points from the snapshot's 7-day change (${pct(r.change_7d)}), seeded by the protocol slug, ending at today's TVL ${money(tvl)}. Illustrative, not market data: the snapshot holds one TVL per protocol, not a history.</p>
    <p class="flow">Modeled flow: <b>${flow.buys} buys / ${flow.sells} sells</b> across the 30 modeled points, net <b>${flow.net >= 0 ? '+' : ''}${money(Math.abs(flow.net))}</b>. Up steps read as buys, down steps as sells; derived from the modeled path, not exchange data.</p></div>
    <div class="tokenfile">
      ${tf.map((x) => tfRow(x[0], x[1], x[2])).join('')}
    </div>
    <p class="note">Token file: the sealed snapshot carries 10 fields per protocol. Fields marked "not in snapshot" are not in it, so the radar shows the gap instead of inventing a number.</p>
    <div class="facts">
      <div><b>${money(r.implied_value_usd)}</b><span>implied launch value</span></div>
      <div><b>${money(tvl)}</b><span>TVL</span></div>
      <div><b>${pct(r.change_7d)}</b><span>TVL change, 7 days</span></div>
      <div><b>${r.fitted_multiple.toFixed(3)}x</b><span>fitted multiple</span></div>
      <div><b>${r.growth_multiplier.toFixed(2)}x</b><span>growth</span></div>
      <div><b>${r.maturity_multiplier.toFixed(2)}x</b><span>maturity</span></div>
      <div><b>${r.chain_multiplier.toFixed(2)}x</b><span>chain reach</span></div>
    </div>
    <div class="dtabs" id="dtabs">
      <button data-dtab="trades" class="active" type="button">Trades</button>
      <button data-dtab="positions" type="button">Positions</button>
      <button data-dtab="holders" type="button">Holders</button>
      <button data-dtab="traders" type="button">Top Traders</button>
      <button data-dtab="farm" type="button">Farm</button>
      <button data-dtab="model" type="button">Model</button>
    </div>
    <div class="dpanel active" id="dp-trades">
      <h3>Trades - modeled flow, last 10 points</h3>
      <div class="tablewrap"><table><thead><tr><th class="num">Point</th><th class="num">Modeled TVL</th><th class="num">Step change</th><th>Side</th></tr></thead><tbody>${tradesRows}</tbody></table></div>
      <p class="note">Modeled from the 30-point path above, illustrative only.</p>
    </div>
    <div class="dpanel" id="dp-positions">
      <h3>Positions - the farm position this plan opens</h3>
      <ol class="steps">${r.farm_steps.slice(0, 2).map((s) => { const p = splitStep(s); return `<li>${esc(p.text)}<br><span class="ct">Cost: ${esc(p.cost)} · Time: ${esc(p.time)}</span></li>`; }).join('')}${r.farm_steps.slice(4, 5).map((s) => { const p = splitStep(s); return `<li>${esc(p.text)}<br><span class="ct">Cost: ${esc(p.cost)} · Time: ${esc(p.time)}</span></li>`; }).join('')}</ol>
      <p class="note">Full plan is under the Farm tab. One position per protocol, in the same wallet, held long enough to count in more than one snapshot.</p>
    </div>
    <div class="dpanel" id="dp-holders">
      <h3>Holders</h3>
      <div class="empty">Holder counts are not in the snapshot. Holders is not one of the snapshot's 10 fields, so this panel stays empty rather than inventing a number.</div>
    </div>
    <div class="dpanel" id="dp-traders">
      <h3>Top Traders</h3>
      <div class="empty">Trader identities and volumes are not in the snapshot, so there is no top-trader table to show. The Trades tab shows only the modeled flow from the snapshot's 7-day change.</div>
    </div>
    <div class="dpanel" id="dp-farm">
      <h3>Farm plan - seven steps</h3>
      <ol class="steps">${steps}</ol>
      <p class="note">Costs are the plan's own estimates in gas and capital for this protocol's own chain; they move with the chain. Never pay to claim: a real claim costs gas only, from the protocol's own page.</p>
    </div>
    <div class="dpanel" id="dp-model">
      <h3>How the value is built</h3>
      <div class="breakdown">${money(tvl)} TVL x ${r.fitted_multiple.toFixed(3)} fitted multiple x ${r.growth_multiplier.toFixed(2)} growth x ${r.maturity_multiplier.toFixed(2)} maturity x ${r.chain_multiplier.toFixed(2)} chains = ${money(r.raw_implied_value_usd)} raw
      <div class="bar" style="width:${Math.min(100, (r.implied_value_usd / R.rows[0].implied_value_usd) * 100).toFixed(1)}%"></div>
      Fitted ${r.fitted_multiple.toFixed(3)}x = ${r.category_multiple.toFixed(3)}x ${esc(r.category || 'market')} median x ${r.size_tilt.toFixed(2)} size tilt. The tilt is the pooled fit (${esc(r.size_tilt_basis)}, R2 ${r.size_tilt_r2.toFixed(2)}). Base ${money(base)} · the category multiple is ${calibFallback(r) ? 'the whole-market median (too few live-token peers in this category)' : `the median market-cap/TVL of ${calibPeers(r)} live-token peer${calibPeers(r) === 1 ? '' : 's'} in this category`}.
      <div class="calibline">${esc(calLine)}</div></div>
      ${basisHtml}
      ${tiltLine}
    </div>`;
  $('detail').hidden = false;
  document.querySelectorAll('#dtabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#dtabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.dpanel').forEach((p) => p.classList.toggle('active', p.id === 'dp-' + b.dataset.dtab));
  }));
  drawChart($('dchart'), series);
  $('detail').scrollIntoView({ behavior: 'auto', block: 'start' });
}
function closeDetail() {
  $('detail').hidden = true;
  if (location.hash.startsWith('#/protocol/')) history.replaceState(null, '', '#');
}
function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}
function route() {
  const m = location.hash.match(/^#\/protocol\/(.+)$/);
  if (m) { switchTab('board'); openDetail(decodeURIComponent(m[1])); }
  else $('detail').hidden = true;
}
function renderSandbox() {
  const gw = parseFloat($('sb-growth').value);
  const mw = parseFloat($('sb-mat').value);
  const ts = parseFloat($('sb-tilt').value);
  const cap = parseFloat($('sb-cap').value);
  const cs = parseFloat($('sb-cal').value);
  $('sb-growth-v').textContent = gw.toFixed(2);
  $('sb-mat-v').textContent = mw.toFixed(2);
  $('sb-tilt-v').textContent = ts.toFixed(2);
  $('sb-cap-v').textContent = cap.toFixed(2);
  $('sb-cal-v').textContent = cs.toFixed(2);
  const scored = R.rows.map((r) => {
    const growth = 1 + (Math.min(100, Math.max(-50, r.change_7d ?? 0)) / 100) * gw;
    const age = r.age_days ?? 365;
    const mat = (1 - mw) + (Math.min(Math.max(age, 0), 1095) / 1095) * mw;
    const tilt = 1 + (r.size_tilt - 1) * ts;
    const mult = Math.min(r.category_multiple * tilt, cap);
    const raw = Math.max(1, Math.round(r.tvl_usd * mult * growth * mat * r.chain_multiplier));
    const v = Math.max(1, Math.round(raw * Math.pow(10, cs * (r.calibration_shift_dex ?? 0))));
    return { r, v };
  }).sort((a, b) => b.v - a.v).slice(0, 10);
  $('sb-top').innerHTML = scored.map((s, i) => `<li>#${i + 1} ${esc(s.r.name)} - ${money(s.v)} (published rank ${s.r.rank})</li>`).join('');
}
function init() {
  if (!R || !R.rows) {
    document.querySelector('main').innerHTML = '<p>data.js did not load: open this page from the built output, where data.js sits beside dashboard/.</p>';
    return;
  }
  loadState();
  renderStats();
  renderTickers();
  renderPicks();
  renderModelStrip();
  initFilters();
  renderBoard();
  renderLive();
  renderNews();
  renderCalib();
  renderSandbox();
  ['q', 'chain', 'cat', 'sort'].forEach((id) => $(id).addEventListener('input', renderBoard));
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('detail-close').addEventListener('click', closeDetail);
  ['sb-growth', 'sb-mat', 'sb-tilt', 'sb-cap', 'sb-cal'].forEach((id) => $(id).addEventListener('input', renderSandbox));
  window.addEventListener('hashchange', route);
  route();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
