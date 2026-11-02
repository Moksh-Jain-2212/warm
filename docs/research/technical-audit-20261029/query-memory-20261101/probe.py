# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Pinned, offline revision comparison; no automatic measurement retries."""

import argparse
import copy
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
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
OWNED = ROOT / "target/query-memory-validation"
PLAN = json.loads((HERE / "plan.json").read_text())
TEST = "core::documents::search::campaign_probe::campaign_retrieval_probe"
SETTINGS = {
    "CARGO_TARGET_DIR": "/Users/davidcondrey/.cache/warm-query-memory-target",
    "CARGO_BUILD_JOBS": "2",
    "CARGO_PROFILE_DEV_OPT_LEVEL": "3",
    "CARGO_PROFILE_TEST_OPT_LEVEL": "3",
    "CARGO_PROFILE_DEV_DEBUG": "0",
    "CARGO_PROFILE_TEST_DEBUG": "0",
    "RAYON_NUM_THREADS": "1",
    "TMPDIR": str(OWNED / "tmp"),
}
ORDERS = [
    ["baseline", "sorted", "current"],
    ["current", "sorted", "baseline"],
    ["sorted", "current", "baseline"],
    ["baseline", "current", "sorted"],
    ["current", "baseline", "sorted"],
]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def source_digest(source):
    result = hashlib.sha256()
    paths = sorted((source / "src").rglob("*.rs"))
    paths += [source / name for name in ["Cargo.toml", "Cargo.lock", "build.rs"]]
    for path in paths:
        result.update(str(path.relative_to(source)).encode() + b"\0" + path.read_bytes())
    return result.hexdigest()


def compatible_plan(built_plan, variant, current_plan):
    expected = copy.deepcopy(current_plan)
    if variant != "current":
        expected["revisions"]["current"] = built_plan["revisions"]["current"]
    return built_plan == expected


def build(variant):
    manifest = HERE / f"build-{variant}.json"
    source = OWNED / variant
    if manifest.exists() or source.exists():
        raise RuntimeError("Build/source already exists; retain failed evidence before a new attempt")
    source.mkdir(parents=True)
    revision = PLAN["revisions"]["baseline" if variant == "profile" else variant]
    paths = ["Cargo.toml", "Cargo.lock", "build.rs", "src", "tests", "benches", "examples", "README.md"]
    spec = tomllib.loads(subprocess.check_output(["git", "show", f"{revision}:Cargo.toml"], cwd=ROOT, text=True))
    library_name = spec.get("lib", {}).get("name", spec["package"]["name"].replace("-", "_"))
    for family in ["bin", "bench", "example", "test"]:
        for target in spec.get(family, []):
            path = target.get("path")
            if path and not any(path == root or path.startswith(root + "/") for root in paths):
                paths.append(path)
    process = subprocess.Popen(["git", "archive", revision, *paths], cwd=ROOT, stdout=subprocess.PIPE)
    with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
        archive.extractall(source, filter="data")
    if process.wait():
        raise RuntimeError("Source archive failed")
    probe = (HERE / "retrieval_probe.rs").read_text()
    if variant == "historical":
        probe = probe.replace("WarmConfig", "HmsConfig").replace("WarmCore", "HmsCore")
    (source / "src/core/documents/campaign_probe.rs").write_text(probe)
    with (source / "src/core/documents/search.rs").open("a") as stream:
        stream.write('\n#[cfg(test)]\n#[path = "campaign_probe.rs"]\nmod campaign_probe;\n')
    if variant == "profile":
        from allocation_profile import instrument
        instrument(source)
    command = ["cargo", "+1.99.0", "test", "--offline", "--locked", "--lib", "--no-run", "--message-format=json"]
    record = {
        "variant": variant, "revision": revision, "source_sha256": source_digest(source),
        "probe_sha256": digest(HERE / "retrieval_probe.rs"), "command": command,
        "plan_sha256": digest(HERE / "plan.json"), "plan_source": (HERE / "plan.json").read_text(), "harness_sha256": digest(HERE / "probe.py"),
        "settings": SETTINGS, "default_features": spec.get("features", {}).get("default", []), "status": "building", "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "rustc": subprocess.check_output(["rustc", "+1.99.0", "-Vv"], text=True),
    }
    save(manifest, record)
    executable = None
    log_path = OWNED / f"build-{variant}.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(command, cwd=source, env=dict(os.environ, **SETTINGS), stdout=subprocess.PIPE, stderr=log, text=True)
        for line in process.stdout:
            message = json.loads(line)
            if message.get("reason") == "compiler-message":
                log.write(message["message"].get("rendered", line))
            if message.get("reason") == "compiler-artifact" and message.get("executable") and message["target"]["name"] == library_name and message["profile"]["test"]:
                executable = Path(message["executable"])
        status = process.wait()
    record["exit_code"] = status
    (HERE / f"build-{variant}.log.gz").write_bytes(gzip.compress(log_path.read_bytes(), mtime=0))
    if status or executable is None:
        record["status"] = "failed"
        save(manifest, record)
        raise RuntimeError(f"Build failed: {log_path}")
    binary = OWNED / f"{variant}-probe"
    shutil.copy2(executable, binary)
    record.update(status="built", binary=str(binary), binary_sha256=digest(binary))
    save(manifest, record)
    print(json.dumps({"variant": variant, "status": "built", "source_sha256": record["source_sha256"]}))


