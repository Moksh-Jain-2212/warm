"""Aggregate frozen native outputs; no inference or search is performed here."""

import math


def percentile(values, percent):
    if not values or not 0 < percent <= 100:
        raise ValueError("percentile requires samples and 0 < percent <= 100")
    return sorted(values)[math.ceil(percent * len(values) / 100) - 1]


def quality(found, exact, judgments):
    if len(found) != len(set(found)) or len(exact) != len(set(exact)):
        raise ValueError("duplicate result IDs")
    if len(found) > 10 or not exact:
        raise ValueError("wrong result size")
    positives = {key for key, score in judgments.items() if score > 0}
    dcg = sum((2 ** judgments.get(doc, 0) - 1) / math.log2(rank + 2) for rank, doc in enumerate(found))
    ideal = sum((2 ** score - 1) / math.log2(rank + 2) for rank, score in enumerate(sorted(judgments.values(), reverse=True)[:10]))
    return {
        "oracle_recall": len(set(found) & set(exact)) / len(exact),
        "ordered_agreement": found == exact,
        "missed_exact_ids": [doc for doc in exact if doc not in set(found)],
        "qrel_recall": len(set(found) & positives) / len(positives) if positives else None,
        "qrel_ndcg": dcg / ideal if ideal else None,
    }


def summarize_quality(rows):
    if not rows:
        raise ValueError("empty quality rows")
    gold = [row for row in rows if row["qrel_recall"] is not None]
    mean = lambda key, values: sum(row[key] for row in values) / len(values) if values else None
    return {
        "queries": len(rows), "qrel_positive_queries": len(gold),
        "mean_oracle_recall": mean("oracle_recall", rows),
        "worst_oracle_recall": min(row["oracle_recall"] for row in rows),
        "ordered_agreement_queries": sum(row["ordered_agreement"] for row in rows),
        "qrel_recall": mean("qrel_recall", gold), "qrel_ndcg": mean("qrel_ndcg", gold),
    }


def quality_gate(projected, control):
    return {
        "mean_oracle_recall_at_least_099": projected["mean_oracle_recall"] >= 0.99,
        "worst_oracle_recall_at_least_08": projected["worst_oracle_recall"] >= 0.8,
        "matched_control_mean_recall_loss_at_most_0005": control["mean_oracle_recall"] - projected["mean_oracle_recall"] <= 0.005 + 1e-12,
        "matched_control_ndcg_loss_at_most_0005": control["qrel_ndcg"] - projected["qrel_ndcg"] <= 0.005 + 1e-12,
        "matched_control_qrel_recall_loss_at_most_0005": control["qrel_recall"] - projected["qrel_recall"] <= 0.005 + 1e-12,
    }


def latency_gate(projected, control):
    return {
        "p50_improvement_at_least_10_percent": projected["p50"] <= control["p50"] * 0.9,
        "p95_regression_at_most_10_percent": projected["p95"] <= control["p95"] * 1.1,
        "p99_regression_at_most_10_percent": projected["p99"] <= control["p99"] * 1.1,
    }
