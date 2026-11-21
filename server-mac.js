'use strict';
// TupraQ for macOS - local engine. Same UI and API as the Windows engine (server.js), Mac system tasks.
// NOTE: written on Windows and not yet run on a Mac. Build with build/build-mac.sh on a Mac.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Worker } = require('worker_threads');

const ROOT = __dirname, UI = path.join(ROOT, 'ui'), HOME = os.homedir();
const updater = require('./updater');
const LIB = path.join(HOME, 'Library');
const DATA = path.join(LIB, 'Application Support', 'TupraQ');
fs.mkdirSync(DATA, { recursive: true });
const SETTINGS_FILE = path.join(DATA, 'settings.json'), LOCK = path.join(DATA, 'instance.json');
const TOKEN = crypto.randomBytes(24).toString('hex');
const ARGS = process.argv.slice(2);
const NO_UI = ARGS.includes('--no-ui');
const PORT_ARG = (() => { const i = ARGS.indexOf('--port'); return i >= 0 ? parseInt(ARGS[i + 1], 10) : 0; })();
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
let PORT = 0;
// Apps started from Finder get a minimal PATH; add the usual Homebrew locations.
process.env.PATH = (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

process.on('uncaughtException', e => { try { fs.appendFileSync(path.join(DATA, 'error.log'), new Date().toISOString() + ' ' + (e.stack || e) + '\n'); } catch {} });

const tick = () => new Promise(r => setImmediate(r));
const fmt = b => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 2 : 1) : b) + ' ' + u[i]; };
const which = names => names.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;

// ---------- command runners ----------
function sh(cmd, args, { onLine, onProc } = {}) {
  return new Promise(resolve => {
    let p; try { p = spawn(cmd, args, { env: process.env }); } catch { return resolve({ code: -1, out: '' }); }
    if (onProc) onProc(p);
    let out = '', buf = '';
    const feed = d => { out += d; buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); if (onLine) for (const l of parts) if (l.trim()) onLine(l.replace(/\s+$/, '')); };
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', () => resolve({ code: -1, out }));
    p.on('close', code => { if (buf.trim() && onLine) onLine(buf.trim()); resolve({ code, out }); });
  });
}
const asEsc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// Runs a fixed shell command as administrator; macOS shows its own password prompt.
const sudo = (shellCmd, opts) => sh('osascript', ['-e', `do shell script "${asEsc(shellCmd)}" with prompt "TupraQ needs your password for this step." with administrator privileges`], opts);
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

// ---------- settings ----------
let settings = { theme: 'cyber', voice: true };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
const THEMES = ['cyber', 'hacker', 'cyberpunk', 'vice', 'blox', 'pixel'];

// ---------- system stats ----------
let osName = 'macOS';
sh('sw_vers', ['-productVersion']).then(r => { if (r.code === 0 && r.out.trim()) osName = 'macOS ' + r.out.trim(); });
const cpuSnap = () => { let idle = 0, tot = 0; for (const c of os.cpus()) { for (const k in c.times) tot += c.times[k]; idle += c.times.idle; } return { idle, tot }; };
let cpuPrev = cpuSnap(), cpuPct = 0;
setInterval(() => { const n = cpuSnap(), dt = n.tot - cpuPrev.tot; cpuPct = dt > 0 ? Math.round(100 * (1 - (n.idle - cpuPrev.idle) / dt)) : 0; cpuPrev = n; }, 1500);
function stats() {
  const disks = [];
  try { const s = fs.statfsSync(HOME); disks.push({ name: 'Disk', total: s.bsize * s.blocks, free: s.bsize * s.bavail }); } catch {}
  return { cpu: cpuPct, ramTotal: os.totalmem(), ramFree: os.freemem(), disks, uptime: os.uptime() };
}

