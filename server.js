'use strict';
// TupraQ - PC optimizer. Local backend: serves the UI on 127.0.0.1 and runs the system tasks.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT = __dirname, UI = path.join(ROOT, 'ui');
const updater = require('./updater');
const LAD = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const WIN = process.env.SystemRoot || 'C:\\Windows';
const PDATA = process.env.ProgramData || 'C:\\ProgramData';
const DATA = path.join(LAD, 'TupraQ');
fs.mkdirSync(DATA, { recursive: true });
const SETTINGS_FILE = path.join(DATA, 'settings.json'), LOCK = path.join(DATA, 'instance.json');
const TOKEN = crypto.randomBytes(24).toString('hex');
const ARGS = process.argv.slice(2);
const NO_UI = ARGS.includes('--no-ui'), TAKEOVER = ARGS.includes('--takeover');
const PORT_ARG = (() => { const i = ARGS.indexOf('--port'); return i >= 0 ? parseInt(ARGS[i + 1], 10) : 0; })();
let PORT = 0;

process.on('uncaughtException', e => { try { fs.appendFileSync(path.join(DATA, 'error.log'), new Date().toISOString() + ' ' + (e.stack || e) + '\n'); } catch {} });

const tick = () => new Promise(r => setImmediate(r));
const fmt = b => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 2 : 1) : b) + ' ' + u[i]; };

let IS_ADMIN = false;
try { execFileSync('fltmc', [], { stdio: 'ignore', windowsHide: true }); IS_ADMIN = true; } catch {}

// ---------- PowerShell runner ----------
const PS_PRE = String.raw`$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
function L($m){[Console]::Out.WriteLine([string]$m)}
function J($o){[Console]::Out.WriteLine('##JSON##'+($o|ConvertTo-Json -Compress -Depth 5))}
`;
function ps(script, { onLine, env, onProc } = {}) {
  return new Promise(resolve => {
    const enc = Buffer.from(PS_PRE + script, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { windowsHide: true, env: { ...process.env, ...(env || {}) } });
    if (onProc) onProc(p);
    let buf = '', json = null; const lines = [];
    const feed = l => { l = l.replace(/\s+$/, ''); if (!l) return; if (l.startsWith('##JSON##')) { try { json = JSON.parse(l.slice(8)); } catch {} } else { lines.push(l); if (onLine) onLine(l); } };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.search(/\r?\n/)) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i).replace(/^\r?\n/, ''); } });
    p.stderr.on('data', () => {});
    p.on('error', () => resolve({ code: -1, json, lines }));
    p.on('close', code => { if (buf) feed(buf); resolve({ code, json, lines }); });
  });
}

// ---------- settings ----------
let settings = { theme: 'cyber', voice: true };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
const THEMES = ['cyber', 'hacker', 'cyberpunk', 'vice', 'blox', 'pixel'];

// ---------- system stats ----------
let drives = [(process.env.SystemDrive || 'C:') + '\\'], SID = '';
ps(String.raw`J @{drives=@([IO.DriveInfo]::GetDrives()|?{$_.DriveType -eq 'Fixed' -and $_.IsReady}|%{$_.Name});sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}`)
  .then(r => { if (r.json) { if (r.json.drives && r.json.drives.length) drives = r.json.drives; SID = r.json.sid || ''; } });
const cpuSnap = () => { let idle = 0, tot = 0; for (const c of os.cpus()) { for (const k in c.times) tot += c.times[k]; idle += c.times.idle; } return { idle, tot }; };
let cpuPrev = cpuSnap(), cpuPct = 0;
setInterval(() => { const n = cpuSnap(), dt = n.tot - cpuPrev.tot; cpuPct = dt > 0 ? Math.round(100 * (1 - (n.idle - cpuPrev.idle) / dt)) : 0; cpuPrev = n; }, 1500);
function stats() {
  const total = os.totalmem(), free = os.freemem();
  const disks = [];
  for (const d of drives) { try { const s = fs.statfsSync(d); disks.push({ name: d.slice(0, 2), total: s.bsize * s.blocks, free: s.bsize * s.bfree }); } catch {} }
  return { cpu: cpuPct, ramTotal: total, ramFree: free, disks, uptime: os.uptime() };
}

