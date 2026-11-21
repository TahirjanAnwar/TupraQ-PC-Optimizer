'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = b => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 2 : 1) : b) + ' ' + u[i]; };
async function api(p, body) {
  const r = await fetch(p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'X-TupraQ-Token': window.TQ_TOKEN, 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; $('#toast').appendChild(t); setTimeout(() => t.remove(), 6000); }

let info = { admin: false, cats: [], settings: { theme: 'cyber', voice: true } };
let settings = info.settings;

// ================= VOICE =================
const PHRASES = {
  clean: 'Sir, the cleaning is done.', optimize: 'Sir, the optimizing is done.', scan: 'Sir, the security scan is done.',
  update: 'Sir, the updating is done.', analyze: 'Sir, the analysis is done.', check: 'Sir, the update check is done.',
  fail: 'Sir, the task could not be completed.', test: 'Sir, the cleaning and optimizing is done.', speed: 'Sir, the speed test is done.',
};
try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => {}; } catch {}
function chime() {
  const a = new AudioContext();
  [[784, 0], [1047, .13], [1568, .26]].forEach(([f, t]) => {
    const o = a.createOscillator(), g = a.createGain(), s = a.currentTime + t;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, s); g.gain.linearRampToValueAtTime(.2, s + .02); g.gain.exponentialRampToValueAtTime(.0001, s + .45);
    o.connect(g).connect(a.destination); o.start(s); o.stop(s + .5);
  });
  setTimeout(() => a.close(), 1500);
}
function speak(key, force) {
  if (!settings.voice && !force) return;
  try { chime(); } catch {}
  const fallback = () => api('/api/speak', { key }).catch(() => {});
  setTimeout(() => {
    let vs = [];
    try { vs = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)); } catch {}
    const v = vs.find(v => /Ryan|George|Thomas/i.test(v.name)) || vs.find(v => /Guy|David|Mark|Andrew|Brian|Christopher/i.test(v.name)) || vs[0];
    if (!v) return fallback();
    const u = new SpeechSynthesisUtterance(PHRASES[key]);
    u.voice = v; u.lang = v.lang; u.rate = .95; u.pitch = .9;
    let started = false; u.onstart = () => { started = true; }; u.onerror = () => { if (!started) fallback(); };
    speechSynthesis.cancel(); speechSynthesis.speak(u);
    setTimeout(() => { if (!started) { try { speechSynthesis.cancel(); } catch {} fallback(); } }, 2500);
  }, 550);
}

// ================= JOBS =================
const VOICE = { junkScan: 'analyze', clean: 'clean', boost: 'optimize', optimizeAll: 'optimize', avScan: 'scan', avUpdate: 'update', updScan: 'check', updInstall: 'update', appScan: 'check', appUpgrade: 'update', netTest: 'speed', pcTest: 'speed', selfUpdate: 'update' };
let liveCb = null;
let busy = false;
const logEl = $('#log');
function setBusy(b) { busy = b; document.body.classList.toggle('busy', b); $('#jobCancel').hidden = !b; }
function setProgress(p) { const bar = $('.bar'); if (p == null) { bar.classList.add('ind'); } else { bar.classList.remove('ind'); $('#jobBar').style.width = Math.round(p * 100) + '%'; } }
async function follow(startLen) {
  let since = startLen || 0;
  for (;;) {
    await new Promise(r => setTimeout(r, 500));
    let j; try { j = (await api('/api/job?since=' + since)).job; } catch { continue; }
    if (!j) return null;
    if (j.log.length) { logEl.textContent += j.log.join('\n') + '\n'; logEl.scrollTop = logEl.scrollHeight; since = j.logLen; }
    if (j.live && liveCb) liveCb(j.live);
    if (j.status === 'running') { setProgress(j.progress); continue; }
    return j;
  }
}
async function run(type, opts) {
  if (busy) return null;
  setBusy(true); logEl.textContent = ''; setProgress(null);
  let j = null;
  try {
    const s = await api('/api/run', { type, opts: opts || {} });
    $('#jobTitle').textContent = s.title;
    j = await follow(0);
  } catch (e) { logEl.textContent += 'ERROR: ' + e.message + '\n'; }
  setBusy(false); $('.bar').classList.remove('ind');
  const ok = j && j.status === 'done' && !(j.result && j.result.failed);
  $('#jobBar').style.width = ok ? '100%' : '0';
  $('#jobTitle').textContent = !j ? 'FAILED' : j.status === 'cancelled' ? 'CANCELLED' : ok ? 'DONE – ' + j.title : 'FINISHED WITH ERRORS';
  if (j && j.status === 'cancelled') return null;
  speak(ok ? VOICE[type] : 'fail');
  if (!ok) toast('The task could not be completed. See the log below.', true);
  return ok ? j.result || {} : null;
}
$('#jobCancel').onclick = () => api('/api/cancel', {}).catch(() => {});