// ---------- junk cleaner ----------
const DAY = 864e5;
const BROWSER_DIRS = /^(Google|com\.apple\.Safari|Firefox|Microsoft Edge|BraveSoftware|com\.google\.Chrome|com\.microsoft\.edgemac)$/;
function firefox() {
  const base = path.join(LIB, 'Caches', 'Firefox', 'Profiles'); let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory()).map(e => ({ dir: path.join(base, e.name, 'cache2') }));
}
const CATS = [
  { id: 'caches', name: 'App caches', desc: 'Cache files apps rebuild on their own (~/Library/Caches)', def: true,
    roots: () => [{ dir: path.join(LIB, 'Caches'), skip: BROWSER_DIRS }] },
  { id: 'browser', name: 'Browser caches', desc: 'Safari, Chrome, Edge, Brave and Firefox cache (history, passwords and cookies are kept)', def: true,
    roots: () => [['Google'], ['com.google.Chrome'], ['com.apple.Safari'], ['Microsoft Edge'], ['com.microsoft.edgemac'], ['BraveSoftware']].map(p => ({ dir: path.join(LIB, 'Caches', ...p) })).concat(firefox()) },
  { id: 'temp', name: 'Temporary files', desc: 'Your temp folder (files older than 24 hours)', def: true,
    roots: () => [{ dir: fs.realpathSync(os.tmpdir()), age: DAY }] },
  { id: 'logs', name: 'Old app logs', desc: 'Log files older than 24 hours (~/Library/Logs)', def: true,
    roots: () => [{ dir: path.join(LIB, 'Logs'), age: DAY, skip: /^DiagnosticReports$/ }] },
  { id: 'reports', name: 'Crash reports', desc: 'Diagnostic and crash reports', def: true,
    roots: () => [{ dir: path.join(LIB, 'Logs', 'DiagnosticReports') }, { dir: path.join(LIB, 'Application Support', 'CrashReporter') }] },
  { id: 'xcode', name: 'Developer build cache', desc: 'Xcode DerivedData and simulator caches (rebuilt when needed)', def: true,
    roots: () => [{ dir: path.join(LIB, 'Developer', 'Xcode', 'DerivedData') }, { dir: path.join(LIB, 'Developer', 'CoreSimulator', 'Caches') }] },
  { id: 'recycle', name: 'Trash', desc: 'Permanently empties your Trash', def: false, recycle: true,
    roots: () => [{ dir: path.join(HOME, '.Trash') }] },
];
async function sweep(root, del, cancelled) {
  let size = 0, count = 0, skipped = 0; const now = Date.now(), dirs = [];
  if (!path.isAbsolute(root.dir) || root.dir.length < 8 || root.dir === HOME) return { size, count, skipped };
  const stack = [root.dir]; let n = 0;
  while (stack.length) {
    if (cancelled && cancelled()) break;
    const d = stack.pop(); let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (root.skip && d === root.dir && root.skip.test(e.name)) continue;
      if (e.isDirectory()) { stack.push(p); if (del) { try { dirs.push([p, fs.statSync(p).mtimeMs]); } catch {} } continue; }
      let s; try { s = fs.lstatSync(p); } catch { continue; }
      if (root.age && now - s.mtimeMs < root.age) continue;
      if (del) { try { fs.unlinkSync(p); size += s.size; count++; } catch { skipped++; } } else { size += s.size; count++; }
    }
    if (++n % 40 === 0) await tick();
  }
  if (del) for (const [d, m] of dirs.sort((a, b) => b[0].length - a[0].length)) { if (!root.age || now - m > root.age) { try { fs.rmdirSync(d); } catch {} } }
  return { size, count, skipped };
}
async function scanJunk(ctx) {
  const out = [];
  for (let i = 0; i < CATS.length; i++) {
    const c = CATS[i]; let size = 0, count = 0;
    for (const r of c.roots()) { const s = await sweep(r, false, ctx.cancelled); size += s.size; count += s.count; }
    out.push({ id: c.id, size, count });
    ctx.log(`${c.name}: ${fmt(size)} in ${count} files`);
    ctx.progress((i + 1) / CATS.length);
  }
  ctx.log('Total junk found: ' + fmt(out.reduce((a, c) => a + c.size, 0)));
  return out;
}
async function cleanJunk(ctx, ids, p0 = 0, p1 = 1) {
  const cats = CATS.filter(c => ids.includes(c.id)); let freed = 0, count = 0, skipped = 0;
  for (let i = 0; i < cats.length; i++) {
    if (ctx.cancelled()) break;
    const c = cats[i]; let size = 0, n = 0, sk = 0;
    if (c.recycle) {
      for (const r of c.roots()) { const s = await sweep(r, false, ctx.cancelled); size += s.size; }
      await ctx.sh('osascript', ['-e', 'tell application "Finder" to empty trash']);
    } else for (const r of c.roots()) { const s = await sweep(r, true, ctx.cancelled); size += s.size; n += s.count; sk += s.skipped; }
    freed += size; count += n; skipped += sk;
    ctx.log(`${c.name}: freed ${fmt(size)}` + (sk ? ` (${sk} files in use, skipped)` : ''));
    ctx.progress(p0 + (p1 - p0) * (i + 1) / cats.length);
  }
  ctx.log('Cleaning complete. Total freed: ' + fmt(freed));
  return { freed, count, skipped };
}

