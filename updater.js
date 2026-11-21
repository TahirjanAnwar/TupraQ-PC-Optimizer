'use strict';
// TupraQ updater: checks the latest GitHub release and downloads its installer file.
const https = require('https'), fs = require('fs'), crypto = require('crypto');

const VERSION = '1.2.0';                       // bump this (and the release tag) for every new release
const REPO = 'TahirjanAnwar/TupraQ-PC-Optimizer';      // GitHub "owner/name" that publishes releases
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const ALLOWED = /(^|\.)(github\.com|githubusercontent\.com)$/i;

function request(url, onRes, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED.test(u.hostname)) return reject(new Error('Blocked download host: ' + u.hostname));
    const r = https.get(u, { headers: { 'User-Agent': 'TupraQ-Updater', Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'application/octet-stream' }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops > 5) return reject(new Error('Too many redirects'));
        return request(new URL(res.headers.location, url).href, onRes, hops + 1).then(resolve, reject);
      }
      onRes(res, resolve, reject);
    });
    r.on('timeout', () => r.destroy(new Error('GitHub did not answer in time')));
    r.on('error', reject);
  });
}
const getJson = url => request(url, (res, resolve, reject) => {
  let b = ''; res.setEncoding('utf8');
  res.on('data', d => { b += d; }); res.on('error', reject);
  res.on('end', () => {
    if (res.statusCode === 404) return resolve(null);
    if (res.statusCode !== 200) return reject(new Error('GitHub answered ' + res.statusCode));
    try { resolve(JSON.parse(b)); } catch { reject(new Error('Bad answer from GitHub')); }
  });
});

const parts = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
function newer(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }

async function check(platform) {
  const r = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!r) return { current: VERSION, latest: null, available: false, page: RELEASES, asset: null };
  const latest = String(r.tag_name || '').replace(/^v/i, '');
  const want = platform === 'mac' ? /\.dmg$/i : /^TupraQ\.exe$/i;
  const a = (r.assets || []).find(x => want.test(x.name));
  return {
    current: VERSION, latest, available: !!latest && newer(latest, VERSION),
    notes: String(r.body || '').slice(0, 2000), page: r.html_url || RELEASES,
    asset: a ? { name: a.name, size: a.size, url: a.browser_download_url, digest: a.digest || null } : null,
  };
}

// Streams the file to `dest`, reports progress 0..1, and returns its SHA-256 (hex).
function download(url, dest, size, onProgress) {
  return request(url, (res, resolve, reject) => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed (' + res.statusCode + ')')); }
    const total = size || +res.headers['content-length'] || 0, h = crypto.createHash('sha256'), out = fs.createWriteStream(dest);
    let got = 0;
    res.on('data', d => { got += d.length; h.update(d); if (total && onProgress) onProgress(got / total); });
    res.on('error', e => { out.destroy(); reject(e); });
    res.pipe(out);
    out.on('error', reject);
    out.on('finish', () => {
      if (total && got !== total) return reject(new Error('Download was incomplete'));
      resolve(h.digest('hex'));
    });
  });
}

module.exports = { VERSION, REPO, RELEASES, check, download, newer };
