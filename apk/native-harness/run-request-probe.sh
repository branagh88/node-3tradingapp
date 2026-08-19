#!/usr/bin/env bash
# Builds + runs the NPE reproduction probe: drives the REAL
# com.getcapacitor.plugin.http.HttpRequestHandler.request(PluginCall, ...)
# path (the native code behind Http.request()) with the exact shapes the
# app's native bridge delivers, proving the NullPointerException root cause
# and that a sanitized request object returns a real HTTP response.
# Usage: bash apk/native-harness/run-request-probe.sh [fixed]
#        REAL_SRC=/path/to/plugin/java/root  (default: node_modules patched source)
#        PROBE_OUT=/tmp/out                  (default)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JDK="${JDK:-/opt/mesh-viewer-data/toolchains/jdk-21.0.12+8}"
SDK="${ANDROID_HOME:-/opt/mesh-viewer-data/toolchains/android-sdk}"
ANDROID_JAR="$SDK/platforms/android-35/android.jar"
H="$ROOT/apk/native-harness"
REAL_SRC="${REAL_SRC:-$ROOT/node_modules/@capacitor-community/http/android/src/main/java}"
OUT="${PROBE_OUT:-/tmp/native-npe-probe-out}"

rm -rf "$OUT"
mkdir -p "$OUT/shim" "$OUT/real"

# Android-framework shims (run ON the desktop JVM instead of android.jar stubs)
"$JDK/bin/javac" -d "$OUT/shim" \
  "$H"/shim/android/os/Build.java "$H"/shim/android/os/LocaleList.java \
  "$H"/shim/android/text/TextUtils.java

# org.json real implementations (android.jar's org.json classes are runtime stubs)
"$JDK/bin/javac" -d "$OUT/shim" \
  "$H"/stub/org/json/JSONException.java "$H"/stub/org/json/JSONObject.java \
  "$H"/stub/org/json/JSONArray.java

# Capacitor-core stubs (JSObject/JSArray/PluginCall)
"$JDK/bin/javac" -d "$OUT/shim" -cp "$ANDROID_JAR" \
  "$H"/stub/com/getcapacitor/JSObject.java "$H"/stub/com/getcapacitor/JSArray.java \
  "$H"/stub/com/getcapacitor/PluginCall.java

"$JDK/bin/javac" -d "$OUT/real" -cp "$OUT/shim:$ANDROID_JAR" \
  -sourcepath "$REAL_SRC:$OUT/shim" "$H/NativeHttpRequestHandlerProbe.java"

exec timeout 90 "$JDK/bin/java" -cp "$OUT/real:$OUT/shim:$ANDROID_JAR" NativeHttpRequestHandlerProbe "$@"
