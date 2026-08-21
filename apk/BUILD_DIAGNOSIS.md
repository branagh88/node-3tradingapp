# Android Debug APK — Build Diagnosis (market-intelligence)

**Date:** 2026-08-21 · **Agent:** ox-alpha · **Project:** node-3tradingapp

## Why previous attempts "produced nothing"

The gate reported declared artifacts did not exist. Investigation of this
environment showed the toolchain **is present but not exposed via env vars**:

- `ANDROID_HOME` was empty; `java` not on PATH (`which java` → not found).
- The real SDK lives at `/opt/mesh-viewer-data/toolchains/android-sdk`
  (build-tools, cmdline-tools, platforms, platform-tools, licenses).
  `android/local.properties` already pointed there correctly.
- JDKs live at `/opt/mesh-viewer-data/toolchains/jdk-17.0.20+8` and
  `/opt/mesh-viewer-data/toolchains/jdk-21.0.12+8` (Temurin).

## Root cause of build failure (reproduced this run)

Running `./gradlew assembleDebug --stacktrace` with `JAVA_HOME` set to
**JDK 17** failed with:

```
> Task :capacitor-android:compileDebugJavaWithJavac FAILED
error: invalid source release: 21
Caused by: java.lang.IllegalArgumentException: error: invalid source release: 21
```

Capacitor 8's android library compiles with Java source/target **21**;
the installed Capacitor Gradle plugin requires a JDK 21 toolchain.
Full failing log preserved at `apk/gradle-diag-oxalpha.log`.

## Fix

Set `JAVA_HOME` to JDK 21 before invoking gradle:

```bash
export JAVA_HOME=/opt/mesh-viewer-data/toolchains/jdk-21.0.12+8
export ANDROID_HOME=/opt/mesh-viewer-data/toolchains/android-sdk
```

Result: `BUILD SUCCESSFUL` (Gradle 8.14.3 wrapper). Final log:
`apk/gradle-final.log`. Verified via sha256 that
`android/app/build/outputs/apk/debug/app-debug.apk` and
`apk/market-intelligence-debug.apk` are identical
(4,214,184 bytes; sha256 d8c7f0057e1c…d2cd2).

## Canonical build recipe (works on any machine with these paths)

```bash
# 1. Web assets -> www/ (already done; entry = index.html at repo root)
mkdir -p www && cp index.html app.js style.css config.js api.js secure-store.js \
  build-info.js assets.js charts.js indicators.js market-data.js storage.js \
  utils.js alerts.js notifications.js ai-engine.js Marketanalysis.js \
  pattern-engine.js prediction-engine.js www/
cp -r vendor www/ 2>/dev/null || true

# 2. Sync Capacitor
npx cap sync android

# 3. Build (JDK 21 REQUIRED)
export JAVA_HOME=<path-to-jdk-21>
export ANDROID_HOME=<path-to-android-sdk>
cd android && ./gradlew assembleDebug --stacktrace

# 4. Artifact
#    android/app/build/outputs/apk/debug/app-debug.apk
cp app/build/outputs/apk/debug/app-debug.apk ../apk/market-intelligence-debug.apk
```

If the studio machine uses `G:\android-sdk` (Windows), substitute
`ANDROID_HOME=G:/android-sdk` and set `JAVA_HOME` to any JDK 21 install;
everything else is identical.

## Asset sync verification (www vs android/app/src/main/assets/public)

Verified byte-identical via `cmp`: app.js, index.html, secure-store.js,
build-info.js, style.css, config.js, api.js — all SYNCED after
`npx cap sync android`. Also verified inside the APK zip itself:
`assets/public/{index.html,app.js,build-info.js}` match `www/` exactly.

## Install on a device

```bash
adb install -r apk/market-intelligence-debug.apk
```
