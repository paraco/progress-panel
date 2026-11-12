#!/bin/bash
# Builds "Progress Widget.app" into ~/Applications (or the folder given).
#   bash widget/build.sh [destination-folder]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Progress Widget.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -framework Cocoa -framework WebKit "$HERE/ProgressWidget.swift" -o "$APP/Contents/MacOS/ProgressWidget"
cp "$HERE/dashboard.html" "$APP/Contents/Resources/dashboard.html"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Progress Widget</string>
  <key>CFBundleDisplayName</key><string>Progress Widget</string>
  <key>CFBundleIdentifier</key><string>dev.progress-panel.widget</string>
  <key>CFBundleExecutable</key><string>ProgressWidget</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $APP"
