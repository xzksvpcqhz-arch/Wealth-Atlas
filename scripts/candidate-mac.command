#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  print 'This test package needs Node.js LTS from https://nodejs.org/en/download .'
  print 'Install it yourself, then reopen this file. No software was installed automatically.'
  read -r '?Press Enter to close.'
  exit 1
fi
print 'Open http://127.0.0.1:43175/ in your browser after the server starts.'
print 'Use only the empty test account. Keep this Terminal window open.'
node ./candidate-web-server.mjs
