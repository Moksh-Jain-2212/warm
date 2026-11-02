import math
import unittest

from metrics import latency_gate, percentile, quality, quality_gate, summarize_quality


class MetricsTests(unittest.TestCase):
    def test_independent_graded_ndcg_and_recall(self):
        result = quality(["b", "z", "a"], ["a", "b", "c"], {"a": 2, "b": 1, "c": 1})
        expected_dcg = 1 + 3 / 2
        expected_idcg = 3 + 1 / math.log2(3) + 1 / 2
        self.assertAlmostEqual(result["qrel_ndcg"], expected_dcg / expected_idcg)
        self.assertEqual(result["qrel_recall"], 2 / 3)
        self.assertEqual(result["oracle_recall"], 2 / 3)
        self.assertEqual(result["missed_exact_ids"], ["c"])
        self.assertFalse(result["ordered_agreement"])

    def test_zero_positive_query_kept_for_oracle_only(self):
        empty = quality(["a"], ["a"], {})
        positive = quality(["a"], ["a"], {"a": 1})
        summary = summarize_quality([empty, positive])
        self.assertEqual(summary["queries"], 2)
        self.assertEqual(summary["qrel_positive_queries"], 1)
        self.assertEqual(summary["mean_oracle_recall"], 1)
        self.assertEqual(summary["qrel_ndcg"], 1)

    def test_nearest_rank_300_and_singleton(self):
        values = list(range(300, 0, -1))
        self.assertEqual([percentile(values, p) for p in [50, 95, 99]], [150, 285, 297])
        self.assertEqual(percentile([7], 99), 7)
        with self.assertRaises(ValueError):
            percentile([], 99)

    def test_gates_at_boundaries(self):
        control = {"mean_oracle_recall": .995, "qrel_ndcg": .8, "qrel_recall": .7}
        base = {"mean_oracle_recall": .99, "worst_oracle_recall": .8, "qrel_ndcg": .795, "qrel_recall": .695}
        self.assertTrue(all(quality_gate(base, control).values()))
        for key in base:
            lower = dict(base, **{key: base[key] - 1e-6})
            self.assertFalse(all(quality_gate(lower, control).values()))
        self.assertTrue(all(latency_gate({"p50": 90, "p95": 110, "p99": 110}, {"p50": 100, "p95": 100, "p99": 100}).values()))
        self.assertFalse(all(latency_gate({"p50": 91, "p95": 110, "p99": 110}, {"p50": 100, "p95": 100, "p99": 100}).values()))

    def test_duplicates_rejected(self):
        with self.assertRaises(ValueError):
            quality(["a", "a"], ["a"], {})


if __name__ == "__main__":
    unittest.main()