// ---------- boost ----------
async function boost(ctx, o) {
  const cmds = [];
  if (o.ram) cmds.push('/usr/sbin/purge');
  if (o.dns) cmds.push('/usr/bin/dscacheutil -flushcache', '/usr/bin/killall -HUP mDNSResponder');
  if (!cmds.length) { ctx.log('Nothing selected'); return {}; }
  const before = os.freemem();
  ctx.log('Asking macOS for administrator permission...');
  const r = await sudo(cmds.join('; '), { onProc: p => { ctx.j.proc = p; } });
  if (r.code !== 0) { ctx.log('ERR Permission was not granted or the step failed. ' + r.out.trim()); return { failed: true }; }
  if (o.ram) ctx.log(`Memory purged: ${fmt(Math.max(0, os.freemem() - before))} released`);
  if (o.dns) ctx.log('DNS cache flushed');
  ctx.log('Boost complete');
  return {};
}

// ---------- antivirus (XProtect status + optional ClamAV scan) ----------
const clam = () => which(['/opt/homebrew/bin/clamscan', '/usr/local/bin/clamscan']);
async function avStatus() {
  const xp = await sh('defaults', ['read', '/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist', 'CFBundleShortVersionString']);
  const gk = await sh('spctl', ['--status']);
  const fw = await sh('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
  const gkOn = /enabled/i.test(gk.out), fwOn = /enabled/i.test(fw.out), c = clam();
  return { ok: true, threats: [], tiles: [
    ['XProtect (built in)', xp.code === 0 ? 'Active · v' + xp.out.trim() : 'Unknown', xp.code === 0 ? 'good' : 'warn'],
    ['Gatekeeper', gkOn ? 'On' : 'Off', gkOn ? 'good' : 'badc'],
    ['Firewall', fwOn ? 'On' : 'Off', fwOn ? 'good' : 'warn'],
    ['On-demand scanner', c ? 'ClamAV installed' : 'ClamAV not installed', c ? 'good' : 'warn'],
  ] };
}
async function avScan(ctx, full) {
  const c = clam();
  if (!c) { ctx.log('No on-demand scanner found. macOS scans in the background with XProtect.'); ctx.log('To scan on demand, install ClamAV:  brew install clamav'); return { failed: true, noScanner: true, threats: [] }; }
  const fresh = which(['/opt/homebrew/bin/freshclam', '/usr/local/bin/freshclam']);
  if (fresh) { ctx.log('Updating virus definitions...'); await ctx.sh(fresh, ['--quiet']); }
  const qdir = path.join(DATA, 'Quarantine'); fs.mkdirSync(qdir, { recursive: true });
  const targets = full ? [HOME] : ['Downloads', 'Desktop', 'Documents', path.join('Library', 'LaunchAgents')].map(d => path.join(HOME, d)).filter(d => fs.existsSync(d));
  ctx.log(`Scanning with ClamAV (${full ? 'FULL scan of your home folder - this can take hours' : 'quick scan of Downloads, Desktop, Documents'})...`);
  const threats = [];
  const r = await ctx.sh(c, ['-r', '-i', '--no-summary', '--move=' + qdir, ...targets], l => { const m = /^(.*): (.+) FOUND$/.exec(l); if (m) { threats.push(m[2]); ctx.log('  ! ' + m[2] + '  (' + m[1] + ')'); } });
  if (r.code === 2 || r.code === -1) { ctx.log('ERR Scan failed. ' + r.out.trim().split('\n').slice(-2).join(' ')); return { failed: true, threats }; }
  ctx.log(threats.length ? `${threats.length} threat(s) moved to quarantine: ${qdir}` : 'No threats found. Your Mac is clean.');
  return { failed: false, threats };
}

// ---------- updates ----------
let lastUpdates = [];
async function updScan(ctx) {
  ctx.log('Asking Apple for software updates (can take a minute)...');
  const r = await ctx.sh('softwareupdate', ['-l'], () => {});
  if (r.code === -1) return { updates: [], problems: [], drivers: [], error: 'softwareupdate is not available' };
  const lines = r.out.split(/\r?\n/), updates = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\*\s*Label:\s*(.+?)\s*$/.exec(lines[i]); if (!m) continue;
    const d = lines[i + 1] || '', t = /Title:\s*([^,]+)/.exec(d), s = /Size:\s*(\d+)\s*Ki?B/i.exec(d);
    updates.push({ id: m[1], title: (t ? t[1].trim() : m[1]) + (/Action:\s*restart/i.test(d) ? ' (restart needed)' : ''), type: 'software', size: s ? +s[1] * 1024 : 0, restart: /Action:\s*restart/i.test(d) });
  }
  lastUpdates = updates;
  ctx.log(updates.length + ' update(s) available');
  return { updates, problems: [], drivers: [] };
}
async function updInstall(ctx, ids) {
  const sel = lastUpdates.filter(u => ids.includes(u.id));
  if (!sel.length) throw new Error('No updates selected. Scan again first.');
  ctx.log(`Installing ${sel.length} update(s). macOS will ask for your password...`);
  const r = await sudo('/usr/sbin/softwareupdate -i ' + sel.map(u => shq(u.id)).join(' ') + ' 2>&1', { onProc: p => { ctx.j.proc = p; } });
  r.out.split(/\r?\n/).filter(l => l.trim()).slice(-12).forEach(l => ctx.log(l.trim()));
  const ok = r.code === 0, reboot = ok && sel.some(u => u.restart);
  if (reboot) ctx.log('A restart is required to finish installing.');
  return { installed: ok ? sel.length : 0, failed: ok ? 0 : sel.length, reboot, failedAll: !ok };
}
const brew = () => which(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);

