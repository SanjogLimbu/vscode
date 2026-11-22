#!/usr/bin/env bash
# Launches the built app on the issue's main.js and drives it with driver.cjs.
set -uo pipefail

VARIANT="$1"
ROOT="$PWD"
OUT="$ROOT/selection-check-results"
WORKSPACE="$RUNNER_TEMP/selection-workspace"
PROFILE="$RUNNER_TEMP/selection-profile-$VARIANT"
EXTENSIONS="$RUNNER_TEMP/selection-extensions"
mkdir -p "$OUT" "$WORKSPACE/.vscode" "$PROFILE/User" "$EXTENSIONS"

cat > "$WORKSPACE/main.js" <<'EOF'
for (let i = 0; i < 10000; i++) {
    console.log(i);
}
EOF
cat > "$WORKSPACE/.vscode/launch.json" <<'EOF'
{
	"version": "0.2.0",
	"configurations": [
		{ "type": "node", "request": "launch", "name": "Run main.js", "program": "${workspaceFolder}/main.js", "console": "internalConsole" }
	]
}
EOF
cat > "$PROFILE/User/settings.json" <<'EOF'
{
	"security.workspace.trust.enabled": false,
	"workbench.startupEditor": "none",
	"window.menuStyle": "custom",
	"window.restoreWindows": "none",
	"debug.internalConsoleOptions": "openOnSessionStart",
	"telemetry.telemetryLevel": "off",
	"update.mode": "none"
}
EOF

EXTRA_ARGS=()
if [ "$RUNNER_OS" = "Linux" ]; then
	export DISPLAY=:10
	EXTRA_ARGS+=(--no-sandbox --disable-gpu)
fi

export VSCODE_SKIP_PRELAUNCH=1
"$ROOT/scripts/code.sh" "$WORKSPACE" "$WORKSPACE/main.js" \
	--user-data-dir="$PROFILE" --extensions-dir="$EXTENSIONS" --remote-debugging-port=9333 \
	--new-window --skip-welcome --skip-release-notes --disable-updates --use-inmemory-secretstorage \
	${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} > "$OUT/$VARIANT-app.log" 2>&1 &

curl -s --retry 90 --retry-delay 2 --retry-all-errors --max-time 3 http://127.0.0.1:9333/json/version > /dev/null
node "$ROOT/.github/selection-check/driver.cjs" "$VARIANT" "$OUT/$VARIANT.json"
CODE=$?

pkill -f "remote-debugging-port=9333" || true
for _ in $(seq 1 30); do
	curl -s --max-time 1 http://127.0.0.1:9333/json/version > /dev/null || break
	sleep 1
done
pkill -9 -f "remote-debugging-port=9333" || true
sleep 2
exit $CODE