// ================= NAV =================
const TITLES = { dash: 'Dashboard', clean: 'Deep Clean', boost: 'Speed Boost', av: 'Antivirus', upd: 'Drivers & Updates', speed: 'Speed Test', theme: 'Settings' };
const onShow = {};
function go(page) {
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + page));
  $('#pageTitle').textContent = TITLES[page];
  if (onShow[page]) onShow[page]();
}
$$('#nav button').forEach(b => b.onclick = () => go(b.dataset.page));
$$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

// ================= STATS =================
const C = 207.3;
function gauge(id, pct) { const el = $('#' + id); el.style.strokeDashoffset = C * (1 - pct / 100); el.style.stroke = pct > 90 ? 'var(--bad)' : pct > 75 ? 'var(--warn)' : 'var(--accent)'; $('#' + id + 'T').textContent = pct + '%'; }
async function pollStats() {
  try {
    const s = await api('/api/stats');
    const ram = Math.round(100 * (1 - s.ramFree / s.ramTotal));
    const d = s.disks[0], disk = d ? Math.round(100 * (1 - d.free / d.total)) : 0;
    $('#cCpu').textContent = s.cpu + '%'; $('#cRam').textContent = ram + '%'; $('#cDisk').textContent = d ? fmt(d.free) + ' free' : '–';
    gauge('gCpu', s.cpu); gauge('gRam', ram); gauge('gDisk', disk);
  } catch {}
}

// ================= DASHBOARD =================
$('#btnOptimize').onclick = async () => {
  const r = await run('optimizeAll');
  if (r) { const m = `Freed ${fmt(r.freed || 0)} · ${(r.threats || []).length ? r.threats.length + ' threat(s) handled' : 'no threats found'}`; $('#dashNote').textContent = 'Last optimization: ' + m; toast('Optimization complete. ' + m); cleanScan = null; renderCats(); }
};

// ================= CLEAN =================
let cleanScan = null;
function renderCats() {
  $('#catList').innerHTML = info.cats.map(c => {
    const s = cleanScan && cleanScan[c.id];
    return `<label class="item"><input type="checkbox" class="ck" data-cat="${c.id}" ${c.def ? 'checked' : ''}><span class="txt"><b>${esc(c.name)}</b><i>${esc(c.desc)}</i></span><span class="size">${s ? fmt(s.size) : '—'}</span></label>`;
  }).join('');
  $$('#catList .ck').forEach(k => k.onchange = cleanTotal);
  cleanTotal();
}
function cleanTotal() {
  $('#btnClean').disabled = !cleanScan;
  if (!cleanScan) { $('#cleanTotal').textContent = 'run Analyze first'; return; }
  let t = 0; $$('#catList .ck').forEach(k => { if (k.checked && cleanScan[k.dataset.cat]) t += cleanScan[k.dataset.cat].size; });
  $('#cleanTotal').textContent = fmt(t);
}
$('#btnAnalyze').onclick = async () => {
  const keep = {}; $$('#catList .ck').forEach(k => keep[k.dataset.cat] = k.checked);
  const r = await run('junkScan'); if (!r) return;
  cleanScan = {}; r.cats.forEach(c => cleanScan[c.id] = c);
  renderCats(); $$('#catList .ck').forEach(k => k.checked = keep[k.dataset.cat]); cleanTotal();
  toast('Analysis complete: ' + fmt(r.cats.reduce((a, c) => a + c.size, 0)) + ' of junk found.');
};
$('#btnClean').onclick = async () => {
  const ids = $$('#catList .ck').filter(k => k.checked).map(k => k.dataset.cat);
  if (!ids.length) return toast('Select at least one category.', true);
  const r = await run('clean', { ids }); if (!r) return;
  toast('Cleaning done. Freed ' + fmt(r.freed) + '.'); $('#dashNote').textContent = 'Last clean freed ' + fmt(r.freed) + '.';
  cleanScan = null; renderCats();
};

