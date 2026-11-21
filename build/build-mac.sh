#!/bin/bash
# Builds dist/TupraQ.app and dist/TupraQ.dmg. Run this ON A MAC from the TupraQ folder:
#     bash build/build-mac.sh
# It downloads the official Node.js runtime for this Mac's chip and bundles it, so the app
# runs on Macs that do not have Node installed. Build once on Apple Silicon and once on Intel
# if you need both.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="v22.11.0"
case "$(uname -m)" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Unsupported chip: $(uname -m)"; exit 1 ;;
esac

APP="dist/TupraQ.app"
RES="$APP/Contents/Resources"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP" "dist/TupraQ.dmg"
mkdir -p "$APP/Contents/MacOS" "$RES/ui"

echo "Downloading Node.js $NODE_VERSION ($ARCH)..."
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$ARCH.tar.gz" -o "$WORK/node.tgz"
tar -xzf "$WORK/node.tgz" -C "$WORK"
cp "$WORK/node-$NODE_VERSION-darwin-$ARCH/bin/node" "$RES/node"
chmod +x "$RES/node"

echo "Copying app files..."
cp server-mac.js updater.js "$RES/"
cp ui/* "$RES/ui/"

echo "Making the icon..."
# ui/tupraq.ico holds one 256px PNG after a 22-byte header.
tail -c +23 ui/tupraq.ico > "$WORK/logo.png"
ICONSET="$WORK/TupraQ.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256; do
  sips -z $s $s "$WORK/logo.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$WORK/logo.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/TupraQ.icns"

cat > "$APP/Contents/MacOS/TupraQ" <<'EOF'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
exec "$RES/node" "$RES/server-mac.js"
EOF
chmod +x "$APP/Contents/MacOS/TupraQ"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TupraQ</string>
  <key>CFBundleDisplayName</key><string>TupraQ</string>
  <key>CFBundleIdentifier</key><string>app.tupraq.optimizer</string>
  <key>CFBundleVersion</key><string>1.1.0</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>TupraQ</string>
  <key>CFBundleIconFile</key><string>TupraQ</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

echo "Signing (ad-hoc)..."
codesign --force --deep -s - "$APP"

echo "Making the disk image..."
hdiutil create -volname "TupraQ" -srcfolder "$APP" -ov -format UDZO "dist/TupraQ.dmg" >/dev/null

echo
echo "Done:  $APP"
echo "       dist/TupraQ.dmg"
echo "First launch: right-click TupraQ.app > Open (the app is not notarized by Apple)."