// ---------- internet speed test ----------
const SPEED_HOST = 'speed.cloudflare.com';
async function wifiInfo() {
  for (const dev of ['en0', 'en1']) {
    const r = await sh('networksetup', ['-getairportnetwork', dev]);
    const m = /Current Wi-Fi Network:\s*(.+)/.exec(r.out);
    if (m) return { wifi: true, ssid: m[1].trim(), signal: '', rate: '', radio: '', band: '' };
  }
  return { wifi: false };
}
async function netTest(ctx) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  const live = ctx.j.live = { phase: 'ping', ping: null, down: null, up: null };
  const active = new Set();
  const get = (p, onData) => new Promise((resolve, reject) => {
    const r = https.get({ host: SPEED_HOST, path: p, agent, headers: { 'User-Agent': 'speedtest-client' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Speed server answered ' + res.statusCode)); }
      res.on('data', d => onData && onData(d.length)); res.on('end', resolve); res.on('error', reject);
    });
    active.add(r); r.on('close', () => active.delete(r)); r.on('error', reject);
  });
  const killAll = () => { for (const r of active) r.destroy(); };
  try {
    const net = await wifiInfo();
    ctx.log(net.wifi ? `Wi-Fi: ${net.ssid}` : 'Connection: wired, or Wi-Fi name not available');
    ctx.log('Measuring ping...');
    const times = [];
    for (let i = 0; i < 7; i++) { const t = process.hrtime.bigint(); await get('/__down?bytes=0'); times.push(Number(process.hrtime.bigint() - t) / 1e6); if (ctx.cancelled()) throw new Error('cancelled'); }
    const rest = times.slice(1).sort((a, b) => a - b);
    live.ping = Math.round(rest[0]); const jitter = Math.round(rest[rest.length - 1] - rest[0]);
    ctx.log(`Ping ${live.ping} ms (jitter ${jitter} ms)`); ctx.progress(0.1);
    live.phase = 'down'; ctx.log('Testing download speed...');
    let bytes = 0, t0 = 0, stop = false; const DUR = 8000, start = Date.now();
    const tm = setInterval(() => { if (t0) live.down = bytes * 8 / ((Date.now() - t0) / 1000) / 1e6; ctx.progress(0.1 + 0.45 * Math.min(1, (Date.now() - start) / DUR)); if (ctx.cancelled() || Date.now() - start > DUR) { stop = true; killAll(); } }, 200);
    let errs = 0;
    await Promise.all([0, 1, 2, 3].map(async () => { while (!stop) { try { await get('/__down?bytes=25000000', n => { if (!t0) t0 = Date.now(); bytes += n; }); } catch (e) { if (!stop && ++errs > 6) { stop = true; killAll(); } } } }));
    clearInterval(tm);
    if (ctx.cancelled()) throw new Error('cancelled');
    if (!bytes) throw new Error('Could not reach the speed test server. Check your internet connection.');
    live.down = bytes * 8 / ((Date.now() - t0) / 1000) / 1e6;
    ctx.log(`Download ${live.down.toFixed(1)} Mbps`);
    live.phase = 'up'; ctx.log('Testing upload speed...');
    let ub = 0, u0 = Date.now(), ustop = false; const UDUR = 7000, chunk = crypto.randomBytes(65536);
    const um = setInterval(() => { live.up = ub * 8 / ((Date.now() - u0) / 1000) / 1e6; ctx.progress(0.55 + 0.45 * Math.min(1, (Date.now() - u0) / UDUR)); if (ctx.cancelled() || Date.now() - u0 > UDUR) { ustop = true; killAll(); } }, 200);
    const post = () => new Promise(resolve => {
      const total = 16 * 1024 * 1024; let sent = 0;
      const r = https.request({ host: SPEED_HOST, path: '/__up', method: 'POST', agent, headers: { 'User-Agent': 'speedtest-client', 'Content-Type': 'application/octet-stream', 'Content-Length': total } }, res => { res.resume(); res.on('end', resolve); });
      active.add(r); r.on('close', () => { active.delete(r); resolve(); }); r.on('error', () => resolve());
      const pump = () => { while (sent < total && !ustop) { sent += chunk.length; const ok = r.write(chunk, () => { ub += chunk.length; }); if (!ok) return r.once('drain', pump); } if (sent >= total) r.end(); };
      pump();
    });
    await Promise.all([0, 1, 2].map(async () => { let n = 0; while (!ustop && n++ < 40) await post(); }));
    clearInterval(um);
    if (ctx.cancelled()) throw new Error('cancelled');
    live.up = ub * 8 / ((Date.now() - u0) / 1000) / 1e6;
    ctx.log(`Upload ${live.up.toFixed(1)} Mbps`); live.phase = 'done';
    return { ping: live.ping, jitter, down: +live.down.toFixed(1), up: +live.up.toFixed(1), net };
  } finally { killAll(); agent.destroy(); }
}

