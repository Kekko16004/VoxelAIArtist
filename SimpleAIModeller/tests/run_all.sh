#!/usr/bin/env bash
# Suite offline di SimpleAIModeller. Niente rete, niente cookie, niente quota.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

VOXELAI_PROVIDERS_DIR="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/sam_providers_$$")"
export VOXELAI_PROVIDERS_DIR
mkdir -p "$VOXELAI_PROVIDERS_DIR"
trap 'rm -rf "$VOXELAI_PROVIDERS_DIR"' EXIT

fails=0
run() {
  local label="$1"; shift
  echo ""
  echo "=============================================="
  echo " $label"
  echo "=============================================="
  if "$@"; then
    echo "  -> OK"
  else
    echo "  -> FAIL"
    fails=$((fails + 1))
  fi
}

run "Build UI" node ui/build.mjs
run "Sintassi dei moduli e del bundle" node tests/test_modules.mjs
run "Spec Python" python3 tests/test_spec.py
run "Piano e audit" python3 tests/test_plan.py
run "Vision probe" python3 tests/test_vision.py
run "Geometria JS" node tests/test_geom.mjs
run "Deformatori, bevel, loft" node tests/test_deform.mjs
run "ZIP bundle" node tests/test_zip.mjs
run "Endpoint end-to-end (AI finta)" python3 tests/test_server_e2e.py
run "Chiavi i18n" node tests/test_i18n_keys.mjs

echo ""
echo "=============================================="
if [ "$fails" -eq 0 ]; then
  echo " TUTTI I TEST OK"
  exit 0
else
  echo " FALLITI: $fails"
  exit 1
fi