// ---------- junk cleaner ----------
const DAY = 864e5;
function chromium(base) {
  const out = []; let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) if (e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
    for (const c of ['Cache', 'Code Cache', 'GPUCache']) out.push({ dir: path.join(base, e.name, c) });
  for (const c of ['ShaderCache', 'GrShaderCache']) out.push({ dir: path.join(base, c) });
  return out;
}
function firefox() {
  const base = path.join(LAD, 'Mozilla', 'Firefox', 'Profiles'); let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory()).map(e => ({ dir: path.join(base, e.name, 'cache2') }));
}
const CATS = [
  { id: 'temp', name: 'Temporary files', desc: 'User and Windows temp folders (files older than 24 hours)', def: true,
    roots: () => [{ dir: os.tmpdir(), age: DAY, skip: /^claude$/i }, { dir: path.join(WIN, 'Temp'), age: DAY }] },
  { id: 'browser', name: 'Browser caches', desc: 'Chrome, Edge, Brave and Firefox cache (history, passwords and cookies are kept)', def: true,
    roots: () => [...chromium(path.join(LAD, 'Google', 'Chrome', 'User Data')), ...chromium(path.join(LAD, 'Microsoft', 'Edge', 'User Data')),
      ...chromium(path.join(LAD, 'BraveSoftware', 'Brave-Browser', 'User Data')), ...firefox()] },
  { id: 'wu', name: 'Windows Update leftovers', desc: 'Already-installed update downloads', def: true,
    roots: () => [{ dir: path.join(WIN, 'SoftwareDistribution', 'Download') }] },
  { id: 'reports', name: 'Error reports & crash dumps', desc: 'Windows error reports, memory dumps and minidumps', def: true,
    roots: () => [path.join(PDATA, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), path.join(PDATA, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
      path.join(LAD, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), path.join(LAD, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
      path.join(LAD, 'CrashDumps'), path.join(WIN, 'Minidump'), path.join(WIN, 'LiveKernelReports')].map(dir => ({ dir }))
      .concat([{ dir: WIN, top: true, match: /^MEMORY\.DMP$/i }]) },
  { id: 'thumbs', name: 'Thumbnail & icon cache', desc: 'Explorer rebuilds these automatically', def: true,
    roots: () => [{ dir: path.join(LAD, 'Microsoft', 'Windows', 'Explorer'), top: true, match: /^(thumbcache|iconcache)_.*\.db$/i }] },
  { id: 'shader', name: 'Graphics shader cache', desc: 'DirectX, NVIDIA and AMD shader caches', def: true,
    roots: () => [['D3DSCache'], ['NVIDIA', 'DXCache'], ['NVIDIA', 'GLCache'], ['AMD', 'DxCache'], ['AMD', 'DxcCache']].map(p => ({ dir: path.join(LAD, ...p) })) },
  { id: 'logs', name: 'Old system logs', desc: 'Windows servicing logs older than 24 hours', def: true,
    roots: () => [{ dir: path.join(WIN, 'Logs', 'CBS'), age: DAY }, { dir: path.join(WIN, 'Logs', 'DISM'), age: DAY }] },
  { id: 'recycle', name: 'Recycle Bin', desc: 'Permanently empties your Recycle Bin on all drives', def: false, recycle: true,
    roots: () => SID ? drives.map(d => ({ dir: path.join(d, '$Recycle.Bin', SID) })) : [] },
];

async function sweep(root, del, cancelled) {
  let size = 0, count = 0, skipped = 0; const now = Date.now(), dirs = [];
  if (!path.isAbsolute(root.dir) || root.dir.length < 8) return { size, count, skipped };
  const stack = [root.dir]; let n = 0;
  while (stack.length) {
    if (cancelled && cancelled()) break;
    const d = stack.pop(); let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (root.skip && d === root.dir && root.skip.test(e.name)) continue;
      if (e.isDirectory()) {
        if (!root.top) { stack.push(p); if (del) { try { dirs.push([p, fs.statSync(p).mtimeMs]); } catch {} } }
        continue;
      }
      if (root.match && !root.match.test(e.name)) continue;
      let s; try { s = fs.lstatSync(p); } catch { continue; }
      if (root.age && now - s.mtimeMs < root.age) continue;
      if (del) {
        try { fs.unlinkSync(p); size += s.size; count++; }
        catch { try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); size += s.size; count++; } catch { skipped++; } }
      } else { size += s.size; count++; }
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
      await ctx.ps(String.raw`try{Clear-RecycleBin -Force -ErrorAction Stop}catch{}`);
    } else for (const r of c.roots()) { const s = await sweep(r, true, ctx.cancelled); size += s.size; n += s.count; sk += s.skipped; }
    freed += size; count += n; skipped += sk;
    ctx.log(`${c.name}: freed ${fmt(size)}` + (sk ? ` (${sk} files in use, skipped)` : ''));
    ctx.progress(p0 + (p1 - p0) * (i + 1) / cats.length);
  }
  ctx.log('Cleaning complete. Total freed: ' + fmt(freed));
  return { freed, count, skipped };
}