// ================= BOOST =================
$('#btnBoost').onclick = async () => {
  const o = { ram: $('#bRam').checked, dns: $('#bDns').checked, power: $('#bPower').checked, drive: $('#bDrive').checked };
  if (!o.ram && !o.dns && !o.power && !o.drive) return toast('Turn on at least one option.', true);
  if (await run('boost', o)) toast('Boost complete.');
};
async function loadStartup() {
  const el = $('#startupList'); el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { items } = await api('/api/startup');
    if (!items.length) { el.innerHTML = '<div class="empty">No startup apps found.</div>'; return; }
    el.innerHTML = items.map((s, i) => `<div class="item"><span class="txt"><b>${esc(s.name.replace(/\.lnk$/i, ''))}</b><i title="${esc(s.cmd)}">${esc(s.cmd)}</i></span>${s.scope === 'HKLM' ? '<span class="tagx">all users</span>' : ''}<span class="sw"><input type="checkbox" data-i="${i}" ${s.enabled ? 'checked' : ''}><i></i></span></div>`).join('');
    $$('#startupList input').forEach(k => k.onchange = async () => {
      const s = items[+k.dataset.i];
      try { const r = await api('/api/startup/set', { scope: s.scope, kind: s.kind, name: s.name, enabled: k.checked }); if (!r.ok) throw new Error(s.scope === 'HKLM' && !info.admin ? 'Administrator mode is needed for this one.' : (r.error || 'Could not change it.')); toast(s.name.replace(/\.lnk$/i, '') + (k.checked ? ' enabled' : ' disabled') + ' at startup.'); }
      catch (e) { k.checked = !k.checked; toast(e.message, true); }
    });
  } catch (e) { el.innerHTML = '<div class="empty">Could not read startup apps.</div>'; }
}
$('#btnStartupRefresh').onclick = loadStartup;
onShow.boost = () => { if (!onShow.boost.done) { onShow.boost.done = true; loadStartup(); } };

// ================= ANTIVIRUS =================
async function loadAv() {
  try {
    const a = await api('/api/av');
    const t = (label, val, cls) => `<div class="tile"><span>${label}</span><b class="${cls || ''}">${esc(val)}</b></div>`;
    if (a.tiles) {
      $('#avTiles').innerHTML = a.tiles.map(x => t(esc(x[0]), x[1], x[2])).join('');
    } else if (!a.ok) {
      $('#avTiles').innerHTML = t('Microsoft Defender', 'Not available', 'warn') + t('Installed antivirus', (a.products || []).join(', ') || 'Unknown');
    } else {
      $('#avTiles').innerHTML = t('Protection', a.enabled ? 'Active' : 'Off', a.enabled ? 'good' : 'badc') + t('Real-time shield', a.realtime ? 'On' : 'Off', a.realtime ? 'good' : 'badc')
        + t('Definitions', a.sigDate || 'Unknown') + t('Last quick scan', a.quick || 'Never') + t('Last full scan', a.full || 'Never') + t('Installed antivirus', (a.products || []).join(', ') || 'Microsoft Defender');
    }
    const th = a.threats || [];
    $('#avThreats').innerHTML = th.length ? `<div class="sub">Active threats</div><div class="list">${th.map(x => `<div class="item"><span class="txt"><b class="badc">${esc(x)}</b></span></div>`).join('')}</div>` : (a.ok ? '<p class="note" style="margin-top:12px">No active threats.</p>' : '');
  } catch { $('#avTiles').innerHTML = '<div class="empty">Could not read protection status.</div>'; }
}
onShow.av = loadAv;
const avRun = async mode => { const r = await run('avScan', { mode }); loadAv(); if (r) toast(r.threats && r.threats.length ? r.threats.length + ' threat(s) found and handled.' : 'Scan complete. No threats found.'); };
$('#btnAvQuick').onclick = () => avRun('quick');
$('#btnAvFull').onclick = () => avRun('full');
$('#btnAvUpdate').onclick = async () => { if (await run('avUpdate')) toast('Virus definitions updated.'); loadAv(); };

