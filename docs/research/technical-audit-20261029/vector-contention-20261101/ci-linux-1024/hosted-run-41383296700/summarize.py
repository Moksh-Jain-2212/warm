# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Summarize fixed raw samples without filtering or rerunning measurements."""
import gzip
import json
import math
from pathlib import Path
from statistics import median

from probe import digest, validate_report

HERE = Path(__file__).resolve().parent


def quantile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def summarize():
    ledger = json.loads((HERE / "execution.json").read_text())
    assert ledger["complete"] and ledger["status"] == "complete"
    plan = ledger["plan"]
    assert ledger["plan_sha256"] == digest(HERE / "plan.json")
    assert all(row["host_acceptable"] for row in ledger["observations"])
    assert [(run["variant"]) for run in ledger["runs"]] == [v for order in plan["orders"] for v in order]
    assert all(run["ordered_equal"] and run["exit_code"] == 0 for run in ledger["runs"])
    groups = {}
    checks = 0
    for run in ledger["runs"]:
        report = json.loads(gzip.decompress((HERE / f'{run["name"]}.json.gz').read_bytes()))
        validate_report(report, plan)
        assert digest(HERE / f'{run["name"]}.json.gz') == run["json_sha256"]
        assert digest(HERE / f'{run["name"]}.log.gz') == run["log_sha256"]
        for group in report["groups"]:
            checks += group["oracle_checks"]
            key = (group["dimensions"], group["phase"], run["variant"])
            output = groups.setdefault(key, [])
            sample = {}
            for metric in ["query_ns", "writer_wait_ns", "writer_total_ns", "peak_requested_bytes", "allocations"]:
                values = [row[metric] for row in group["samples"]]
                for name, fraction in [("p50", .5), ("p99", .99)]:
                    sample[f"{metric}_{name}"] = quantile(values, fraction)
            output.append(sample)
    rows = []
    for dim in [16, 128, 768]:
        for phase in ["fresh_idle", "stale_idle", "stale_writer"]:
            variants = {variant: {metric: median(process[metric] for process in groups[dim, phase, variant])
                                  for metric in groups[dim, phase, variant][0]}
                        for variant in ["baseline", "current"]}
            delta = {metric: (variants["current"][metric] / value - 1) * 100 if value else None
                     for metric, value in variants["baseline"].items()}
            rows.append({"dimensions": dim, "phase": phase, **variants, "delta_percent": delta})
    summary = {"original_study_query_gate": "failed; retained unchanged",
               "confirmation_scope": "Linux x64 standard public ubuntu-24.04 VM, 1024 samples per phase, fixed synthetic workload, observed external CPU capacity <=20%; no macOS, production or isolated-host qualification",
               "oracle_checks": checks, "processes": len(ledger["runs"]),
               "execution_seconds": ledger["execution_seconds"], "rows": rows,
               "query_acceptance": all(row["delta_percent"][f"query_ns_{q}"] <= 15
                                       for row in rows if row["phase"] != "stale_writer" for q in ["p50", "p99"]),
               "writer_acceptance": all(row["delta_percent"]["writer_wait_ns_p50"] <= -50
                                        for row in rows if row["phase"] == "stale_writer" and row["dimensions"] in [128, 768])}
    summary["confirmation_acceptance"] = summary["query_acceptance"] and summary["writer_acceptance"]
    cpu = [row["linux_cpu"] for row in ledger["observations"] if row.get("linux_cpu", {}).get("available")]
    summary["linux_steal_observation"] = {"samples": len(cpu), "acceptance_gate": False}
    if cpu:
        summary["linux_steal_observation"].update(first_ticks=cpu[0]["steal_ticks"], last_ticks=cpu[-1]["steal_ticks"],
                                                delta_ticks=cpu[-1]["steal_ticks"] - cpu[0]["steal_ticks"])
    (HERE / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    if not summary["confirmation_acceptance"]:
        raise SystemExit(1)


if __name__ == "__main__":
    summarize()