// ---------- PC speed test ----------
const BENCH_WORKER = `const {parentPort,workerData}=require('worker_threads');
function sieve(n){const a=new Uint8Array(n+1);let c=0;for(let i=2;i<=n;i++){if(!a[i]){c++;for(let j=i*2;j<=n;j+=i)a[j]=1}}return c}
const ms=workerData.ms,t=Date.now();let n=0;
if(workerData.kind==='mem'){const a=Buffer.alloc(64<<20,1),b=Buffer.alloc(64<<20);const s=Date.now();while(Date.now()-s<ms){a.copy(b);n++}parentPort.postMessage(n*64/1024/((Date.now()-s)/1000))}
else{while(Date.now()-t<ms){sieve(300000);n++}parentPort.postMessage(n/((Date.now()-t)/1000))}`;
const benchWorkers = (count, kind, ms) => Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
  const w = new Worker(BENCH_WORKER, { eval: true, workerData: { kind, ms } });
  w.once('message', resolve); w.once('error', reject);
}))).then(a => a.reduce((x, y) => x + y, 0));
async function pcTest(ctx) {
  const cores = os.cpus().length;
  ctx.log('CPU: ' + ((os.cpus()[0] || {}).model || '').trim() + ` (${cores} threads)`);
  ctx.log('Testing single-core speed...');
  const single = await benchWorkers(1, 'cpu', 2500); ctx.log(`Single-core: ${single.toFixed(0)} ops/s`); ctx.progress(0.25);
  if (ctx.cancelled()) return {};
  ctx.log('Testing multi-core speed...');
  const multi = await benchWorkers(cores, 'cpu', 2500); ctx.log(`Multi-core: ${multi.toFixed(0)} ops/s (${(multi / single).toFixed(1)}x)`); ctx.progress(0.5);
  if (ctx.cancelled()) return {};
  ctx.log('Testing memory speed...');
  const mem = await benchWorkers(1, 'mem', 1500); ctx.log(`Memory: ${mem.toFixed(1)} GB/s`); ctx.progress(0.65);
  if (ctx.cancelled()) return {};
  ctx.log('Testing system drive speed (256 MB test file)...');
  let dw = 0, dr = 0; const file = path.join(DATA, 'bench.tmp');
  try {
    const st = fs.statfsSync(DATA);
    if (st.bsize * st.bavail < 2 * 1024 ** 3) throw new Error('not enough free space');
    const chunk = crypto.randomBytes(4 << 20), N = 64;
    let fh = await fs.promises.open(file, 'w'), t = Date.now();
    for (let i = 0; i < N; i++) await fh.write(chunk);
    await fh.sync(); await fh.close(); dw = N * 4 / ((Date.now() - t) / 1000); ctx.progress(0.85);
    fh = await fs.promises.open(file, 'r'); t = Date.now();
    for (let i = 0; i < N; i++) await fh.read(chunk, 0, chunk.length, i * chunk.length);
    await fh.close(); dr = N * 4 / Math.max(0.001, (Date.now() - t) / 1000);
    ctx.log(`Disk: write ${dw.toFixed(0)} MB/s · read ${dr.toFixed(0)} MB/s`);
  } catch (e) { ctx.log('Disk test skipped: ' + e.message); }
  finally { try { fs.unlinkSync(file); } catch {} }
  const s = { single: single / 900 * 1000, multi: multi / 8000 * 1000, mem: mem / 12 * 1000, disk: Math.min(3000, (dw + Math.min(dr, 3000)) / 2 / 800 * 1000) };
  const score = Math.round(s.single * 0.3 + s.multi * 0.35 + s.mem * 0.15 + s.disk * 0.2);
  const rating = score < 400 ? 'Slow' : score < 800 ? 'Average' : score < 1300 ? 'Fast' : 'Very fast';
  ctx.log(`TupraQ score: ${score} (${rating})`);
  return { score, rating, cores, single: Math.round(single), multi: Math.round(multi), mem: +mem.toFixed(1), dw: Math.round(dw), dr: Math.round(dr), parts: { single: Math.round(s.single), multi: Math.round(s.multi), mem: Math.round(s.mem), disk: Math.round(s.disk) } };
}