// ================= UPDATES =================
function renderUpd(r) {
  const ups = (r.updates || []).sort((a, b) => a.type.localeCompare(b.type));
  $('#updList').innerHTML = ups.length ? ups.map(u => `<label class="item"><input type="checkbox" class="ck" data-id="${esc(u.id)}" ${u.type === 'driver' || isMac ? 'checked' : ''}><span class="txt"><b>${esc(u.title)}</b><i>${u.size ? fmt(u.size) : ''}</i></span><span class="tagx">${u.type === 'driver' ? 'driver' : isMac ? 'macos' : 'windows'}</span></label>`).join('')
    : `<div class="empty">${r.error ? (isMac ? 'Software Update' : 'Windows Update') + ' could not be reached: ' + esc(r.error) : 'Everything is up to date. No driver or system updates are waiting.'}</div>`;
  const upBtn = () => { $('#btnUpdInstall').disabled = !$$('#updList .ck').some(k => k.checked); };
  $$('#updList .ck').forEach(k => k.onchange = upBtn); upBtn();
  let h = '';
  if ((r.problems || []).length) h += `<div class="sub">Devices with problems</div><div class="list">${r.problems.map(p => `<div class="item"><span class="txt"><b class="warn">${esc(p.name || 'Unknown device')}</b><i>Device Manager error code ${p.code}</i></span></div>`).join('')}</div>`;
  else if (!isMac) h += '<p class="note" style="margin-top:12px">All hardware devices are working properly.</p>';
  if ((r.drivers || []).length) h += `<div class="sub">Installed drivers (oldest first)</div><div class="list">${r.drivers.slice(0, 25).map(d => `<div class="item"><span class="txt"><b>${esc(d.name)}</b><i>${esc(d.vendor)} · v${esc(d.ver)}</i></span><span class="size">${esc(d.date)}</span></div>`).join('')}</div>`;
  $('#updExtra').innerHTML = h;
}
$('#btnUpdScan').onclick = async () => { const r = await run('updScan'); if (r) { renderUpd(r); toast((r.updates || []).length + ' update(s) available.'); } };
$('#btnUpdInstall').onclick = async () => {
  const ids = $$('#updList .ck').filter(k => k.checked).map(k => k.dataset.id);
  if (!info.admin) return toast('Installing updates needs administrator mode. Click LIMITED MODE at the bottom left.', true);
  const r = await run('updInstall', { ids }); if (!r) return;
  toast(`${r.installed} installed, ${r.failed} failed.` + (r.reboot ? ' Restart your PC to finish.' : ''));
  $('#updList').innerHTML = '<div class="empty">Press Scan to check again.</div>'; $('#btnUpdInstall').disabled = true;
};
$('#btnAppScan').onclick = async () => {
  const r = await run('appScan'); if (!r) return;
  $('#appList').innerHTML = r.apps.length ? r.apps.map(a => `<div class="item"><span class="txt"><b>${esc(a.name)}</b><i>${esc(a.id)}</i></span><span class="size">${esc(a.ver)} → ${esc(a.avail)}</span></div>`).join('') : '<div class="empty">All apps are up to date.</div>';
  $('#btnAppUp').disabled = !r.apps.length; toast(r.apps.length + ' app update(s) available.');
};
$('#btnAppUp').onclick = async () => { if (await run('appUpgrade')) { toast('App updates finished.'); $('#appList').innerHTML = '<div class="empty">Press Check to list again.</div>'; $('#btnAppUp').disabled = true; } };

