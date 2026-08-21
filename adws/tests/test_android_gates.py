"""Regression tests for the Android envelope artifact contract.

Root cause being guarded against: android-developer emitted envelope.artifacts
as an OBJECT of build metadata (apk_size_bytes, apk_timestamp,
embedded_build_hash, ...) plus the real APK path. artifacts_exist() stats every
entry as a filesystem path, so numeric/hash metadata were reported as missing
files and the gate failed even though the APK existed on disk.

Contract under test: file artifacts (real paths) live in `artifacts`; build
metadata lives in dedicated structured fields and is NEVER passed to a
path-expecting gate. A genuinely missing APK path must still fail.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adw_modules import gates
from adw_modules.data_types import AndroidDeveloperOutput


class FakeApk:
    """Stands in for the built APK: exists, nonzero, size known."""

    def __init__(self, path: Path, size: int):
        path.write_bytes(b"x" * size)


def _real_apk(tmp_path: Path) -> Path:
    apk = tmp_path / "android" / "app" / "build" / "outputs" / "apk" / "debug"
    apk.mkdir(parents=True)
    p = apk / "app-debug.apk"
    FakeApk(p, 4_450_522)
    return p


def _metadata() -> dict:
    return {
        "apk_size_bytes": 1234567,
        "apk_timestamp": "2025-08-21T20:29:00Z",
        "embedded_build_hash": "abc123",
        "gradle_output": "BUILD SUCCESSFUL in 42s",
        "www_entry": "index.html",
        "verification": "8/8 native checks passed",
    }


def test_metadata_dict_is_never_statted(tmp_path, monkeypatch):
    """The exact failure: dict artifacts with metadata + real APK path. The
    gate must stat ONLY real artifact paths — never '1234567' or 'abc123'."""
    apk = _real_apk(tmp_path)

    statted: list[str] = []
    real_stat = Path.stat

    def spy_stat(self, *a, **kw):
        statted.append(str(self))
        return real_stat(self, *a, **kw)

    monkeypatch.setattr(Path, "stat", spy_stat)

    env = AndroidDeveloperOutput(
        status="success",
        summary="apk built",
        artifacts={
            "apk": str(apk),
            **_metadata(),
        },
        apk_built=True,
        apk_path=str(apk),
    )

    # Metadata was folded into structured fields, not left as fake paths.
    assert env.apk_size_bytes == 1234567
    assert env.apk_timestamp == "2025-08-21T20:29:00Z"
    assert env.embedded_build_hash == "abc123"
    assert env.artifacts == [str(apk)]

    report = gates.artifacts_exist(env, run=None)
    assert report.passed, report.violations

    for s in ("1234567", "abc123", "apk_size_bytes", "embedded_build_hash"):
        assert not any(s in p for p in statted), f"gate statted metadata value {s!r}"
    assert any(p.endswith("app-debug.apk") for p in statted), "gate never checked the APK"


def test_missing_apk_path_still_fails(tmp_path):
    """A genuinely missing APK must fail the existence gate — no weakening."""
    missing = tmp_path / "nope" / "app-debug.apk"
    env = AndroidDeveloperOutput(
        status="success",
        artifacts=[str(missing)],
        apk_built=True,
        apk_path=str(missing),
        **_metadata(),
    )
    report = gates.artifacts_exist(env, run=None)
    assert not report.passed
    assert any("does not exist" in v for v in report.violations)


def test_android_verified_gate_full_coverage(tmp_path):
    """File checks get paths; metadata checks get the structured fields."""
    apk = _real_apk(tmp_path)
    good = AndroidDeveloperOutput(
        status="success",
        artifacts=[str(apk)],
        apk_built=True,
        apk_path=str(apk),
        **_metadata(),
    )
    # declared size must agree with the real file for the gate to pass
    good.apk_size_bytes = apk.stat().st_size
    report = gates.android_verified(good, run=None)
    assert report.passed, report.violations

    # each missing piece of metadata fails its own check
    for field in ("apk_timestamp", "gradle_output", "www_entry",
                  "embedded_build_hash", "verification"):
        bad = good.model_copy(update={field: ""})
        report = gates.android_verified(bad, run=None)
        assert not report.passed, f"empty {field} should fail"
        assert any(field in v for v in report.violations)

    # zero-byte / missing APK fails
    empty = tmp_path / "empty.apk"
    empty.write_bytes(b"")
    bad = good.model_copy(update={"apk_path": str(empty), "artifacts": [str(empty)]})
    assert not gates.android_verified(bad, run=None).passed
    ghost = good.model_copy(update={"apk_path": str(tmp_path / "ghost.apk")})
    assert not gates.android_verified(ghost, run=None).passed

    # conversion-only run (SDK absent) isn't demanded an APK
    conv = AndroidDeveloperOutput(status="success", www_entry="index.html",
                                  converted=True, apk_built=False)
    assert gates.android_verified(conv, run=None).passed