// ---------- startup agents (~/Library/LaunchAgents) ----------
const AGENTS = path.join(LIB, 'LaunchAgents');
async function startupList() {
  let files = []; try { files = fs.readdirSync(AGENTS).filter(f => f.endsWith('.plist')); } catch {}
  const dis = (await sh('launchctl', ['print-disabled', 'gui/' + UID])).out;
  const items = [];
  for (const f of files) {
    const fp = path.join(AGENTS, f);
    const lab = await sh('plutil', ['-extract', 'Label', 'raw', '-o', '-', fp]);
    const label = lab.code === 0 && lab.out.trim() ? lab.out.trim() : f.replace(/\.plist$/, '');
    let prog = await sh('plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', fp]);
    if (prog.code !== 0) prog = await sh('plutil', ['-extract', 'Program', 'raw', '-o', '-', fp]);
    const off = new RegExp('"' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*=>\\s*(true|disabled)').test(dis);
    items.push({ scope: 'HKCU', kind: 'Agent', name: label, cmd: prog.code === 0 ? prog.out.trim() : fp, enabled: !off });
  }
  return items;
}

// ---------- voice ----------
const PHRASES = {
  clean: 'Sir, the cleaning is done.', optimize: 'Sir, the optimizing is done.', scan: 'Sir, the security scan is done.',
  update: 'Sir, the updating is done.', analyze: 'Sir, the analysis is done.', check: 'Sir, the update check is done.',
  fail: 'Sir, the task could not be completed.', test: 'Sir, the cleaning and optimizing is done.', speed: 'Sir, the speed test is done.',
};