// ================= SPEED TESTS =================
const spSet = (id, v, live) => { const el = $('#' + id); el.querySelector('b').textContent = v == null ? '–' : v; el.classList.toggle('live', !!live); };
const mbps = v => v == null ? null : v >= 100 ? Math.round(v) : v.toFixed(1);
$('#btnNetTest').onclick = async () => {
  spSet('spPing', null); spSet('spDown', null); spSet('spUp', null);
  liveCb = l => { spSet('spPing', l.ping, l.phase === 'ping'); spSet('spDown', mbps(l.down), l.phase === 'down'); spSet('spUp', mbps(l.up), l.phase === 'up'); };
  const r = await run('netTest'); liveCb = null;
  $$('.speed').forEach(e => e.classList.remove('live'));
  if (!r) return;
  spSet('spPing', r.ping); spSet('spDown', mbps(r.down)); spSet('spUp', mbps(r.up));
  const n = r.net || {};
  $('#netInfo').textContent = (n.wifi ? [`Wi-Fi “${n.ssid}”`, n.signal && 'signal ' + n.signal, n.rate && 'link ' + n.rate + ' Mbps', [n.radio, n.band].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : 'Wired connection (no Wi-Fi in use)') + ` · jitter ${r.jitter} ms`;
  toast(`Speed test: ${mbps(r.down)} Mbps down · ${mbps(r.up)} Mbps up · ${r.ping} ms ping`);
};
function renderPc(r) {
  $('#pcScore').textContent = r.score; $('#pcRating').textContent = r.rating + ' · 1000 = typical modern PC';
  const rows = [['Single-core', r.parts.single, r.single + ' ops/s'], ['Multi-core', r.parts.multi, r.multi + ' ops/s · ' + r.cores + ' threads'], ['Memory', r.parts.mem, r.mem + ' GB/s'], ['System drive', r.parts.disk, r.dw ? 'W ' + r.dw + ' · R ' + r.dr + ' MB/s' : 'skipped']];
  $('#pcMeters').innerHTML = rows.map(m => `<div class="meter"><span>${m[0]}</span><div class="mb"><i data-w="${Math.min(100, m[1] / 20)}"></i></div><em>${esc(m[2])}</em></div>`).join('');
  requestAnimationFrame(() => $$('#pcMeters i').forEach(i => i.style.width = i.dataset.w + '%'));
}
$('#btnPcTest').onclick = async () => { const r = await run('pcTest'); if (r && r.score != null) { renderPc(r); toast('PC speed test: score ' + r.score + ' (' + r.rating + ').'); } };

// ================= THEMES =================
const THEMES = [
  { id: 'cyber', name: 'Cyber Core', sub: 'Neon grid · default' }, { id: 'hacker', name: 'Hacker', sub: 'Green terminal rain' },
  { id: 'cyberpunk', name: 'Cyberpunk City', sub: 'Neon skyline at night' }, { id: 'vice', name: 'Vice Sunset', sub: 'GTA VI inspired' },
  { id: 'blox', name: 'Blox', sub: 'Roblox inspired' }, { id: 'pixel', name: 'Pixel Quest', sub: '2D pixel game' },
];
function setTheme(id, save) {
  document.documentElement.dataset.theme = id; settings.theme = id; bgState = {};
  $$('.tcard').forEach(c => c.classList.toggle('on', c.dataset.theme === id));
  if (save) api('/api/settings', { theme: id }).catch(() => {});
}
$('#themeGrid').innerHTML = THEMES.map(t => `<button class="tcard" data-theme="${t.id}"><div class="prev"><div class="pp">Tupra<span>Q</span></div><div class="pb">Optimize</div></div><div class="meta"><b>${t.name}</b><i>${t.sub}</i></div></button>`).join('');
$$('.tcard').forEach(c => c.onclick = () => setTheme(c.dataset.theme, true));
$('#setVoice').onchange = e => { settings.voice = e.target.checked; api('/api/settings', { voice: settings.voice }).catch(() => {}); };
$('#btnVoiceTest').onclick = () => speak('test', true);
$('#btnShortcut').onclick = async () => { try { const r = await api('/api/shortcut', {}); toast(r.ok ? 'TupraQ shortcut added to your desktop.' : 'Could not create the shortcut.', !r.ok); } catch { toast('Could not create the shortcut.', true); } };

// ================= ANIMATED BACKGROUNDS =================
const cv = $('#bg'), cx = cv.getContext('2d');
let bgState = {}, W = 0, H = 0;
function resize() { W = cv.width = innerWidth; H = cv.height = innerHeight; bgState = {}; }
addEventListener('resize', resize);
const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const off = (w, h) => { const o = document.createElement('canvas'); o.width = w; o.height = h; return o; };
function grad(c, y0, y1, stops) { const g = c.createLinearGradient(0, y0, 0, y1); stops.forEach(([p, col]) => g.addColorStop(p, col)); return g; }
const BG = {
  cyber(c, t) {
    c.fillStyle = grad(c, 0, H, [[0, '#03060d'], [.58, '#071a30'], [1, '#020409']]); c.fillRect(0, 0, W, H);
    const hz = H * .58, mx = W / 2;
    c.fillStyle = grad(c, hz - 90, hz, [[0, 'rgba(255,43,214,0)'], [1, 'rgba(255,43,214,.28)']]); c.fillRect(0, hz - 90, W, 90);
    c.strokeStyle = 'rgba(23,230,255,.3)'; c.lineWidth = 1; c.beginPath();
    for (let i = -24; i <= 24; i++) { c.moveTo(mx + i * 16, hz); c.lineTo(mx + i * W * .13, H); }
    for (let i = 0; i < 14; i++) { const k = (i + (t * .3) % 1) / 14, y = hz + (H - hz) * k * k; c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
    for (let i = 0; i < 60; i++) { const x = (i * 137.5 + t * 6 * (1 + i % 3)) % W, y = (i * 71.3) % hz; c.fillStyle = `rgba(23,230,255,${.12 + .3 * ((i * 7) % 5) / 5})`; c.fillRect(x, y, 2, 2); }
  },
  hacker(c, t, s) {
    if (!s.cols) { s.cols = Array.from({ length: Math.ceil(W / 16) }, () => Math.random() * -60 | 0); c.fillStyle = '#000'; c.fillRect(0, 0, W, H); s.last = 0; }
    if (t - s.last < .06) return; s.last = t;
    c.fillStyle = 'rgba(0,0,0,.09)'; c.fillRect(0, 0, W, H); c.font = '15px Consolas,monospace';
    s.cols.forEach((y, i) => {
      const ch = String.fromCharCode(Math.random() < .5 ? 0x30A0 + Math.random() * 96 : 0x30 + Math.random() * 10);
      c.fillStyle = Math.random() < .04 ? '#d6ffe6' : 'rgba(0,255,102,.75)'; c.fillText(ch, i * 16, y * 16);
      s.cols[i] = y * 16 > H && Math.random() > .975 ? 0 : y + 1;
    });
  },
  cyberpunk(c, t, s) {
    if (!s.img) {
      const o = s.img = off(W, H), g = o.getContext('2d'), R = rng(11);
      g.fillStyle = grad(g, 0, H, [[0, '#090016'], [.5, '#2a0845'], [.82, '#b0124f'], [1, '#ff5a1f']]); g.fillRect(0, 0, W, H);
      [['#22103d', .62], ['#150826', .5], ['#07020d', .36]].forEach(([col, top], li) => {
        let x = -10;
        while (x < W) {
          const bw = 34 + R() * 80, bh = H * top * (.45 + R() * .6), y = H - bh;
          g.fillStyle = col; g.fillRect(x, y, bw, bh);
          if (R() < .3) g.fillRect(x + bw / 2 - 1, y - 18 - R() * 26, 2, 46);
          const cols = ['#fcee0a', '#00f0ff', '#ff2a6d'];
          for (let wy = y + 8; wy < H - 6; wy += 9) for (let wx = x + 5; wx < x + bw - 6; wx += 8) if (R() < .22 + li * .06) { g.fillStyle = cols[R() * 3 | 0]; g.globalAlpha = .25 + R() * .55; g.fillRect(wx, wy, 4, 5); g.globalAlpha = 1; }
          x += bw + R() * 6;
        }
      });
    }
    c.drawImage(s.img, 0, 0);
    c.strokeStyle = 'rgba(0,240,255,.28)'; c.lineWidth = 1; c.beginPath();
    for (let i = 0; i < 110; i++) { const x = (i * 97.3 + t * 140) % (W + 60) - 30, y = (i * 53.7 + t * (620 + (i % 5) * 90)) % H; c.moveTo(x, y); c.lineTo(x - 4, y + 16); }
    c.stroke();
  },
  vice(c, t, s) {
    const hz = H * .76;
    if (!s.img) {
      const o = s.img = off(W, H), g = o.getContext('2d');
      g.fillStyle = grad(g, 0, hz, [[0, '#1b0b3a'], [.45, '#5a189a'], [.8, '#ff4fa3'], [1, '#ffb347']]); g.fillRect(0, 0, W, hz);
      const sx = W * .6, r = H * .26, sy = hz - r * .25;
      g.save(); g.beginPath();
      let y = sy - r, band = r * .42;
      while (y < hz) { g.rect(sx - r, y, r * 2, Math.min(band, hz - y)); y += band + Math.max(3, (y - (sy - r)) * .035); band *= .72; if (band < 5) band = 5; }
      g.clip(); g.fillStyle = grad(g, sy - r, sy + r, [[0, '#fff275'], [.5, '#ff8c42'], [1, '#ff3c8e']]); g.beginPath(); g.arc(sx, sy, r, 0, 7); g.fill(); g.restore();
      g.fillStyle = grad(g, hz, H, [[0, '#7b2cbf'], [1, '#12002b']]); g.fillRect(0, hz, W, H - hz);
      const palm = (x, ht, lean) => {
        const tx = x + lean, ty = hz + 20 - ht;
        g.strokeStyle = '#14021f'; g.fillStyle = '#14021f'; g.lineCap = 'round'; g.lineWidth = Math.max(5, ht * .035);
        g.beginPath(); g.moveTo(x, H); g.quadraticCurveTo(x + lean * .2, hz - ht * .3, tx, ty); g.stroke();
        for (let i = 0; i < 9; i++) {
          const a = -Math.PI * (.02 + i * .12), L = ht * (.34 + (i % 3) * .05), ex = tx + Math.cos(a) * L, ey = ty + Math.sin(a) * L * .7 + L * .45;
          g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + Math.cos(a) * L * .6, ty + Math.sin(a) * L * .9 - L * .1, ex, ey);
          g.quadraticCurveTo(tx + Math.cos(a) * L * .5, ty + Math.sin(a) * L * .5 + L * .12, tx, ty); g.fill();
        }
      };
      palm(W * .09, H * .62, 40); palm(W * .2, H * .44, -26); palm(W * .93, H * .56, -44);
    }
    c.drawImage(s.img, 0, 0);
    for (let i = 0; i < 16; i++) { const k = i / 16, y = hz + 6 + (H - hz) * k * k, w = W * (.1 + .3 * k) * (.75 + .25 * Math.sin(t * 1.4 + i)); c.fillStyle = `rgba(255,170,120,${.3 - .2 * k})`; c.fillRect(W * .6 - w / 2 + Math.sin(t + i * 2) * 10, y, w, 2); }
  },
  blox(c, t) {
    c.fillStyle = grad(c, 0, H, [[0, '#57b8ff'], [1, '#d9f1ff']]); c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,.9)';
    for (let i = 0; i < 6; i++) { const x = (i * 331 + t * (8 + i * 3)) % (W + 300) - 200, y = 40 + (i * 97) % (H * .45), u = 26 + (i % 3) * 8; c.fillRect(x, y, u * 4, u); c.fillRect(x + u, y - u, u * 2, u); c.fillRect(x + u * 3, y - u * .5, u * 1.6, u * .5); }
    const gy = H - 78; c.fillStyle = '#3fae49'; c.fillRect(0, gy, W, 78); c.fillStyle = '#2f8f3a'; c.fillRect(0, gy, W, 8);
    for (let y = gy + 26; y < H; y += 30) for (let x = 18 + ((y / 30 | 0) % 2) * 15; x < W; x += 30) { c.fillStyle = '#2f8f3a'; c.beginPath(); c.arc(x, y + 2, 8, 0, 7); c.fill(); c.fillStyle = '#56c860'; c.beginPath(); c.arc(x, y, 8, 0, 7); c.fill(); }
  },
  pixel(c, t, s) {
    const pw = 320, ph = Math.max(120, Math.round(320 * H / W));
    if (!s.o || s.o.height !== ph) s.o = off(pw, ph);
    const g = s.o.getContext('2d'), gy = ph - 26;
    ['#3b5dc9', '#3b5dc9', '#41a6f6', '#41a6f6', '#73eff7'].forEach((col, i) => { g.fillStyle = col; g.fillRect(0, i * gy / 5, pw, gy / 5 + 1); });
    g.fillStyle = '#ffcd75'; g.fillRect(250, 22, 22, 22); g.fillStyle = '#fff3c4'; g.fillRect(254, 26, 14, 14);
    g.fillStyle = '#f4f4f4';
    for (let i = 0; i < 5; i++) { const x = Math.floor((i * 83 + t * (3 + i)) % (pw + 60)) - 40, y = 14 + (i * 23) % 60; g.fillRect(x, y, 30, 6); g.fillRect(x + 6, y - 5, 16, 5); g.fillRect(x + 14, y + 6, 12, 3); }
    for (let x = 0; x < pw; x += 2) { const h1 = Math.round((Math.sin(x * .021 + 1) * 12 + Math.sin(x * .007) * 16 + 44) / 4) * 4; g.fillStyle = '#257179'; g.fillRect(x, gy - h1, 2, h1); }
    for (let x = 0; x < pw; x += 2) { const h2 = Math.round((Math.sin(x * .034 + 4) * 8 + Math.sin(x * .011 + 2) * 10 + 22) / 4) * 4; g.fillStyle = '#38b764'; g.fillRect(x, gy - h2, 2, h2); }
    g.fillStyle = '#a7f070'; g.fillRect(0, gy, pw, 4); g.fillStyle = '#38b764'; g.fillRect(0, gy + 4, pw, 4); g.fillStyle = '#5d275d'; g.fillRect(0, gy + 8, pw, ph);
    g.fillStyle = '#3e1a44'; for (let x = 0; x < pw; x += 16) for (let y = gy + 12; y < ph; y += 8) g.fillRect(x + ((y / 8 | 0) % 2) * 8, y, 4, 2);
    c.imageSmoothingEnabled = false; c.drawImage(s.o, 0, 0, W, H);
  },
};
let lastFrame = 0;
function frame(ms) {
  requestAnimationFrame(frame);
  if (document.hidden || ms - lastFrame < 33) return; lastFrame = ms;
  try { (BG[settings.theme] || BG.cyber)(cx, ms / 1000, bgState); } catch {}
}

