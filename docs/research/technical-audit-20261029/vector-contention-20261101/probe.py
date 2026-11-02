# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Offline, pinned, serial contention comparison; run only in an agreed quiet window."""
import argparse
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
OWNED = ROOT / "target/vector-contention"
TEST = "core::documents::vector_index::contention_probe::vector_contention_probe"
SETTINGS = {"CARGO_TARGET_DIR": str(OWNED / "build"), "CARGO_BUILD_JOBS": "2",
            "CARGO_PROFILE_DEV_OPT_LEVEL": "3", "CARGO_PROFILE_TEST_OPT_LEVEL": "3",
            "CARGO_PROFILE_DEV_DEBUG": "0", "CARGO_PROFILE_TEST_DEBUG": "0",
            "RAYON_NUM_THREADS": "1"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def build(variant):
    plan = json.loads((HERE / "plan.json").read_text())
    revision = plan[variant]
    if not revision:
        raise RuntimeError("Pin source before building")
    source = OWNED / variant
    manifest = HERE / f"build-{variant}.json"
    if source.exists() or manifest.exists():
        raise RuntimeError("Existing build evidence; inspect and retain before retry")
    source.mkdir(parents=True)
    process = subprocess.Popen(["git", "archive", revision], cwd=ROOT, stdout=subprocess.PIPE)
    with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
        archive.extractall(source, filter="data")
    if process.wait():
        raise RuntimeError("Archive failed")
    vector_path = source / "src/core/documents/vector_index.rs"
    vector = vector_path.read_text()
    # Test-only pause hook is replaced with identical benchmark instrumentation in both revisions.
    vector = vector.replace("        #[cfg(test)]\n        tests::before_canonical_scoring();\n", "")
    marker = "        let k = k.min(self.rows.len());"
    assert vector.count(marker) == 1
    vector = vector.replace(marker, "        contention_probe::scoring_started();\n" + marker)
    vector += '\n#[cfg(test)]\n#[path = "contention_probe.rs"]\nmod contention_probe;\n'
    vector_path.write_text(vector)
    shutil.copy2(HERE / "contention_probe.rs", source / "src/core/documents/contention_probe.rs")
    command = ["cargo", "+1.99.0", "test", "--offline", "--locked", "--lib", "--no-run", "--message-format=json"]
    record = {"revision": revision, "probe_sha256": digest(HERE / "contention_probe.rs"),
              "instrumented_vector_sha256": digest(vector_path), "harness_sha256": digest(HERE / "probe.py"),
              "plan_source": plan, "command": command, "settings": SETTINGS,
              "rustc": subprocess.check_output(["rustc", "+1.99.0", "-Vv"], text=True),
              "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "building"}
    save(manifest, record)
    executable = None
    log_path = OWNED / f"build-{variant}.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(command, cwd=source, env=dict(os.environ, **SETTINGS), stdout=subprocess.PIPE, stderr=log, text=True)
        for line in process.stdout:
            message = json.loads(line)
            if message.get("reason") == "compiler-message":
                log.write(message["message"].get("rendered", line))
            if message.get("reason") == "compiler-artifact" and message.get("executable") and message["target"]["name"] == "writerslogic_warm" and message["profile"]["test"]:
                executable = Path(message["executable"])
        status = process.wait()
    (HERE / f"build-{variant}.log.gz").write_bytes(gzip.compress(log_path.read_bytes(), mtime=0))
    record["exit_code"] = status
    if status or executable is None:
        record["status"] = "failed"
        save(manifest, record)
        raise RuntimeError(f"Build failed: {log_path}")
    binary = OWNED / f"{variant}-probe"
    shutil.copy2(executable, binary)
    record.update(status="built", binary=str(binary), binary_sha256=digest(binary))
    save(manifest, record)
    print(json.dumps({"variant": variant, "status": "built"}))


def run(diagnostic):
    plan = json.loads((HERE / "plan.json").read_text())
    name = "diagnostic" if diagnostic else "execution"
    ledger_path = HERE / f"{name}.json"
    if ledger_path.exists():
        raise RuntimeError("Existing measurement ledger; no automatic reruns")
    orders = [["baseline"]] if diagnostic else plan["orders"]
    builds = {v: json.loads((HERE / f"build-{v}.json").read_text()) for order in orders for v in order}
    for variant, record in builds.items():
        source = OWNED / variant / "src/core/documents/vector_index.rs"
        built_plan = dict(record["plan_source"])
        built_plan["current"] = plan["current"]
        if (record["revision"] != plan[variant] or record["status"] != "built"
                or record["binary_sha256"] != digest(Path(record["binary"]))
                or record["instrumented_vector_sha256"] != digest(source)
                or record["probe_sha256"] != digest(HERE / "contention_probe.rs")
                or record["harness_sha256"] != digest(HERE / "probe.py")
                or record["settings"] != SETTINGS or built_plan != plan):
            raise RuntimeError(f"Changed build inputs: {variant}")
    ledger = {"plan": plan, "plan_sha256": digest(HERE / "plan.json"), "runs": [], "complete": False,
              "host": subprocess.check_output(["uname", "-a"], text=True), "load_before": os.getloadavg(),
              "processes_before": subprocess.check_output(["ps", "-axo", "pid,ppid,%cpu,%mem,etime,comm"], text=True),
              "build_sha256": {v: digest(HERE / f"build-{v}.json") for v in builds}, "execution_seconds": 0}
    save(ledger_path, ledger)
    reference = None
    for round_number, order in enumerate(orders, 1):
        for variant in order:
            stem = f"{name}-{round_number}-{variant}"
            output = OWNED / f"{stem}.json"
            log_path = OWNED / f"{stem}.log"
            command = [builds[variant]["binary"], "--exact", TEST, "--ignored", "--nocapture", "--test-threads=1"]
            started = time.monotonic()
            record = {"name": stem, "variant": variant, "command": command}
            try:
                with log_path.open("w") as log:
                    result = subprocess.run(command, cwd=ROOT, env=dict(os.environ, **SETTINGS, WARM_PROBE_OUT=str(output)),
                                            stdout=log, stderr=subprocess.STDOUT, timeout=plan["execution_budget_seconds"] - ledger["execution_seconds"])
                record["exit_code"] = result.returncode
                if result.returncode:
                    raise RuntimeError(f"Probe failed: {log_path}")
                report = json.loads(output.read_text())
                ordered = [(g["dimensions"], g["phase"], g["ordered_results"]) for g in report["groups"]]
                if reference is None:
                    reference = ordered
                assert ordered == reference, "Cross-process/revision ordered output mismatch"
                record["ordered_equal"] = True
                (HERE / f"{stem}.json.gz").write_bytes(gzip.compress(output.read_bytes(), mtime=0))
            finally:
                record["seconds"] = time.monotonic() - started
                ledger["execution_seconds"] += record["seconds"]
                ledger["runs"].append(record)
                (HERE / f"{stem}.log.gz").write_bytes(gzip.compress(log_path.read_bytes(), mtime=0))
                save(ledger_path, ledger)
            print(json.dumps(record), flush=True)
    ledger["complete"] = True
    save(ledger_path, ledger)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["build", "diagnostic", "run"])
    parser.add_argument("variant", nargs="?", choices=["baseline", "current"])
    args = parser.parse_args()
    if args.action == "build":
        build(args.variant)
    else:
        run(args.action == "diagnostic")
