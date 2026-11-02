"""Execute each declared native stage once; timing needs an explicit coordinator grant."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

ARMS = ["exact", "full100", "full50", "prefix256", "prefix512"]


def write(path, value):
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def cpu_seconds(value):
    pieces = value.split(":")
    if len(pieces) not in (2, 3):
        raise ValueError("unrecognized process CPU time")
    return sum(float(piece) * 60 ** i for i, piece in enumerate(reversed(pieces)))


def process_sample():
    output = subprocess.check_output(["ps", "-A", "-o", "pid=,time=,comm="], text=True)
    processes = {}
    for line in output.splitlines():
        pid, cpu, name = line.strip().split(None, 2)
        processes[int(pid)] = {"cpu_seconds": cpu_seconds(cpu), "name": Path(name).name}
    return {"monotonic": time.monotonic(), "unix": time.time(), "processes": processes}


def cpu_interval(before, after, excluded):
    elapsed = after["monotonic"] - before["monotonic"]
    if elapsed <= 0:
        raise ValueError("non-positive CPU sampling interval")
    usage = []
    for pid, now in after["processes"].items():
        if pid in excluded or now["name"] == "ps":
            continue
        previous = before["processes"].get(pid)
        delta = now["cpu_seconds"] - (previous["cpu_seconds"] if previous else 0)
        if delta < 0:
            delta = now["cpu_seconds"]
        usage.append({"pid": pid, "name": now["name"], "cpu_seconds": delta})
    total = sum(row["cpu_seconds"] for row in usage)
    return {
        "unix": after["unix"], "elapsed_seconds": elapsed,
        "external_core_percent": total / elapsed * 100,
        "external_capacity_percent_10_cpus": total / elapsed * 10,
        "new_pids": sorted(set(after["processes"]) - set(before["processes"])),
        "vanished_pids": sorted(set(before["processes"]) - set(after["processes"])),
        "top_external": sorted(usage, key=lambda row: (-row["cpu_seconds"], row["pid"]))[:10],
        "excluded_pids": sorted(excluded),
    }


class Monitor:
    def __init__(self, output):
        self.output = output
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.owned = {os.getpid()}
        self.intervals = []
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            before = process_sample()
            while True:
                stopped = self.stop.wait(5)
                after = process_sample()
                with self.lock:
                    excluded = set(self.owned)
                interval = cpu_interval(before, after, excluded)
                self.intervals.append(interval)
                with self.output.open("a") as stream:
                    stream.write(json.dumps(interval, separators=(",", ":")) + "\n")
                before = after
                if stopped:
                    break
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"

    def add(self, pid):
        with self.lock:
            self.owned.add(pid)

    def finish(self):
        self.stop.set()
        self.thread.join()


def execute(args, stage, arm, output, monitor=None, store=None):
    config = {"input": str(args.data / "input.json"), "vectors": str(args.data / "generated"),
              "store": str(store or args.data / "stores" / arm), "arm": arm, "output": str(output)}
    config_path = args.results / "configs" / (output.stem + ".json")
    if config_path.exists() or output.exists():
        raise FileExistsError(f"refusing repeated stage: {output.name}")
    write(config_path, config)
    with (args.results / "logs" / (output.stem + ".log")).open("x") as log:
        process = subprocess.Popen([str(args.binary), stage, str(config_path)], stdout=log, stderr=subprocess.STDOUT)
        if monitor is not None:
            monitor.add(process.pid)
        try:
            returncode = process.wait()
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
    if returncode:
        raise RuntimeError(f"native stage failed: {stage}/{arm}: exit {returncode}")


def quality_stages(args):
    for arm in ARMS:
        execute(args, "ingest", arm, args.results / f"ingest-{arm}.json")
        execute(args, "quality", arm, args.results / f"quality-{arm}.json")
        lifecycle_store = args.data / "lifecycle" / arm
        shutil.copytree(args.data / "stores" / arm, lifecycle_store)
        mutation_output = args.results / f"mutation-{arm}.json"
        restart_output = args.results / f"restart-{arm}.json"
        execute(args, "mutate", arm, mutation_output, store=lifecycle_store)
        execute(args, "reopen", arm, restart_output, store=lifecycle_store)
        mutation = json.loads(mutation_output.read_text())
        restart = json.loads(restart_output.read_text())
        assert mutation["pid"] != restart["pid"] and mutation["flushed"]
        write(args.results / f"lifecycle-{arm}.json", {"arm":arm, "mutation_pid":mutation["pid"],
              "restart_pid":restart["pid"], "stages":mutation["stages"] + restart["stages"]})


def timing_stages(args):
    if not args.coordinator_grant:
        raise ValueError("timing requires the coordinator's explicit grant")
    receipt_path = args.results / "timing-window.json"
    if receipt_path.exists():
        raise FileExistsError("timing window already attempted; no retry-to-pass")
    receipt = {"coordinator_grant": args.coordinator_grant, "started_unix": time.time(),
               "status": "preflight", "preflight": [], "order": [],
               "cpu_observation": "Process CPU time deltas over five-second intervals, ten-CPU denominator; exited short-lived processes may be unobserved. No host-isolation claim."}
    write(receipt_path, receipt)
    try:
        before = process_sample()
        for _ in range(2):
            time.sleep(5)
            after = process_sample()
            receipt["preflight"].append(cpu_interval(before, after, {os.getpid()}))
            before = after
    except Exception as exc:
        receipt.update(status="preflight_unavailable_no_query_timings_collected", error=f"{type(exc).__name__}: {exc}")
        write(receipt_path, receipt)
        return
    if any(row["external_capacity_percent_10_cpus"] > 20 for row in receipt["preflight"]):
        receipt["status"] = "preflight_failed_no_query_timings_collected"
        write(receipt_path, receipt)
        return
    monitor = Monitor(args.results / "host-monitor.jsonl")
    monitor.thread.start()
    receipt["status"] = "running"
    write(receipt_path, receipt)
    try:
        for rep in range(5):
            for arm in ARMS[rep:] + ARMS[:rep]:
                receipt["order"].append({"replicate": rep, "arm": arm})
                write(receipt_path, receipt)
                execute(args, "bench", arm, args.results / f"bench-{rep}-{arm}.json", monitor)
        receipt["status"] = "complete"
    finally:
        monitor.finish()
        receipt["ended_unix"] = time.time()
        receipt["monitor_error"] = monitor.error
        receipt["observed_external_cpu_peak_capacity_percent"] = max((row["external_capacity_percent_10_cpus"] for row in monitor.intervals), default=None)
        receipt["quiet_qualified"] = bool(monitor.intervals) and monitor.error is None and all(row["external_capacity_percent_10_cpus"] <= 20 for row in monitor.intervals)
        write(receipt_path, receipt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["quality", "timing"])
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--freeze", type=Path, required=True)
    parser.add_argument("--coordinator-grant")
    args = parser.parse_args()
    freeze = json.loads(args.freeze.read_text())
    assert sha256(args.binary) == freeze["retrieval_binary_sha256"]
    assert sha256(args.data / "input.json") == freeze["input_sha256"]
    for name, expected in freeze["vector_sha256"].items():
        assert sha256(args.data / "generated" / name) == expected
    args.results.mkdir(parents=True, exist_ok=True)
    (args.results / "configs").mkdir(exist_ok=True)
    (args.results / "logs").mkdir(exist_ok=True)
    if args.stage == "quality":
        quality_stages(args)
    else:
        timing_stages(args)


if __name__ == "__main__":
    main()
