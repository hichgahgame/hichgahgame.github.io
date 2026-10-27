#!/bin/sh
# Copies the generated brand kit (HichgahBrand.cs, its asmdef and the logo PNGs) into each game's
# Assets/Hichgah/Brand/, next to the release kit's Assets/Hichgah/Release/.
#
#   brand/sync-unity.sh                      every game folder beside this repo
#   brand/sync-unity.sh ../Wonderlings ...   only these games
#
# Unity keeps its own .meta files in the game; this never touches them. Commit the result in each game.
set -e
cd "$(dirname "$0")"
SRC="$PWD/unity/Assets/Hichgah/Brand"
[ -f "$SRC/HichgahBrand.cs" ] || { echo "Run brand/build.py and brand/render-logo.sh first." >&2; exit 1; }

if [ $# -eq 0 ]; then
  set --
  for dir in ../../*/; do
    [ -d "$dir/Assets" ] && [ -d "$dir/ProjectSettings" ] && set -- "$@" "$dir"
  done
fi

for game in "$@"; do
  dest="${game%/}/Assets/Hichgah/Brand"
  mkdir -p "$dest/Logo"
  cp "$SRC/HichgahBrand.cs" "$SRC/Hichgah.Brand.asmdef" "$dest/"
  cp "$SRC"/Logo/*.png "$dest/Logo/"
  echo "Synced brand into $dest"
done