// ---------- jobs ----------
let job = null, jid = 0;
const running = () => job && job.status === 'running';
const JOBS = {
  junkScan: { title: 'Analyzing junk files', run: async ctx => ({ cats: await scanJunk(ctx) }) },
  clean: { title: 'Deep cleaning', run: (ctx, o) => cleanJunk(ctx, Array.isArray(o.ids) ? o.ids.map(String) : []) },
  boost: { title: 'Boosting performance', run: (ctx, o) => boost(ctx, { dns: !!o.dns, ram: !!o.ram }) },
  optimizeAll: { title: 'Full optimization', run: async ctx => {
    ctx.log('=== [1/3] DEEP CLEAN ===');
    const c = await cleanJunk(ctx, CATS.filter(x => x.def).map(x => x.id), 0, 0.4);
    if (ctx.cancelled()) return c;
    ctx.log('=== [2/3] SPEED BOOST ==='); const b = await boost(ctx, { dns: true, ram: true }); ctx.progress(0.55);
    if (ctx.cancelled()) return c;
    ctx.log('=== [3/3] SECURITY SCAN ==='); ctx.progress(null);
    let a = { threats: [] };
    if (clam()) a = await avScan(ctx, false); else ctx.log('Skipped: no on-demand scanner installed (XProtect keeps protecting in the background).');
    ctx.log('=== OPTIMIZATION COMPLETE ===');
    return { freed: c.freed, threats: a.threats || [], failed: !!(a.failed || b.failed) };
  } },
  avScan: { title: 'Virus scan', run: (ctx, o) => avScan(ctx, o.mode === 'full') },
  avUpdate: { title: 'Updating virus definitions', run: async ctx => {
    const fresh = which(['/opt/homebrew/bin/freshclam', '/usr/local/bin/freshclam']);
    if (!fresh) { ctx.log('XProtect definitions are updated by macOS automatically.'); return {}; }
    const r = await ctx.sh(fresh, []); return { failed: r.code !== 0 };
  } },
  updScan: { title: 'Scanning for macOS updates', run: ctx => updScan(ctx) },
  updInstall: { title: 'Installing updates', run: async (ctx, o) => { const r = await updInstall(ctx, (Array.isArray(o.ids) ? o.ids : []).map(String)); return { ...r, failed: r.failedAll ? true : r.failed }; } },
  netTest: { title: 'Internet speed test', run: ctx => netTest(ctx) },
  pcTest: { title: 'Mac speed test', run: ctx => pcTest(ctx) },
  appScan: { title: 'Checking app updates', run: async ctx => {
    const b = brew(); if (!b) throw new Error('Homebrew is not installed, so there are no packages to check.');
    ctx.log('Asking Homebrew for outdated packages...');
    await ctx.sh(b, ['update', '--quiet'], () => {});
    const r = await ctx.sh(b, ['outdated', '--verbose'], () => {});
    const apps = r.out.split(/\r?\n/).map(l => /^(\S+)\s+\((.+?)\)\s+(?:<|!=)\s+(\S+)/.exec(l)).filter(Boolean).map(m => ({ name: m[1], id: 'Homebrew', ver: m[2], avail: m[3] }));
    ctx.log(apps.length + ' app update(s) available'); return { apps };
  } },
  appUpgrade: { title: 'Updating apps', run: async ctx => {
    const b = brew(); if (!b) throw new Error('Homebrew is not installed.');
    ctx.log('Upgrading Homebrew packages...'); const r = await ctx.sh(b, ['upgrade']); ctx.log('App updates finished'); return { failed: r.code !== 0 };
  } },
};
function startJob(type, opts) {
  const def = JOBS[type];
  if (!def) throw new Error('Unknown task');
  if (running()) throw new Error('Another task is already running');
  const j = job = { id: ++jid, type, title: def.title, status: 'running', progress: null, log: [], result: null, proc: null, live: null };
  const ctx = {
    j, log: s => { j.log.push(String(s)); }, progress: p => { j.progress = p; }, cancelled: () => j.status !== 'running',
    sh: (cmd, args, onLine) => sh(cmd, args, { onLine: onLine || (l => j.log.push(l)), onProc: p => { j.proc = p; } }),
  };
  ctx.log('> ' + def.title);
  Promise.resolve().then(() => def.run(ctx, opts || {}))
    .then(r => { j.result = r; if (j.status === 'running') j.status = 'done'; })
    .catch(e => { j.log.push('ERROR: ' + e.message); if (j.status === 'running') j.status = 'error'; })
    .finally(() => { j.proc = null; j.progress = 1; });
  return j;
}
function cancelJob() {
  if (!running()) return;
  job.status = 'cancelled'; job.log.push('Cancelled by user');
  try { if (job.proc) job.proc.kill('SIGTERM'); } catch {}
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 65536) { reject(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } }); });
let lastBeat = Date.now(), byeAt = 0;

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'forbidden' });
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/') {
      if (u.searchParams.get('t') !== TOKEN) { res.writeHead(403); return res.end('TupraQ: please start the app from its icon.'); }
      const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); return res.end(html);
    }
    if (!p.startsWith('/api/')) {
      const f = path.join(UI, path.basename(p)), ext = path.extname(f);
      if (!MIME[ext] || ext === '.html' || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(f));
    }
    if (p === '/api/bye') { if (u.searchParams.get('t') === TOKEN) byeAt = Date.now(); return send(res, 200, {}); }
    if (req.headers['x-tupraq-token'] !== TOKEN) return send(res, 403, { error: 'forbidden' });
    lastBeat = Date.now(); byeAt = 0;
    const body = req.method === 'POST' ? await readBody(req) : {};
    switch (p) {
      case '/api/update/check': try { return send(res, 200, await updater.check('mac')); } catch (e) { return send(res, 200, { current: updater.VERSION, error: e.message, page: updater.RELEASES }); }
      case '/api/update/open': spawn('open', [updater.RELEASES], { detached: true, stdio: 'ignore' }).unref(); return send(res, 200, {});
      case '/api/info': return send(res, 200, { platform: 'mac', version: updater.VERSION, selfUpdate: false, admin: true, host: os.hostname(), os: osName, cpu: (os.cpus()[0] || {}).model || '', cores: os.cpus().length, user: os.userInfo().username, settings, cats: CATS.map(c => ({ id: c.id, name: c.name, desc: c.desc, def: c.def })) });
      case '/api/stats': return send(res, 200, stats());
      case '/api/settings':
        if (THEMES.includes(body.theme)) settings.theme = body.theme;
        if (typeof body.voice === 'boolean') settings.voice = body.voice;
        try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {}
        return send(res, 200, settings);
      case '/api/job': {
        if (!job) return send(res, 200, { job: null });
        const since = Math.max(0, parseInt(u.searchParams.get('since') || '0', 10) || 0);
        return send(res, 200, { job: { id: job.id, type: job.type, title: job.title, status: job.status, progress: job.progress, live: job.live || null, result: job.status === 'running' ? null : job.result, log: job.log.slice(since), logLen: job.log.length } });
      }
      case '/api/run': { const j = startJob(String(body.type), body.opts); return send(res, 200, { id: j.id, title: j.title }); }
      case '/api/cancel': cancelJob(); return send(res, 200, {});
      case '/api/av': return send(res, 200, await avStatus());
      case '/api/startup': return send(res, 200, { items: await startupList() });
      case '/api/startup/set': {
        if (typeof body.name !== 'string' || !/^[\w.\-]{1,200}$/.test(body.name)) return send(res, 400, { error: 'bad request' });
        const r = await sh('launchctl', [body.enabled ? 'enable' : 'disable', `gui/${UID}/${body.name}`]);
        return send(res, 200, r.code === 0 ? { ok: true } : { ok: false, error: r.out.trim() || 'launchctl failed' });
      }
      case '/api/speak': { const t = PHRASES[body.key]; if (t) sh('say', ['-v', 'Daniel', t]).then(r => { if (r.code !== 0) sh('say', [t]); }); return send(res, 200, {}); }
      case '/api/shortcut': return send(res, 200, { ok: false });
      case '/api/elevate': return send(res, 200, { ok: true, already: true });
      default: return send(res, 404, { error: 'not found' });
    }
  } catch (e) { try { send(res, 400, { error: e.message }); } catch {} }
});