// ================= SELF UPDATE =================
const HOST = window.chrome && window.chrome.webview ? window.chrome.webview : null; // TupraQ.exe's own window
let updInfo = null;
function openReleases() {
  const page = (updInfo && updInfo.page) || '';
  if (HOST && /^https:\/\/github\.com\//.test(page)) HOST.postMessage('open:' + page);
  else api('/api/update/open', {}).catch(() => {});
}
async function checkUpdate(quiet) {
  const st = $('#updStatus'), btn = $('#btnSelfUpd');
  if (!quiet) { st.textContent = 'Checking GitHub...'; btn.disabled = true; }
  try { updInfo = await api('/api/update/check'); } catch (e) { updInfo = { error: e.message }; }
  btn.disabled = false;
  const u = updInfo;
  if (u.error) { if (!quiet) { st.textContent = 'Could not check for updates: ' + u.error; toast('Could not reach GitHub.', true); } return; }
  $('#updNotes').hidden = !(u.available && u.notes);
  $('#updNotes').textContent = u.notes || '';
  if (u.available) {
    st.textContent = `New version v${u.latest} is available (you have v${u.current}).`;
    btn.textContent = info.selfUpdate && u.asset ? 'Update now' : 'Download';
    $('#updBadge').hidden = false; $('#updBadge').textContent = 'Update v' + u.latest;
    if (quiet) toast(`TupraQ v${u.latest} is available. Open Settings to update.`);
  } else {
    st.textContent = u.latest ? `You have the latest version (v${u.current}).` : `You have v${u.current}. No releases are published yet.`;
    btn.textContent = 'Check for updates'; $('#updBadge').hidden = true;
  }
}
$('#btnSelfUpd').onclick = async () => {
  if (!updInfo || !updInfo.available) return checkUpdate(false);
  if (!info.selfUpdate || !updInfo.asset) return openReleases();
  const r = await run('selfUpdate');
  if (r && r.restart) {
    $('#updStatus').textContent = `v${r.version} installed. TupraQ is restarting...`;
    setTimeout(() => { if (HOST) HOST.postMessage('restart'); else toast('Close and reopen TupraQ to use the new version.'); }, 2800);
  } else if (r && r.upToDate) checkUpdate(false);
};
$('#btnUpdPage').onclick = openReleases;
$('#updBadge').onclick = () => go('theme');

// ================= macOS WORDING =================
let isMac = false;
function macMode() {
  isMac = true;
  const t = (sel, txt) => { const e = $(sel); if (e) e.textContent = txt; };
  const hide = e => { if (e) e.style.display = 'none'; };
  TITLES.upd = 'Updates';
  $('#nav [data-page="upd"]').lastChild.textContent = 'Updates';
  t('[data-go="upd"] b', 'Updates'); t('[data-go="upd"] span', 'macOS & apps');
  t('[data-go="boost"] span', 'Memory, DNS & startup');
  t('#p-av .muted', 'macOS protects itself with XProtect and Gatekeeper. On-demand scans use ClamAV when it is installed; threats are moved to quarantine.');
  const up = $$('#p-upd .panel'), bo = $$('#p-boost .panel');
  up[0].querySelector('h2').textContent = 'macOS updates'; up[0].querySelector('.muted').textContent = 'Finds and installs macOS and Apple software updates.';
  up[1].querySelector('.muted').textContent = 'Updates your Homebrew packages.';
  t('#updList .empty', 'Press Scan to look for macOS updates.');
  bo[1].querySelector('h2').textContent = 'Startup agents'; bo[1].querySelector('.muted').textContent = 'Background agents that start when you log in. Changes apply at your next login.';
  for (const id of ['bPower', 'bDrive']) { const e = $('#' + id); e.checked = false; hide(e.closest('.item')); }
  hide($('#btnShortcut').closest('.item')); hide($('#btnAvUpdate'));
  t('#p-speed .panel:nth-child(2) h2', 'Mac speed test');
}

// ================= INIT =================
async function init() {
  resize(); requestAnimationFrame(frame);
  try { info = await api('/api/info'); } catch { toast('Cannot reach the TupraQ engine.', true); return; }
  settings = info.settings;
  setTheme(settings.theme, false); $('#setVoice').checked = settings.voice;
  $('#sysLine').textContent = `${info.host} · ${info.os} · ${info.cpu.trim()} (${info.cores} threads)`;
  const b = $('#adminBadge');
  if (info.platform === 'mac') { macMode(); b.textContent = 'macOS'; b.title = 'macOS asks for your password when a step needs it'; }
  else if (info.admin) { b.textContent = 'ADMIN MODE'; b.title = 'Full cleaning and update power'; }
  else {
    b.textContent = 'LIMITED MODE'; b.classList.add('limited'); b.title = 'Click to restart TupraQ as administrator';
    b.onclick = async () => {
      if (HOST) { HOST.postMessage('restart-admin'); return; }
      try { const r = await api('/api/elevate', {}); if (r.ok && !r.already) { document.body.innerHTML = '<p style="padding:40px;font:16px Segoe UI">TupraQ is restarting in administrator mode. You can close this window.</p>'; setTimeout(() => window.close(), 800); } else if (!r.ok) toast('Administrator permission was not granted.', true); }
      catch (e) { toast(e.message, true); }
    };
  }
  $('#verText').textContent = 'TupraQ v' + (info.version || '?');
  setTimeout(() => checkUpdate(true), 4000);
  renderCats(); pollStats(); setInterval(pollStats, 2000);
  // Re-attach to a task that is still running (e.g. after a reload).
  try { const j = (await api('/api/job?since=0')).job; if (j && j.status === 'running') { setBusy(true); $('#jobTitle').textContent = j.title; logEl.textContent = j.log.join('\n') + '\n'; const d = await follow(j.logLen); setBusy(false); $('.bar').classList.remove('ind'); $('#jobTitle').textContent = 'DONE'; if (d && d.status === 'done') speak(VOICE[d.type]); } } catch {}
}
addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye?t=' + window.TQ_TOKEN); } catch {} });
init();
