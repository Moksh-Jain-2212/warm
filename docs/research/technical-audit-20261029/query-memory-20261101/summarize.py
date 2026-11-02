# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Report process-round comparisons without treating queries as independent runs."""

import gzip
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import statistics

HERE = Path(__file__).resolve().parent


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * fraction) - 1]


def summarize():
    ledger = json.loads((HERE / "execution.json").read_text())
    plan = ledger["plan"]
    plan_data = (HERE / "plan.json").read_bytes()
    if (hashlib.sha256(plan_data).hexdigest() != ledger["plan_sha256"]
            or json.loads(plan_data) != plan):
        raise ValueError("Plan changed after execution")
    expected = [f"{variant}-{number}" for number, order in enumerate(ledger["orders"], 1) for variant in order]
    if (not ledger["complete"] or len(expected) != plan["workload"]["rounds"] * len(plan["revisions"])
            or [run["name"] for run in ledger["runs"]] != expected
            or not all(run["status"] == 0 and run["cross_revision_equal"] for run in ledger["runs"])):
        raise ValueError("Execution is incomplete or failed")
    reports = {variant: [] for variant in plan["revisions"]}
    for variant, checksum in ledger["build_sha256"].items():
        if hashlib.sha256((HERE / f"build-{variant}.json").read_bytes()).hexdigest() != checksum:
            raise ValueError(f"Build manifest changed: {variant}")
    for run in ledger["runs"]:
        data = (HERE / (run["name"] + ".json.gz")).read_bytes()
        if hashlib.sha256(data).hexdigest() != run[".json_sha256"]:
            raise ValueError(f"Report changed: {run['name']}")
        report = json.loads(gzip.decompress(data))
        variant = run["name"].rsplit("-", 1)[0]
        if report["variant"] != variant:
            raise ValueError(f"Report variant differs: {run['name']}")
        reports[variant].append(report)
    reference = None
    for runs in reports.values():
        for run in runs:
            ordered = [(group["phase"], group["ordered_results"]) for group in run["queries"]]
            if reference is None:
                reference = ordered
            if ordered != reference:
                raise ValueError("Complete ordered results differ")
    result = {
        "revisions": plan["revisions"], "execution_seconds": ledger["execution_seconds"],
        "exhaustive_ordered_result_equalities": sum(group["oracle_checks"] for runs in reports.values() for run in runs for group in run["queries"]),
        "complete_cross_revision_results_equal": True,
        "independent_rounds_per_variant": 5, "samples_per_group_per_round": 128,
        "method": "Within-round nearest-rank quantiles, paired round ratios and median of round quantiles. Empirical p99 is not a population-tail guarantee. No pooled-query significance claim.",
        "groups": {}, "memory_samples": {}, "lifecycle": {}, "limits": plan["limits"],
    }
    for phase in ["initial", "updated"]:
        for hot in [False, True]:
            metrics = {}
            for metric in ["prepare_ns", "capture_ns", "execute_ns", "total_ns", "allocations", "peak_requested_bytes"]:
                for fraction in ([0.5, 0.95, 0.99] if metric.endswith("_ns") else [0.5]):
                    rounds = {}
                    for variant, runs in reports.items():
                        rounds[variant] = [
                            percentile([sample[metric] for sample in next(group for group in run["queries"] if group["phase"] == phase)["samples"] if sample["hot"] == hot], fraction)
                            for run in runs
                        ]
                    comparisons = {}
                    for candidate in ["sorted", "current"]:
                        paired = [100 * (current / previous - 1) for previous, current in zip(rounds["baseline"], rounds[candidate])]
                        change = 100 * (statistics.median(rounds[candidate]) / statistics.median(rounds["baseline"]) - 1)
                        comparisons[candidate] = {
                            "median_quantile_change_percent": change,
                            "paired_change_percent": paired,
                            "median_paired_change_percent": statistics.median(paired),
                            "sustained_above_five_percent": change > 5 and sum(value > 0 for value in paired) >= 4,
                        }
                    metrics[f"{metric}_p{round(fraction * 100)}"] = {
                        "rounds": rounds,
                        "median": {variant: statistics.median(values) for variant, values in rounds.items()},
                        "candidate_comparisons": comparisons,
                    }
            result["groups"][f"{phase}-{'hot' if hot else 'rare'}"] = metrics
            result["memory_samples"][f"{phase}-{'hot' if hot else 'rare'}"] = {
                variant: [
                    {
                        "first_query_peak": samples[0]["peak_requested_bytes"],
                        "peak_counts": dict(sorted(Counter(sample["peak_requested_bytes"] for sample in samples).items())),
                    }
                    for run in runs
                    for samples in [[sample for group in run["queries"] if group["phase"] == phase for sample in group["samples"] if sample["hot"] == hot]]
                ]
                for variant, runs in reports.items()
            }
    for variant, runs in reports.items():
        result["lifecycle"][variant] = {
            "initial_train_ns": [run["initial_train_ns"] for run in runs],
            "maintenance_rebuilds": [run["maintenance_rebuilds"] for run in runs],
            "update_and_maintenance_ns": [sum(mutation["update_ns"] + mutation["maintenance_ns"] for mutation in run["mutations"]) for run in runs],
            "reopen_ns": [run["engine_lifecycle"]["reopen_ns"] for run in runs],
        }
    return result


if __name__ == "__main__":
    result = summarize()
    (HERE / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"checks": result["exhaustive_ordered_result_equalities"], "seconds": result["execution_seconds"], "updated_hot": result["groups"]["updated-hot"]["total_ns_p99"]}, indent=2))
