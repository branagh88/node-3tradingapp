#!/usr/bin/env bash
# Builds + runs the runtime native HTTP probe (desktop JVM harness that drives
# the REAL com.getcapacitor.plugin.http.CapacitorHttpUrlConnection source).
# Usage: bash apk/native-harness/run-probe.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JDK="${JDK:-/opt/mesh-viewer-data/toolchains/jdk-21.0.12+8}"
SDK="${ANDROID_HOME:-/opt/mesh-viewer-data/toolchains/android-sdk}"
ANDROID_JAR="$SDK/platforms/android-35/android.jar"
H="$ROOT/apk/native-harness"
REAL_SRC="$ROOT/node_modules/@capacitor-community/http/android/src/main/java"
OUT="${PROBE_OUT:-/tmp/native-probe-out}"

rm -rf "$OUT"
mkdir -p "$OUT/shim" "$OUT/real"

"$JDK/bin/javac" -d "$OUT/shim" \
  "$H"/shim/android/os/Build.java "$H"/shim/android/os/LocaleList.java \
  "$H"/shim/android/text/TextUtils.java

"$JDK/bin/javac" -d "$OUT/shim" -cp "$ANDROID_JAR" \
  "$H"/stub/com/getcapacitor/JSObject.java "$H"/stub/com/getcapacitor/JSArray.java \
  "$H"/stub/com/getcapacitor/PluginCall.java

"$JDK/bin/javac" -d "$OUT/real" -cp "$OUT/shim:$ANDROID_JAR" \
  -sourcepath "$REAL_SRC:$OUT/shim" "$H/NativeHttpProbe.java"

exec timeout 60 "$JDK/bin/java" -cp "$OUT/real:$OUT/shim:$ANDROID_JAR" NativeHttpProbe