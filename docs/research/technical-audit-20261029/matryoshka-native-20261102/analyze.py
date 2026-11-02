"""Validate compact native results against the full exact arm and aggregate them."""

import argparse
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path

from metrics import latency_gate, percentile, quality, quality_gate, summarize_quality

ARMS = ["exact", "full100", "full50", "prefix256", "prefix512"]
CONDITIONS = [0, 10, 100]


def read(path):
    return json.loads(path.read_text())


def index_records(run, query_ids):
    records = {(record["condition"], record["query_id"]): record for record in run["records"]}
    assert len(records) == len(run["records"]) == 900
    assert set(records) == {(condition, qid) for condition in CONDITIONS for qid in query_ids}
    for record in records.values():
        assert len(record["hits"]) == 10
        assert len({hit["id"] for hit in record["hits"]}) == 10
        assert all(isinstance(hit["score_bits"], int) for hit in record["hits"])
    return records


def summarize_run(run, oracle, manifest):
    queries = manifest["query_ids"]
    documents = {doc: row for row, doc in enumerate(manifest["document_ids"])}
    records = index_records(run, queries)
    summaries = {}
    details = []
    for condition in CONDITIONS:
        rows = []
        routes = Counter()
        latencies = []
        for qi, qid in enumerate(queries):
            record = records[condition, qid]
            reference = oracle[condition, qid]
            found = [hit["id"] for hit in record["hits"]]
            exact = [hit["id"] for hit in reference["hits"]]
            assert all(doc in documents for doc in found)
            assert all(condition == 0 or documents[doc] % condition == qi % condition for doc in found)
            if record.get("exact_hits") is not None:
                assert record["exact_hits"] == reference["hits"], "cross-arm exact score/ID mismatch"
            if condition or run["arm"] == "exact":
                assert record["hits"] == reference["hits"], "exact/filter ranking mismatch"
            gold = {doc: score for doc, score in manifest["qrels"][qid].items() if condition == 0 or documents[doc] % condition == qi % condition}
            row = quality(found, exact, gold)
            rows.append(row)
            routes[record["diagnostics"]["route"]] += 1
            if record["latency_ns"] is not None:
                assert isinstance(record["latency_ns"], int) and record["latency_ns"] > 0
                latencies.append(record["latency_ns"] / 1e6)
            details.append({"condition": condition, "query_id": qid, **row})
        summary = summarize_quality(rows)
        summary["routes"] = dict(routes)
        if condition:
            assert routes == {"filteredExact": 300}
        else:
            expected = {"exact":"fullExact", "full100":"fullGraph", "full50":"fullGraph", "prefix256":"projectedGraph", "prefix512":"projectedGraph"}
            assert routes == {expected[run["arm"]]:300}, "initial route mismatch"
        if latencies:
            assert len(latencies) == 300
            summary["latency_ms"] = {f"p{p}": percentile(latencies, p) for p in [50, 95, 99]}
        summaries[str(condition)] = summary
    return summaries, details


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = read(args.manifest)
    baseline = {arm: read(args.results / f"quality-{arm}.json") for arm in ARMS}
    oracle = index_records(baseline["exact"], manifest["query_ids"])
    summaries, details = {}, {}
    for arm, run in baseline.items():
        assert run["arm"] == arm and not run["measured"]
        summaries[arm], details[arm] = summarize_run(run, oracle, manifest)
    quality_gates = {arm: quality_gate(summaries[arm]["0"], summaries[control]["0"])
                     for arm, control in [("prefix256", "full100"), ("prefix512", "full50")]}
    lifecycle = {arm: read(args.results / f"lifecycle-{arm}.json") for arm in ARMS}
    for arm, run in lifecycle.items():
        assert run["arm"] == arm
        assert run["mutation_pid"] != run["restart_pid"], "lifecycle did not cross a process restart"
        assert [stage["stage"] for stage in run["stages"]] == ["stale", "reopened", "rebuilt"]
        assert all(stage["queries_checked"] == 900 for stage in run["stages"])
    timed = {}
    for rep in range(5):
        for arm in ARMS:
            path = args.results / f"bench-{rep}-{arm}.json"
            if path.exists():
                run = read(path)
                assert run["measured"] and run["arm"] == arm
                summary, per_query = summarize_run(run, oracle, manifest)
                timed[f"{rep}-{arm}"] = summary
                details[f"bench-{rep}-{arm}"] = per_query
    timing_gates, medians = {}, {}
    if timed:
        assert len(timed) == 25, "partial timing run must be reported, not aggregated as complete"
        for arm in ARMS:
            medians[arm] = {str(condition): {p: statistics.median(timed[f"{rep}-{arm}"][str(condition)]["latency_ms"][p] for rep in range(5))
                            for p in ["p50", "p95", "p99"]} for condition in CONDITIONS}
        for arm, control in [("prefix256", "full100"), ("prefix512", "full50")]:
            timing_gates[arm] = latency_gate(medians[arm]["0"], medians[control]["0"])
            timing_gates[arm]["all_queries_used_expected_projected_route"] = all(
                timed[f"{rep}-{arm}"]["0"]["routes"] == {"projectedGraph":300} for rep in range(5))
            timing_gates[arm]["all_control_queries_used_full_graph_route"] = all(
                timed[f"{rep}-{control}"]["0"]["routes"] == {"fullGraph":300} for rep in range(5))
            window = read(args.results / "timing-window.json")
            timing_gates[arm]["quiet_window_qualified"] = window["status"] == "complete" and window["quiet_qualified"]
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.results.glob("*.json"))}
    result = {"baseline_quality": summaries, "quality_gates": quality_gates,
              "timing_replicates": timed, "median_process_percentiles_ms": medians,
              "unfiltered_latency_gates": timing_gates, "native_lifecycle_completed": True,
              "result_hashes": hashes, "per_query": details}
    with args.output.open("x") as stream:
        json.dump(result, stream, separators=(",", ":"))
        stream.write("\n")
    print(json.dumps({"quality_gates": quality_gates, "timing_replicates":len(timed), "latency_gates":timing_gates}))


if __name__ == "__main__":
    main()
