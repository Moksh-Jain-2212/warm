# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Offline, pinned, serial contention comparison; run only in an agreed quiet window."""
import argparse
import base64
import io
import platform
import sys
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
import threading

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
OWNED = ROOT / "target/vector-ci-linux-1024"
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
    engine_vector_sha256 = digest(vector_path)
    # Test-only pause hook is replaced with identical benchmark instrumentation in both revisions.
    vector = vector.replace("        #[cfg(test)]\n        tests::before_canonical_scoring();\n", "")
    marker = "        let k = k.min(self.rows.len());"
    assert vector.count(marker) == 1
    vector = vector.replace(marker, "        contention_probe::scoring_started();\n" + marker)
    vector += '\n#[cfg(test)]\n#[path = "contention_probe.rs"]\nmod contention_probe;\n'
    vector_path.write_text(vector)
    shutil.copy2(HERE / "contention_probe.rs", source / "src/core/documents/contention_probe.rs")
    command = ["cargo", "+1.99.0", "test", "--offline", "--locked", "--lib", "--no-run", "--message-format=json"]
    record = {"revision": revision, "engine_vector_sha256": engine_vector_sha256,
              "original_binary_sha256": json.loads((HERE.parent / f"build-{variant}.json").read_text())["binary_sha256"], "probe_sha256": digest(HERE / "contention_probe.rs"),
              "instrumented_vector_sha256": digest(vector_path), "harness_sha256": digest(HERE / "probe.py"),
              "plan_source": plan, "command": command, "settings": SETTINGS,
              "rustc": subprocess.check_output(["rustc", "+1.99.0", "-Vv"], text=True),
              "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "building"}
    save(manifest, record)
    executable = None
    log_path = HERE / f"build-{variant}.log"
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
    record.update(status="built", binary=str(binary), binary_sha256=digest(binary),
                  finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    save(manifest, record)
    print(json.dumps({"variant": variant, "status": "built"}))


def classify_processes(processes, driver_pid, conditions):
    by_pid = {row["pid"]: row for row in processes}
    excluded = {driver_pid}
    while True:
        children = {row["pid"] for row in processes if row["ppid"] in excluded}
        expanded = excluded | children
        if expanded == excluded:
            break
        excluded = expanded
    ancestor = driver_pid
    while ancestor in by_pid and by_pid[ancestor]["ppid"] not in excluded:
        ancestor = by_pid[ancestor]["ppid"]
        excluded.add(ancestor)
    violations = []
    external_cpu = sum(row["cpu_percent"] for row in processes if row["pid"] not in excluded)
    capacity = external_cpu / conditions["logical_cpu_count"]
    if capacity > conditions["external_cpu_capacity_percent_limit"]:
        violations.append({"reason": "external_cpu_capacity_limit", "capacity_percent": capacity})
    for row in processes:
        if row["pid"] in excluded:
            continue
        reasons = []
        if Path(row["executable"]).name in conditions["unexpected_build_names"]:
            reasons.append("external_build")
        if reasons:
            violations.append({**row, "reasons": reasons})
    return sorted(excluded), violations, external_cpu, capacity


def linux_cpu_observation(path=Path("/proc/stat")):
    try:
        with path.open() as source:
            line = source.readline(8192).strip()
        columns = line.split()
        if not columns or columns[0] != "cpu" or len(columns) < 9:
            raise ValueError("Missing aggregate CPU fields")
        values = [int(value) for value in columns[1:]]
        if any(value < 0 for value in values):
            raise ValueError("Negative CPU counter")
        names = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guest_nice"]
        return {"available": True, "raw_cpu_line": line,
                "ticks": dict(zip(names, values)), "steal_ticks": values[7],
                "clock_ticks_per_second": os.sysconf("SC_CLK_TCK"), "acceptance_gate": False}
    except (OSError, ValueError) as error:
        return {"available": False, "reason": str(error), "acceptance_gate": False}


def observe(plan):
    observation = {"observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "load": os.getloadavg(), "driver_pid": os.getpid(),
                   "system": platform.system(), "machine": platform.machine(),
                   "logical_cpu_count": os.cpu_count(), "linux_cpu": linux_cpu_observation()}
    try:
        raw = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pcpu=,etime=,comm="], text=True, timeout=10)
        processes = []
        for line in raw.splitlines():
            pid, parent, cpu, elapsed, executable = line.strip().split(None, 4)
            processes.append({"pid": int(pid), "ppid": int(parent), "cpu_percent": float(cpu),
                              "elapsed": elapsed, "executable": executable})
        excluded, violations, external_cpu, capacity = classify_processes(processes, os.getpid(), plan["host_conditions"])
        if os.cpu_count() != plan["host_conditions"]["logical_cpu_count"]:
            violations.append({"reason": "logical_cpu_count_changed", "observed": os.cpu_count()})
        if platform.system() != "Linux" or platform.machine() != plan["platform"]["architecture"]:
            violations.append({"reason": "unexpected_platform", "system": platform.system(), "machine": platform.machine()})
        observation.update(processes=processes, excluded_pids=excluded, violations=violations,
                           external_cpu_percent_sum=external_cpu, external_capacity_percent=capacity,
                           host_acceptable=not violations)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        observation.update(error=str(error), host_acceptable=False)
    return observation


def validate_report(report, plan):
    expected = [(dim, phase) for dim in plan["dimensions"] for phase in plan["phases"]]
    if [(group["dimensions"], group["phase"]) for group in report["groups"]] != expected:
        raise RuntimeError("Unexpected report groups")
    for group in report["groups"]:
        if (len(group["samples"]) != plan["samples_per_phase"]
                or len(group["ordered_results"]) != plan["samples_per_phase"]
                or group["oracle_checks"] != plan["samples_per_phase"] + plan["warmup_queries"]):
            raise RuntimeError("Incomplete or unexpected sample/oracle count")


def preflight(plan):
    observations = []
    for index in range(plan["host_conditions"]["preflight_observations"]):
        if index:
            time.sleep(plan["host_conditions"]["preflight_interval_seconds"])
        observations.append(observe(plan))
    path = HERE / "host-availability.json"
    history = json.loads(path.read_text()) if path.exists() else []
    history.append({"plan_sha256": digest(HERE / "plan.json"), "observations": observations,
                    "acceptable": all(row["host_acceptable"] for row in observations)})
    save(path, history)
    return observations


def verify_builds(plan):
    builds = {variant: json.loads((HERE / f"build-{variant}.json").read_text()) for variant in ["baseline", "current"]}
    for variant, record in builds.items():
        source = OWNED / variant / "src/core/documents/vector_index.rs"
        engine = subprocess.check_output(["git", "show", f'{plan[variant]}:src/core/documents/vector_index.rs'], cwd=ROOT)
        if (record["revision"] != plan[variant] or record["status"] != "built"
                or record["engine_vector_sha256"] != hashlib.sha256(engine).hexdigest()
                or record["binary_sha256"] != digest(Path(record["binary"]))
                or record["instrumented_vector_sha256"] != digest(source)
                or record["probe_sha256"] != digest(HERE / "contention_probe.rs")
                or record["probe_sha256"] != digest(source.parent / "contention_probe.rs")
                or record["harness_sha256"] != digest(HERE / "probe.py")
                or record["settings"] != SETTINGS or record["plan_source"] != plan):
            raise RuntimeError(f"Changed build inputs: {variant}")
    for name, expected in plan["original_study"]["files"].items():
        if digest(HERE.parent / name) != expected:
            raise RuntimeError(f"Original study changed: {name}")
    return builds


def run(quiet_grant):
    plan = json.loads((HERE / "plan.json").read_text())
    ledger_path = HERE / "execution.json"
    if ledger_path.exists():
        raise RuntimeError("Existing measurement ledger; no automatic reruns")
    if not quiet_grant:
        raise RuntimeError("An explicit coordinating-agent quiet grant is required")
    builds = verify_builds(plan)
    observations = preflight(plan)
    if not all(row["host_acceptable"] for row in observations):
        save(HERE / "preflight-failure.json", {"status": "blocked_before_measurement",
             "plan_sha256": digest(HERE / "plan.json"), "timing_processes_started": 0,
             "timing_samples_collected": 0, "automatic_retries": 0,
             "quiet_grant": quiet_grant, "observations": observations})
        raise RuntimeError("Host preflight failed; no timing samples were collected")
    ledger = {"plan": plan, "plan_sha256": digest(HERE / "plan.json"), "runs": [], "complete": False,
              "status": "running", "quiet_grant": quiet_grant, "observations": observations,
              "host": subprocess.check_output(["uname", "-a"], text=True),
              "build_sha256": {v: digest(HERE / f"build-{v}.json") for v in builds}, "execution_seconds": 0}
    save(ledger_path, ledger)
    reference = None
    stop = threading.Event()

    def monitor():
        while not stop.wait(plan["host_conditions"]["monitor_interval_seconds"]):
            observations.append(observe(plan))

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    began = time.monotonic()
    try:
        for round_number, order in enumerate(plan["orders"], 1):
            for variant in order:
                if not all(row["host_acceptable"] for row in observations):
                    raise RuntimeError("External host activity observed; retaining partial study without retry")
                stem = f"execution-{round_number}-{variant}"
                output = OWNED / f"{stem}.json"
                log_path = OWNED / f"{stem}.log"
                command = [builds[variant]["binary"], "--exact", TEST, "--ignored", "--nocapture", "--test-threads=1"]
                record = {"name": stem, "variant": variant, "command": command,
                          "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                started = time.monotonic()
                try:
                    remaining = plan["execution_budget_seconds"] - (started - began)
                    if remaining <= 0:
                        raise RuntimeError("Frozen execution budget expired")
                    with log_path.open("w") as log:
                        result = subprocess.run(command, cwd=ROOT,
                                                env=dict(os.environ, **SETTINGS, WARM_PROBE_OUT=str(output)),
                                                stdout=log, stderr=subprocess.STDOUT, timeout=remaining)
                    record["exit_code"] = result.returncode
                    if result.returncode:
                        raise RuntimeError(f"Probe failed: {log_path}")
                    report = json.loads(output.read_text())
                    validate_report(report, plan)
                    ordered = [(g["dimensions"], g["phase"], g["ordered_results"]) for g in report["groups"]]
                    if reference is None:
                        reference = ordered
                    if ordered != reference:
                        raise RuntimeError("Cross-process/revision ordered output mismatch")
                    record["ordered_equal"] = True
                finally:
                    record["seconds"] = time.monotonic() - started
                    for raw_path, suffix in [(output, "json"), (log_path, "log")]:
                        if raw_path.exists():
                            artifact = HERE / f"{stem}.{suffix}.gz"
                            artifact.write_bytes(gzip.compress(raw_path.read_bytes(), mtime=0))
                            record[f"{suffix}_sha256"] = digest(artifact)
                    ledger["runs"].append(record)
                    ledger["execution_seconds"] = time.monotonic() - began
                    observations.append(observe(plan))
                    save(ledger_path, ledger)
                print(json.dumps(record), flush=True)
        if not all(row["host_acceptable"] for row in observations):
            raise RuntimeError("External host activity observed; completed samples remain inconclusive")
        if time.monotonic() - began > plan["execution_budget_seconds"]:
            raise RuntimeError("Frozen execution budget expired")
        ledger.update(complete=True, status="complete")
    except BaseException as error:
        ledger.update(status="inconclusive", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        stop.set()
        watcher.join(timeout=15)
        if watcher.is_alive():
            ledger.update(complete=False, status="inconclusive", error="Host monitor did not stop")
        if not all(row["host_acceptable"] for row in observations):
            ledger.update(complete=False, status="inconclusive", error="External activity or observation failure")
        ledger["execution_seconds"] = time.monotonic() - began
        save(ledger_path, ledger)


def evidence_archive(directory, max_bytes=64 * 1024 * 1024, max_members=1000):
    directory = directory.resolve()
    paths = []
    total = 0
    for path in directory.rglob("*"):
        relative = path.relative_to(directory)
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise RuntimeError(f"Evidence symlink rejected: {relative}")
        if path.is_dir():
            continue
        if not path.is_file() or path.resolve().parent != (directory / relative.parent).resolve():
            raise RuntimeError(f"Unsafe evidence path: {relative}")
        if relative.is_absolute() or any(part in ["", ".", ".."] for part in relative.parts):
            raise RuntimeError(f"Unsafe evidence name: {relative}")
        total += path.stat().st_size
        paths.append((relative.as_posix(), path))
        if total > max_bytes or len(paths) > max_members:
            raise RuntimeError("Evidence input exceeds frozen byte/member bound")
    output = io.BytesIO()
    read_bytes = 0
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, path in sorted(paths):
                with path.open("rb") as source:
                    data = source.read(max_bytes - read_bytes + 1)
                read_bytes += len(data)
                if read_bytes > max_bytes:
                    raise RuntimeError("Evidence grew beyond frozen byte bound")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
    payload = output.getvalue()
    if len(payload) > max_bytes:
        raise RuntimeError("Compressed evidence exceeds frozen byte bound")
    return payload, len(paths), read_bytes


def emit_evidence(directory=HERE, max_bytes=64 * 1024 * 1024):
    payload, members, input_bytes = evidence_archive(directory, max_bytes)
    checksum = hashlib.sha256(payload).hexdigest()
    print("WARM_VECTOR_EVIDENCE_BEGIN " + json.dumps({"version": 1, "bytes": len(payload),
          "sha256": checksum, "members": members, "input_bytes": input_bytes}, separators=(",", ":")))
    encoded = base64.b64encode(payload).decode("ascii")
    for offset in range(0, len(encoded), 16384):
        print("WARM_VECTOR_EVIDENCE_DATA " + encoded[offset:offset + 16384])
    print("WARM_VECTOR_EVIDENCE_END " + checksum, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["build", "preflight", "verify", "run", "emit-evidence"])
    parser.add_argument("variant", nargs="?", choices=["baseline", "current"])
    parser.add_argument("--quiet-grant")
    args = parser.parse_args()
    if args.action == "emit-evidence":
        try:
            emit_evidence()
        except (OSError, RuntimeError, ValueError) as error:
            print("WARM_VECTOR_EVIDENCE_ERROR " + json.dumps({"error": str(error)}), file=sys.stderr)
            raise
    elif args.action == "build":
        build(args.variant)
    elif args.action == "run":
        run(args.quiet_grant)
    elif args.action == "verify":
        verify_builds(json.loads((HERE / "plan.json").read_text()))
        print("Pinned source, harness, executable and original-study hashes match")
    else:
        observations = preflight(json.loads((HERE / "plan.json").read_text()))
        print(json.dumps({"acceptable": all(row["host_acceptable"] for row in observations),
                          "violations": [row.get("violations", row.get("error")) for row in observations]}))
