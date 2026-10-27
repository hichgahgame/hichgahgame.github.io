#!/bin/sh
# Exports the logo SVGs in brand/logo/ to PNGs (transparent background) with headless Chrome,
# then copies the ones games use into brand/unity/. Run after changing a logo SVG.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
mkdir -p logo/png

render() { # svg width height out.png
  printf '<html><body style="margin:0"><img src="%s" width="%s" height="%s" style="display:block"></body></html>' \
    "file://$PWD/$1" "$2" "$3" > "$TMP/page.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$4" "file://$TMP/page.html" 2>/dev/null
}

render logo/hichgah-mark.svg 1024 1024 logo/png/hichgah-mark-1024.png
render logo/hichgah-app-icon.svg 1024 1024 logo/png/hichgah-app-icon-1024.png
render logo/hichgah-logo.svg 2048 521 logo/png/hichgah-logo-2048.png
render logo/hichgah-logo-white.svg 2048 521 logo/png/hichgah-logo-white-2048.png
sips -z 512 512 logo/png/hichgah-mark-1024.png --out logo/png/hichgah-mark-512.png >/dev/null
sips -z 180 180 logo/png/hichgah-app-icon-1024.png --out ../apple-touch-icon.png >/dev/null
sips -z 32 32 logo/png/hichgah-mark-1024.png --out ../favicon-32.png >/dev/null
cp logo/hichgah-mark.svg ../favicon.svg

mkdir -p unity/Assets/Hichgah/Brand/Logo
cp logo/png/hichgah-mark-512.png logo/png/hichgah-app-icon-1024.png logo/png/hichgah-logo-2048.png \
  logo/png/hichgah-logo-white-2048.png unity/Assets/Hichgah/Brand/Logo/
rm -rf "$TMP"
echo "Logo PNGs written to brand/logo/png/, favicons to the site root, game copies to brand/unity/."