// ---------- boost ----------
function boostScript(o) {
  let s = '';
  if (o.dns) s += String.raw`ipconfig /flushdns | Out-Null; L 'DNS cache flushed'
`;
  if (o.ram) s += String.raw`try{
$t=Add-Type -MemberDefinition '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);' -Name Mem -Namespace TupraQ -PassThru
$b=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory; $n=0
foreach($p in Get-Process){ try{ if($t::EmptyWorkingSet($p.Handle)){$n++} }catch{} }
Start-Sleep -Milliseconds 800
$a=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
L ("Memory: trimmed $n processes, {0:N0} MB released" -f [math]::Max(0,($a-$b)/1024))
}catch{ L ('Memory trim skipped: '+$_.Exception.Message) }
`;
  if (o.power) s += String.raw`powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null | Out-Null
if($LASTEXITCODE -eq 0){ L 'Power plan set to High performance' } else { L 'High performance power plan is not available on this PC' }
`;
  if (o.drive) s += String.raw`L 'Optimizing system drive (TRIM / defrag) - this can take several minutes...'
try{ defrag $env:SystemDrive /O 2>&1 | %{ $x=([string]$_).Trim(); if($x){ L $x } } }catch{ L ('Drive optimize failed: '+$_.Exception.Message) }
`;
  return s + "L 'Boost complete'\n";
}
async function boost(ctx, o) { await ctx.ps(boostScript(o)); return {}; }

// ---------- antivirus (Microsoft Defender) ----------
const PS_AV_STATUS = String.raw`$r=@{}
function D($d){ if($d){$d.ToString('yyyy-MM-dd HH:mm')}else{$null} }
try{ $s=Get-MpComputerStatus -ErrorAction Stop
 $r.ok=$true;$r.enabled=[bool]$s.AntivirusEnabled;$r.realtime=[bool]$s.RealTimeProtectionEnabled;$r.sigVersion=[string]$s.AntivirusSignatureVersion
 $r.sigDate=D $s.AntivirusSignatureLastUpdated;$r.quick=D $s.QuickScanEndTime;$r.full=D $s.FullScanEndTime;$r.mode=[string]$s.AMRunningMode
}catch{ $r.ok=$false;$r.error=$_.Exception.Message }
try{ $r.products=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop|%{[string]$_.displayName}) }catch{ $r.products=@() }
try{ $r.threats=@(Get-MpThreat -ErrorAction Stop|?{$_.IsActive}|%{[string]$_.ThreatName}) }catch{ $r.threats=@() }
J $r`;
const avScanScript = full => String.raw`$fail=$false
try{ L 'Updating virus definitions...'; Update-MpSignature -ErrorAction Stop; L 'Definitions are up to date' }catch{ L ('Definition update skipped: '+$_.Exception.Message) }
L 'Scanning with Microsoft Defender (${full ? 'FULL scan - this can take hours' : 'quick scan - a few minutes'})...'
try{ Start-MpScan -ScanType ${full ? 'FullScan' : 'QuickScan'} -ErrorAction Stop; L 'Scan finished' }catch{ L ('ERR Scan failed: '+$_.Exception.Message); $fail=$true }
$th=@(); try{ $th=@(Get-MpThreat -ErrorAction Stop|?{$_.IsActive}) }catch{}
if($th.Count -gt 0){ L "$($th.Count) threat(s) detected:"; $th|%{ L ('  ! '+$_.ThreatName) }
 try{ Remove-MpThreat -ErrorAction Stop; L 'Threats removed / quarantined' }catch{ L ('Could not remove automatically: '+$_.Exception.Message) } }
elseif(-not $fail){ L 'No threats found. Your PC is clean.' }
J @{failed=$fail;threats=@($th|%{[string]$_.ThreatName})}`;
async function avScan(ctx, full) { const r = await ctx.ps(avScanScript(full)); return r.json || { failed: true, threats: [] }; }