def run():
    ledger_path = HERE / "execution.json"
    if ledger_path.exists():
        raise RuntimeError("Execution ledger exists; no automatic retry")
    builds = {name: json.loads((HERE / f"build-{name}.json").read_text()) for name in PLAN["revisions"]}
    for variant, build in builds.items():
        if build["status"] != "built" or digest(Path(build["binary"])) != build["binary_sha256"]:
            raise RuntimeError("Unverified build or changed executable")
        if (build["revision"] != PLAN["revisions"][variant]
                or build["settings"] != SETTINGS
                or build["source_sha256"] != source_digest(OWNED / variant)
                or build["probe_sha256"] != digest(HERE / "retrieval_probe.rs")
                or hashlib.sha256(build["plan_source"].encode()).hexdigest() != build["plan_sha256"]
                or not compatible_plan(json.loads(build["plan_source"]), variant, PLAN)
                or build["harness_sha256"] != digest(HERE / "probe.py")):
            raise RuntimeError(f"Build inputs changed: {variant}")
    observations = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(), "load": os.getloadavg(),
        "system": subprocess.check_output(["uname", "-a"], text=True),
        "processes": subprocess.check_output(["ps", "-axo", "pid,ppid,%cpu,%mem,etime,comm"], text=True),
        "filesystem": subprocess.check_output(["df", "-h", str(OWNED)], text=True),
        "limits": "Desktop host is not isolated; no hardware or production latency claim.",
    }
    save(HERE / "host-observation.json", observations)
    ledger = {
        "budget_seconds": PLAN["execution_budget_seconds"], "execution_seconds": 0,
        "runs": [], "complete": False, "orders": ORDERS, "plan": PLAN,
        "plan_sha256": digest(HERE / "plan.json"),
        "build_sha256": {variant: digest(HERE / f"build-{variant}.json") for variant in builds},
    }
    save(ledger_path, ledger)
    reference = None
    for number, order in enumerate(ORDERS, 1):
        for variant in order:
            remaining = ledger["budget_seconds"] - ledger["execution_seconds"]
            if remaining <= 0:
                raise RuntimeError("Predeclared execution budget exhausted")
            name = f"{variant}-{number}"
            output = OWNED / f"{name}.json"
            log_path = OWNED / f"{name}.log"
            if output.exists() or log_path.exists():
                raise RuntimeError("Measurement artifact already exists")
            command = [builds[variant]["binary"], "--exact", TEST, "--ignored", "--nocapture", "--test-threads=1"]
            environment = dict(os.environ, **SETTINGS, WARM_PROBE_VARIANT=variant, WARM_PROBE_OUT=str(output))
            record = {"name": name, "command": command, "load_before": os.getloadavg(), "status": None, "cross_revision_equal": False}
            start = time.monotonic()
            try:
                with log_path.open("w") as log:
                    result = subprocess.run(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=remaining)
                record["status"] = result.returncode
                if result.returncode:
                    raise RuntimeError(f"Probe failed: {log_path}")
                report = json.loads(output.read_text())
                ordered = [(group["phase"], group["ordered_results"]) for group in report["queries"]]
                if reference is None:
                    reference = ordered
                elif ordered != reference:
                    raise RuntimeError(f"Cross-revision ordered results differ: {name}")
                record["cross_revision_equal"] = True
            finally:
                record["seconds"] = time.monotonic() - start
                record["load_after"] = os.getloadavg()
                ledger["execution_seconds"] += record["seconds"]
                ledger["runs"].append(record)
                for artifact in [output, log_path]:
                    if artifact.exists():
                        destination = HERE / (artifact.name + ".gz")
                        destination.write_bytes(gzip.compress(artifact.read_bytes(), mtime=0))
                        record[artifact.suffix + "_sha256"] = digest(destination)
                save(ledger_path, ledger)
    ledger["complete"] = True
    save(ledger_path, ledger)
    print(json.dumps({"complete": True, "seconds": ledger["execution_seconds"], "runs": len(ledger["runs"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=[*PLAN["revisions"], "profile", "run"])
    args = parser.parse_args()
    if "WARM_PROBE_DISABLE_DELTA" in os.environ:
        raise RuntimeError("WARM_PROBE_DISABLE_DELTA would alter the planned workload")
    (OWNED / "tmp").mkdir(parents=True, exist_ok=True)
    if args.action == "run":
        run()
    else:
        build(args.action)
