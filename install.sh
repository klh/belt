#!/usr/bin/env bash
# belt installer — deploys the local-LLM fleet scripts to ~/.claude/local-llm
# (the stable runtime path shared with suspenders + speedy-claude) and
# optionally: --with-models runs setup/llm-stack.ts (deps, model downloads,
# metal check, per-port plists), --with-launchd loads the macOS KeepAlive
# agents and supersedes the legacy labels.
# Idempotent: re-running just refreshes the files.
#   ./install.sh [--with-models] [--with-launchd] [--skip-download]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${BELT_PREFIX:-$HOME/.claude/local-llm}"

command -v bun >/dev/null || { echo "belt needs bun — https://bun.sh first"; exit 1; }

WITH_MODELS=false WITH_LAUNCHD=false SKIP_DL=false
for arg in "$@"; do
  case $arg in
    --with-models) WITH_MODELS=true ;;
    --with-launchd) WITH_LAUNCHD=true ;;
    --skip-download) SKIP_DL=true ;;
    *) echo "unknown flag: $arg (use --with-models / --with-launchd / --skip-download)" >&2; exit 1 ;;
  esac
done

echo "→ installing to $PREFIX"
mkdir -p "$PREFIX"
for item in "$REPO_DIR"/bin/*; do
  cp -R "$item" "$PREFIX/"
done
echo "→ fleet scripts in place"

# --with-models / --with-launchd: setup/llm-stack.ts handles homebrew deps
# (bun/uv), the python tooling (mlx-lm, rapid-mlx), model downloads, the Metal
# smoke check, per-port rapid plists and the coordination-plane verification.
# A --with-launchd-only run skips the weight download (add --with-models for
# the ~40-60 GB); --skip-download always passes through.
if $WITH_MODELS || $WITH_LAUNCHD; then
  args=()
  $WITH_MODELS || args+=("--skip-download")
  $WITH_LAUNCHD && args+=("--with-launchd")
  echo "→ running setup/llm-stack.ts ${args[*]:-}"
  bun "$REPO_DIR/setup/llm-stack.ts" ${args[@]+"${args[@]}"}
fi

# --with-launchd: the templated swarm + kev agents. bootout before bootstrap so
# re-runs refresh cleanly. Darwin only.
if $WITH_LAUNCHD; then
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "→ --with-launchd skipped (not macOS)"
  else
    bUid="$(id -u)"
    mkdir -p "$HOME/.claude-insights"
    for f in "$REPO_DIR"/launchd/*.plist; do
      name="$(basename "$f")"
      out="$HOME/Library/LaunchAgents/$name"
      sed -e "s|__HOME__|$HOME|g" "$f" >"$out"
      launchctl bootout "gui/$bUid/${name%.plist}" 2>/dev/null || true
      launchctl bootstrap "gui/$bUid" "$out"
      echo "→ loaded $name"
    done
    # supersede the pre-belt agent labels so old and new never run side by side
    # (same jobs on stale script paths, double swarm starts)
    for legacy in com.klh.local-llm com.klh.kev; do
      launchctl bootout "gui/$bUid/$legacy" 2>/dev/null || true
      if [ -f "$HOME/Library/LaunchAgents/$legacy.plist" ]; then
        rm "$HOME/Library/LaunchAgents/$legacy.plist"
        echo "→ superseded legacy agent $legacy"
      fi
    done
    for stale in "$HOME"/Library/LaunchAgents/com.speedy-claude.llm-*.plist "$HOME"/Library/LaunchAgents/com.klh.llm-*.plist; do
      [ -e "$stale" ] || continue
      label="$(basename "$stale" .plist)"
      launchctl bootout "gui/$bUid/$label" 2>/dev/null || true
      rm "$stale"
      echo "→ superseded legacy agent $label"
    done
  fi
fi

echo
echo "done. next:"
echo "  bun $PREFIX/coordinator.ts status   # every port: up/down, model, RAM"
echo "  bun $PREFIX/swarm.ts start          # start the fleet (or let launchd keep it alive)"
echo "  bun $PREFIX/set-cloud.ts off        # pin the router local-only"
echo "docs: docs/routing.md (routing) · docs/add-a-model.md (add a model) · bench/RESULTS.md"