function quit() { try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (l.token === TOKEN) fs.unlinkSync(LOCK); } catch {} process.exit(0); }
function launchUI(url) {
  const exe = which(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium']);
  // A Chromium browser gives a clean app window; otherwise fall back to the default browser (Safari).
  if (exe) spawn(exe, ['--app=' + url, '--user-data-dir=' + path.join(DATA, 'ui'), '--no-first-run', '--no-default-browser-check', '--window-size=1280,840', '--autoplay-policy=no-user-gesture-required'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}
function existing() {
  return new Promise(resolve => {
    let l; try { l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return resolve(null); }
    const r = http.get({ host: '127.0.0.1', port: l.port, path: '/api/stats', headers: { 'x-tupraq-token': l.token }, timeout: 1200 }, res => { res.resume(); resolve(res.statusCode === 200 ? l : null); });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
(async () => {
  if (!NO_UI) { const l = await existing(); if (l) { launchUI(`http://127.0.0.1:${l.port}/?t=${l.token}`); return setTimeout(() => process.exit(0), 300); } }
  server.listen(PORT_ARG || 0, '127.0.0.1', () => {
    PORT = server.address().port;
    const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
    if (!NO_UI) { try { fs.writeFileSync(LOCK, JSON.stringify({ port: PORT, token: TOKEN })); } catch {} }
    console.log('TupraQ running at ' + url);
    if (!NO_UI) {
      launchUI(url);
      setInterval(() => {
        if (running()) return;
        const now = Date.now();
        if ((byeAt && now - byeAt > 4000) || now - lastBeat > 180000) quit();
      }, 2000);
    }
  });
})();