// ---------- updates / drivers ----------
const PS_WU_FIND = String.raw`function Find-TQ($sess){ $se=$sess.CreateUpdateSearcher(); $all=@{}
 foreach($q in @("IsInstalled=0 and IsHidden=0 and Type='Driver'","IsInstalled=0 and IsHidden=0 and Type='Driver' and DeploymentAction='OptionalInstallation'","IsInstalled=0 and IsHidden=0 and Type='Software'")){
  try{ $r=$se.Search($q); foreach($u in $r.Updates){ $all[[string]$u.Identity.UpdateID]=$u } }catch{ L ('Search note: '+$_.Exception.Message) } }
 return $all }
`;
const PS_UPD_SCAN = PS_WU_FIND + String.raw`$r=@{updates=@();problems=@();drivers=@()}
L 'Checking hardware devices...'
try{ $r.problems=@(Get-CimInstance Win32_PnPEntity -Filter 'ConfigManagerErrorCode<>0' -ErrorAction Stop|%{ @{name=[string]$_.Name;code=[int]$_.ConfigManagerErrorCode} }) }catch{}
L "$($r.problems.Count) device(s) with problems"
try{ $seen=@{}; $r.drivers=@(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop|?{ $_.DeviceName -and $_.DriverProviderName -and $_.DriverProviderName -ne 'Microsoft' -and $_.DriverDate }|sort DriverDate|?{ if($seen[$_.DeviceName]){$false}else{$seen[$_.DeviceName]=1;$true} }|select -First 60|%{ @{name=[string]$_.DeviceName;cls=[string]$_.DeviceClass;ver=[string]$_.DriverVersion;date=$_.DriverDate.ToString('yyyy-MM-dd');vendor=[string]$_.DriverProviderName} }) }catch{}
L "$($r.drivers.Count) third-party drivers installed"
L 'Searching Windows Update for driver and system updates (can take 1-3 minutes)...'
try{ $sess=New-Object -ComObject Microsoft.Update.Session; $all=Find-TQ $sess
 $r.updates=@($all.Values|%{ @{id=[string]$_.Identity.UpdateID;title=[string]$_.Title;type=$(if($_.Type -eq 2){'driver'}else{'software'});size=[double]$_.MaxDownloadSize} })
 L "$($r.updates.Count) update(s) available"
}catch{ L ('ERR Windows Update search failed: '+$_.Exception.Message); $r.error=$_.Exception.Message }
J $r`;
const PS_UPD_INSTALL = PS_WU_FIND + String.raw`try{
$ids=$env:TQ_IDS -split ','
$sess=New-Object -ComObject Microsoft.Update.Session
L 'Locating selected updates...'
$all=Find-TQ $sess
$coll=New-Object -ComObject Microsoft.Update.UpdateColl
foreach($id in $ids){ if($all.ContainsKey($id)){ $u=$all[$id]; if(-not $u.EulaAccepted){$u.AcceptEula()}; [void]$coll.Add($u) } }
if($coll.Count -eq 0){ L 'Nothing to install'; J @{installed=0;failed=0;reboot=$false}; exit }
L "Downloading $($coll.Count) update(s)..."
$dl=$sess.CreateUpdateDownloader(); $dl.Updates=$coll; [void]$dl.Download()
L 'Installing (do not turn off your PC)...'
$in=$sess.CreateUpdateInstaller(); $in.Updates=$coll; $res=$in.Install()
$ok=0;$bad=0
for($i=0;$i -lt $coll.Count;$i++){ $rc=$res.GetUpdateResult($i).ResultCode; if($rc -eq 2 -or $rc -eq 3){$ok++; L ('OK    '+$coll.Item($i).Title)}else{$bad++; L ('FAIL  '+$coll.Item($i).Title)} }
if($res.RebootRequired){ L 'A restart is required to finish installing.' }
J @{installed=$ok;failed=$bad;reboot=[bool]$res.RebootRequired}
}catch{ L ('ERR Install failed: '+$_.Exception.Message); J @{installed=0;failed=1;reboot=$false;error=$_.Exception.Message} }`;

function winget(args, ctx, onLine) {
  return new Promise(resolve => {
    const p = spawn('cmd.exe', ['/d', '/c', 'winget', ...args], { windowsHide: true });
    ctx.j.proc = p; let out = '', buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); for (const l of parts) if (onLine) onLine(l); });
    p.stderr.on('data', () => {});
    p.on('error', () => resolve({ code: -1, out }));
    p.on('close', code => resolve({ code, out }));
  });
}
function parseWinget(text) {
  const lines = text.split(/\r?\n|\r/).map(l => l.replace(/\s+$/, ''));
  const hi = lines.findIndex(l => /Name\s+Id\s+Version\s+Available/.test(l));
  if (hi < 0) return [];
  const h = lines[hi].slice(lines[hi].indexOf('Name'));
  const c = [h.indexOf(' Id ') + 1, h.indexOf(' Version ') + 1, h.indexOf(' Available') + 1, h.indexOf(' Source') + 1];
  const out = [];
  for (let i = hi + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l || /^\d+ upgrades? available/i.test(l)) break;
    if (l.length < c[2]) continue;
    out.push({ name: l.slice(0, c[0]).trim(), id: l.slice(c[0], c[1]).trim(), ver: l.slice(c[1], c[2]).trim(), avail: (c[3] > 0 ? l.slice(c[2], c[3]) : l.slice(c[2])).trim() });
  }
  return out;
}
const junkLine = l => !l.trim() || /^[\s\-\\|\/]+$/.test(l) || /[█▒░]/.test(l);

