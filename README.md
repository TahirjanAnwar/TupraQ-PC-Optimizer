# TupraQ — PC Optimizer

A cyber-styled PC optimizer: deep clean, speed boost, antivirus scan, driver and app updates,
internet and PC speed tests — with six themes and a voice that tells you
*"Sir, the cleaning is done."* when a task finishes.

## Download

**Windows 10 / 11:** download **`TupraQ.exe`** from the [Releases](../../releases/latest) page and double-click it.

- It's a single file with nothing to install. On first run it unpacks itself to `%LOCALAPPDATA%\TupraQ\app`.
- It asks for administrator permission, which the deep clean and driver installs need.
- The exe isn't code-signed, so Windows SmartScreen may say *"Windows protected your PC"*. Click **More info → Run anyway**.
- To pin it, right-click TupraQ on the taskbar → **Pin to taskbar**.

**macOS:** there's no ready-made download yet. Build it on a Mac, as described under **Build** below.
The Mac version hasn't been tested on a real Mac yet; please report problems in Issues.

## Features

| | Windows | macOS |
|---|---|---|
| **Deep Clean** | Temp files, browser caches, Windows Update leftovers, crash dumps, thumbnail & shader caches, old logs, Recycle Bin | App & browser caches, temp files, logs, crash reports, Xcode cache, Trash |
| **Speed Boost** | Free memory, flush DNS, High performance power plan, drive TRIM/defrag, startup apps on/off | Memory purge, DNS flush, startup agents on/off |
| **Antivirus** | Microsoft Defender quick/full scan, definition updates, automatic quarantine | XProtect / Gatekeeper / firewall status; scans with ClamAV if installed |
| **Updates** | Driver & Windows updates (Windows Update), device problem check, app updates (winget) | macOS updates (Software Update), Homebrew packages |
| **Speed Test** | Ping / download / upload (Cloudflare), PC benchmark score | Same |
| **Themes** | Cyber Core, Hacker, Cyberpunk City, Vice Sunset, Blox, Pixel Quest | Same |

Your documents, downloads, passwords and browser history are never touched. The Recycle Bin / Trash
is only emptied if you tick it.

## Build

**Windows exe** (needs Node.js and the .NET Framework 4.x compiler, which Windows already includes):

```powershell
powershell -ExecutionPolicy Bypass -File build\build.ps1
```

This produces `dist\TupraQ.exe`, which bundles your local `node.exe` and the WebView2 SDK files in `build\webview2`.

**macOS app** (run on a Mac; downloads Node.js automatically):

```bash
bash build/build-mac.sh
```

This produces `dist/TupraQ.app` and `dist/TupraQ.dmg`. On the first launch, right-click → **Open**, because the app isn't notarized.

**Run from source:** `node server.js` on Windows or `node server-mac.js` on a Mac. The app opens in an Edge/Chrome app window.

## How it works

A small local engine (`server.js` / `server-mac.js`) listens only on `127.0.0.1` with a random port and a
one-time token, and runs the system tasks. The interface (`ui/`) is plain HTML/CSS/JS.
On Windows, `TupraQ.exe` shows it in its own WebView2 window.

The only internet connections are the ones you start: the speed test (`speed.cloudflare.com`),
Windows Update / Software Update, Defender definitions, and winget / Homebrew.

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
