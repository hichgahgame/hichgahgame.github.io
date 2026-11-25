#!/bin/sh
# Runs the voice page and tool tests:  voice/tests/run.sh          (tool + page logic, a few seconds)
#                                      voice/tests/run.sh --e2e    (also the page in headless Chrome, about a minute)
set -e
cd "$(dirname "$0")/../.."
[ -x voice/tools/.venv/bin/python ] || voice/tools/voice --help > /dev/null   # makes the venv
echo "== voice tool (Python)"
voice/tools/.venv/bin/python -m unittest discover -s voice/tools -p 'test_*.py'
echo "== page logic (Node)"
node --test voice/tests/*.test.mjs
if [ "$1" = "--e2e" ]; then
  echo "== the page in headless Chrome"
  node voice/tests/e2e.mjs "$2"
fi