// ---------- internet speed test (Cloudflare speed endpoints) ----------
const https = require('https');
const { Worker } = require('worker_threads');
const SPEED_HOST = 'speed.cloudflare.com';
function wifiInfo() {
  return new Promise(resolve => execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true }, (e, out) => {
    const g = k => { const m = new RegExp('^\\s*' + k + '\\s*:\\s*(.+)$', 'mi').exec(out || ''); return m ? m[1].trim() : ''; };
    const ssid = g('SSID');
    resolve(ssid ? { wifi: true, ssid, signal: g('Signal'), rate: g('Receive rate \\(Mbps\\)'), radio: g('Radio type'), band: g('Band') } : { wifi: false });
  }));
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
    ctx.log(net.wifi ? `Wi-Fi: ${net.ssid} · signal ${net.signal} · link ${net.rate} Mbps · ${net.radio} ${net.band}` : 'Connection: wired / no Wi-Fi adapter in use');
    // ping
    ctx.log('Measuring ping...');
    const times = [];
    for (let i = 0; i < 7; i++) { const t = process.hrtime.bigint(); await get('/__down?bytes=0'); times.push(Number(process.hrtime.bigint() - t) / 1e6); if (ctx.cancelled()) throw new Error('cancelled'); }
    const rest = times.slice(1).sort((a, b) => a - b);
    live.ping = Math.round(rest[0]); const jitter = Math.round(rest[rest.length - 1] - rest[0]);
    ctx.log(`Ping ${live.ping} ms (jitter ${jitter} ms)`); ctx.progress(0.1);
    // download
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
    // upload
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

