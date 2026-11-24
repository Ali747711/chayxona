#!/usr/bin/env bash
set -e

# Clear screen for clean capture
printf "\033[2J\033[H"

echo -e "\033[1;32m$\033[0m \033[1mchayxona doctor\033[0m"
sleep 1
node bin/chayxona.mjs doctor
sleep 2

echo ""
echo -e "\033[1;32m$\033[0m \033[1mchayxona debate \"Validate auth token signature before SQL execution\" --fake --no-tui\033[0m"
sleep 1
node bin/chayxona.mjs debate "Validate auth token signature before SQL execution" --fake --no-tui --allow-in-repo
sleep 2