// ---------- PC speed test (benchmark) ----------
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
  const cores = os.cpus().length, live = ctx.j.live = { phase: 'single' };
  ctx.log('CPU: ' + ((os.cpus()[0] || {}).model || '').trim() + ` (${cores} threads)`);
  ctx.log('Testing single-core speed...');
  const single = await benchWorkers(1, 'cpu', 2500); ctx.log(`Single-core: ${single.toFixed(0)} ops/s`); ctx.progress(0.25); live.single = single;
  if (ctx.cancelled()) return {};
  live.phase = 'multi'; ctx.log('Testing multi-core speed...');
  const multi = await benchWorkers(cores, 'cpu', 2500); ctx.log(`Multi-core: ${multi.toFixed(0)} ops/s (${(multi / single).toFixed(1)}x)`); ctx.progress(0.5);
  if (ctx.cancelled()) return {};
  live.phase = 'mem'; ctx.log('Testing memory speed...');
  const mem = await benchWorkers(1, 'mem', 1500); ctx.log(`Memory: ${mem.toFixed(1)} GB/s`); ctx.progress(0.65);
  if (ctx.cancelled()) return {};
  live.phase = 'disk'; ctx.log('Testing system drive speed (256 MB test file)...');
  let dw = 0, dr = 0; const file = path.join(DATA, 'bench.tmp');
  try {
    const st = fs.statfsSync(DATA);
    if (st.bsize * st.bfree < 2 * 1024 ** 3) throw new Error('not enough free space');
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

// ---------- startup apps ----------
const PS_STARTUP = String.raw`$out=@()
function St($root,$kind,$name){ try{ $v=(Get-ItemProperty -Path "$root\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\$kind" -Name $name -ErrorAction Stop).$name; return (($v[0] % 2) -eq 0) }catch{ return $true } }
$defs=@(@('HKCU','Run','HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'),@('HKLM','Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'),@('HKLM','Run32','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'))
foreach($d in $defs){ $k=Get-Item $d[2] -ErrorAction SilentlyContinue; if($k){ foreach($n in $k.GetValueNames()){ if($n){ $out+=@{scope=$d[0];kind=$d[1];name=$n;cmd=[string]$k.GetValue($n);enabled=(St ($d[0]+':') $d[1] $n)} } } } }
$fs=@(@('HKCU',[Environment]::GetFolderPath('Startup')),@('HKLM',[Environment]::GetFolderPath('CommonStartup')))
foreach($f in $fs){ Get-ChildItem $f[1] -File -ErrorAction SilentlyContinue|?{$_.Name -ne 'desktop.ini'}|%{ $out+=@{scope=$f[0];kind='StartupFolder';name=$_.Name;cmd=$_.FullName;enabled=(St ($f[0]+':') 'StartupFolder' $_.Name)} } }
J @{items=@($out)}`;
const PS_STARTUP_SET = String.raw`try{ $p=$env:TQ_SCOPE+':\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\'+$env:TQ_KIND
if(-not(Test-Path $p)){ New-Item $p -Force|Out-Null }
$b=New-Object byte[] 12; $b[0]=$(if($env:TQ_EN -eq '1'){2}else{3})
Set-ItemProperty -Path $p -Name $env:TQ_NAME -Value $b -Type Binary -ErrorAction Stop; J @{ok=$true}
}catch{ J @{ok=$false;error=$_.Exception.Message} }`;

// ---------- voice (fallback when the UI has no speech voice) ----------
const PHRASES = {
  clean: 'Sir, the cleaning is done.', optimize: 'Sir, the optimizing is done.', scan: 'Sir, the security scan is done.',
  update: 'Sir, the updating is done.', analyze: 'Sir, the analysis is done.', check: 'Sir, the update check is done.',
  fail: 'Sir, the task could not be completed.', test: 'Sir, the cleaning and optimizing is done.', speed: 'Sir, the speed test is done.',
};
const PS_SPEAK = String.raw`Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;try{$s.SelectVoiceByHints('Male')}catch{};$s.Speak($env:TQ_TEXT)`;

// ---------- jobs ----------
let job = null, jid = 0;
const running = () => job && job.status === 'running';
const JOBS = {
  junkScan: { title: 'Analyzing junk files', run: async ctx => ({ cats: await scanJunk(ctx) }) },
  clean: { title: 'Deep cleaning', run: (ctx, o) => cleanJunk(ctx, Array.isArray(o.ids) ? o.ids.map(String) : []) },
  boost: { title: 'Boosting performance', run: (ctx, o) => boost(ctx, { dns: !!o.dns, ram: !!o.ram, power: !!o.power, drive: !!o.drive }) },
  optimizeAll: { title: 'Full optimization', run: async ctx => {
    ctx.log('=== [1/3] DEEP CLEAN ===');
    const c = await cleanJunk(ctx, CATS.filter(x => x.def).map(x => x.id), 0, 0.4);
    if (ctx.cancelled()) return c;
    ctx.log('=== [2/3] SPEED BOOST ==='); await boost(ctx, { dns: true, ram: true, power: true }); ctx.progress(0.55);
    if (ctx.cancelled()) return c;
    ctx.log('=== [3/3] SECURITY SCAN ==='); ctx.progress(null);
    const a = await avScan(ctx, false);
    ctx.log('=== OPTIMIZATION COMPLETE ===');
    return { freed: c.freed, threats: a.threats, failed: a.failed };
  } },
  avScan: { title: 'Virus scan', run: (ctx, o) => avScan(ctx, o.mode === 'full') },
  avUpdate: { title: 'Updating virus definitions', run: async ctx => { await ctx.ps(String.raw`try{ L 'Downloading latest definitions...'; Update-MpSignature -ErrorAction Stop; L 'Definitions are up to date' }catch{ L ('ERR '+$_.Exception.Message) }`); return {}; } },
  updScan: { title: 'Scanning for driver & system updates', run: async ctx => (await ctx.ps(PS_UPD_SCAN)).json || { updates: [], problems: [], drivers: [], error: 'Scan failed' } },
  updInstall: { title: 'Installing updates', run: async (ctx, o) => {
    const ids = (Array.isArray(o.ids) ? o.ids : []).map(String).filter(x => /^[0-9a-f-]{36}$/i.test(x));
    if (!ids.length) throw new Error('No updates selected');
    return (await ctx.ps(PS_UPD_INSTALL, { TQ_IDS: ids.join(',') })).json || { installed: 0, failed: 1 };
  } },
  netTest: { title: 'Internet speed test', run: ctx => netTest(ctx) },
  pcTest: { title: 'PC speed test', run: ctx => pcTest(ctx) },
  selfUpdate: { title: 'Updating TupraQ', run: async ctx => {
    const exe = process.env.TQ_EXE;
    if (!exe) throw new Error('Automatic updates work in TupraQ.exe. Download the new version from GitHub instead.');
    ctx.log('Checking GitHub for a new TupraQ version...');
    const info = await updater.check('win');
    if (!info.available) { ctx.log(`TupraQ is up to date (v${info.current}).`); return { upToDate: true }; }
    if (!info.asset) throw new Error(`v${info.latest} has no TupraQ.exe attached yet.`);
    ctx.log(`Downloading TupraQ v${info.latest} (${fmt(info.asset.size)})...`);
    const tmp = exe + '.download', old = exe + '.old';
    try {
      const sha = await updater.download(info.asset.url, tmp, info.asset.size, p => ctx.progress(p));
      if (ctx.cancelled()) throw new Error('cancelled');
      if (info.asset.digest && info.asset.digest.toLowerCase() !== 'sha256:' + sha) throw new Error('The download failed its checksum test and was deleted.');
      ctx.log('Download verified (SHA-256 ' + sha.slice(0, 16) + '...)');
      try { fs.unlinkSync(old); } catch {}
      fs.renameSync(exe, old);          // Windows allows renaming a running exe
      try { fs.renameSync(tmp, exe); } catch (e) { fs.renameSync(old, exe); throw e; }
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    ctx.log(`TupraQ v${info.latest} installed. Restarting...`);
    return { restart: true, version: info.latest };
  } },
  appScan: { title: 'Checking app updates', run: async ctx => {
    ctx.log('Asking winget for available app upgrades...');
    const r = await winget(['upgrade', '--accept-source-agreements', '--disable-interactivity'], ctx);
    if (r.code === -1 || /is not recognized/i.test(r.out)) throw new Error('winget is not available on this PC');
    const apps = parseWinget(r.out); ctx.log(apps.length + ' app update(s) available');
    return { apps };
  } },
  appUpgrade: { title: 'Updating apps', run: async ctx => {
    ctx.log('Upgrading all apps with winget...');
    await winget(['upgrade', '--all', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], ctx, l => { if (!junkLine(l)) ctx.log(l.trim()); });
    ctx.log('App updates finished'); return {};
  } },
};
function startJob(type, opts) {
  const def = JOBS[type];
  if (!def) throw new Error('Unknown task');
  if (running()) throw new Error('Another task is already running');
  const j = job = { id: ++jid, type, title: def.title, status: 'running', progress: null, log: [], result: null, proc: null };
  const ctx = {
    j, log: s => { j.log.push(String(s)); }, progress: p => { j.progress = p; }, cancelled: () => j.status !== 'running',
    ps: (script, env) => ps(script, { env, onLine: l => j.log.push(l), onProc: p => { j.proc = p; } }),
  };
  ctx.log('> ' + def.title + (IS_ADMIN ? '' : '  [limited mode - not running as administrator]'));
  Promise.resolve().then(() => def.run(ctx, opts || {}))
    .then(r => { j.result = r; if (j.status === 'running') j.status = 'done'; })
    .catch(e => { j.log.push('ERROR: ' + e.message); if (j.status === 'running') j.status = 'error'; })
    .finally(() => { j.proc = null; j.progress = 1; });
  return j;
}
function cancelJob() {
  if (!running()) return;
  job.status = 'cancelled'; job.log.push('Cancelled by user');
  if (job.proc && job.proc.pid) execFile('taskkill', ['/PID', String(job.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  if (job.type === 'avScan' || job.type === 'optimizeAll')
    execFile(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'), ['-Scan', '-Cancel'], { windowsHide: true }, () => {});
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); };
const readBody = req => new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 65536) { reject(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } }); });
let lastBeat = Date.now(), byeAt = 0;

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'forbidden' });
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/') {
      if (u.searchParams.get('t') !== TOKEN) { res.writeHead(403); return res.end('TupraQ: please start the app from its launcher.'); }
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
      case '/api/update/check': try { return send(res, 200, await updater.check('win')); } catch (e) { return send(res, 200, { current: updater.VERSION, error: e.message, page: updater.RELEASES }); }
      case '/api/update/open': spawn('cmd.exe', ['/d', '/c', 'start', '', updater.RELEASES], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); return send(res, 200, {});
      case '/api/info': return send(res, 200, { platform: 'win', version: updater.VERSION, selfUpdate: !!process.env.TQ_EXE, admin: IS_ADMIN, host: os.hostname(), os: os.version() + ' (' + os.release() + ')', cpu: (os.cpus()[0] || {}).model || '', cores: os.cpus().length, user: os.userInfo().username, settings, cats: CATS.map(c => ({ id: c.id, name: c.name, desc: c.desc, def: c.def })) });
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
      case '/api/av': { const r = await ps(PS_AV_STATUS); return send(res, 200, r.json || { ok: false, error: 'Could not query Microsoft Defender', products: [], threats: [] }); }
      case '/api/startup': { const r = await ps(PS_STARTUP); return send(res, 200, { items: (r.json && r.json.items) || [] }); }
      case '/api/startup/set': {
        if (!['HKCU', 'HKLM'].includes(body.scope) || !['Run', 'Run32', 'StartupFolder'].includes(body.kind) || typeof body.name !== 'string' || !body.name || body.name.length > 260) return send(res, 400, { error: 'bad request' });
        const r = await ps(PS_STARTUP_SET, { env: { TQ_SCOPE: body.scope, TQ_KIND: body.kind, TQ_NAME: body.name, TQ_EN: body.enabled ? '1' : '0' } });
        return send(res, 200, r.json || { ok: false, error: 'failed' });
      }
      case '/api/speak': { const t = PHRASES[body.key]; if (t) ps(PS_SPEAK, { env: { TQ_TEXT: t } }); return send(res, 200, {}); }
      case '/api/shortcut': {
        const r = await ps(String.raw`try{ $w=New-Object -ComObject WScript.Shell; $l=$w.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'TupraQ.lnk'))
if($env:TQ_EXE){ $l.TargetPath=$env:TQ_EXE }else{ $l.TargetPath=$env:TQ_NODE; $l.Arguments='"'+$env:TQ_SCRIPT+'"' }; $l.WorkingDirectory=$env:TQ_DIR; $l.IconLocation=$env:TQ_ICO; $l.Description='TupraQ PC Optimizer'; $l.Save(); J @{ok=$true} }catch{ J @{ok=$false;error=$_.Exception.Message} }`,
          { env: { TQ_NODE: process.execPath, TQ_SCRIPT: path.join(ROOT, 'server.js'), TQ_DIR: ROOT, TQ_ICO: path.join(UI, 'tupraq.ico') } });
        return send(res, 200, r.json || { ok: false });
      }
      case '/api/elevate': {
        if (IS_ADMIN) return send(res, 200, { ok: true, already: true });
        if (running()) return send(res, 400, { error: 'Wait for the current task to finish' });
        const r = await ps(String.raw`try{ if($env:TQ_EXE){ Start-Process -FilePath $env:TQ_EXE -ArgumentList '--restart' -Verb RunAs -ErrorAction Stop }
else{ Start-Process -FilePath $env:TQ_NODE -ArgumentList ('"'+$env:TQ_SCRIPT+'"'),'--takeover' -Verb RunAs -WindowStyle Hidden -ErrorAction Stop }; J @{ok=$true} }catch{ J @{ok=$false} }`,
          { env: { TQ_NODE: process.execPath, TQ_SCRIPT: path.join(ROOT, 'server.js') } });
        const ok = !!(r.json && r.json.ok); send(res, 200, { ok });
        if (ok) setTimeout(quit, 2500);
        return;
      }
      default: return send(res, 404, { error: 'not found' });
    }
  } catch (e) { try { send(res, 400, { error: e.message }); } catch {} }
});

function quit() { try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (l.token === TOKEN) fs.unlinkSync(LOCK); } catch {} process.exit(0); }
function launchUI(url) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const exe = [pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe', pf + '\\Microsoft\\Edge\\Application\\msedge.exe', pf + '\\Google\\Chrome\\Application\\chrome.exe', pf86 + '\\Google\\Chrome\\Application\\chrome.exe'].find(f => fs.existsSync(f));
  if (exe) spawn(exe, ['--app=' + url, '--user-data-dir=' + path.join(DATA, 'ui'), '--no-first-run', '--no-default-browser-check', '--window-size=1280,840', '--autoplay-policy=no-user-gesture-required'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
function existing() {
  return new Promise(resolve => {
    let l; try { l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return resolve(null); }
    const r = http.get({ host: '127.0.0.1', port: l.port, path: '/api/stats', headers: { 'x-tupraq-token': l.token }, timeout: 1200 }, res => { res.resume(); resolve(res.statusCode === 200 ? l : null); });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
(async () => {
  if (!TAKEOVER && !NO_UI) { const l = await existing(); if (l) { launchUI(`http://127.0.0.1:${l.port}/?t=${l.token}`); return setTimeout(() => process.exit(0), 300); } }
  server.listen(PORT_ARG || 0, '127.0.0.1', () => {
    PORT = server.address().port;
    const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
    try { fs.writeFileSync(LOCK, JSON.stringify({ port: PORT, token: TOKEN })); } catch {}
    console.log('TupraQ running at ' + url);
    if (!NO_UI) {
      launchUI(url);
      // Exit when the window is closed (bye beacon) or the UI stops talking to us.
      setInterval(() => {
        if (running()) return;
        const now = Date.now();
        if ((byeAt && now - byeAt > 4000) || now - lastBeat > 180000) quit();
      }, 2000);
    }
  });
})();
