# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
import copy
import json
import unittest

from probe import HERE, classify_processes, validate_report
from summarize import quantile


class ConfirmationIntegrity(unittest.TestCase):
    def setUp(self):
        self.plan = json.loads((HERE / "plan.json").read_text())

    def process(self, pid, parent, cpu, name="worker"):
        return {"pid": pid, "ppid": parent, "cpu_percent": cpu, "executable": name}

    def test_capacity_boundary(self):
        for raw, expected in [(199.9, False), (200, False), (200.1, True)]:
            with self.subTest(raw=raw):
                rows = [self.process(100, 1, 500), self.process(101, 100, 800), self.process(200, 1, raw)]
                excluded, violations, total, capacity = classify_processes(rows, 100, self.plan["host_conditions"])
                self.assertEqual(excluded, [1, 100, 101])
                self.assertEqual(total, raw)
                self.assertEqual(capacity, raw / 10)
                self.assertEqual(bool(violations), expected)

    def test_sibling_of_driver_is_external(self):
        rows = [self.process(10, 1, 0), self.process(100, 10, 0), self.process(200, 10, 201)]
        excluded, violations, _, _ = classify_processes(rows, 100, self.plan["host_conditions"])
        self.assertNotIn(200, excluded)
        self.assertEqual(violations[0]["reason"], "external_cpu_capacity_limit")

    def test_external_build_fails_below_cpu_budget(self):
        rows = [self.process(100, 1, 0), self.process(200, 1, 0, "/toolchain/rustc")]
        _, violations, _, _ = classify_processes(rows, 100, self.plan["host_conditions"])
        self.assertEqual(violations[0]["reasons"], ["external_build"])

    def test_complete_report_required(self):
        report = {"groups": [{"dimensions": dim, "phase": phase, "samples": [{}] * 1024,
                               "ordered_results": [[]] * 1024, "oracle_checks": 1032}
                              for dim in [16, 128, 768]
                              for phase in ["fresh_idle", "stale_idle", "stale_writer"]]}
        validate_report(report, self.plan)
        for count in [1023, 1025]:
            changed = copy.deepcopy(report)
            changed["groups"][0]["samples"] = [{}] * count
            with self.assertRaises(RuntimeError):
                validate_report(changed, self.plan)
        for key, value in [("oracle_checks", 1031), ("ordered_results", [[]] * 1023)]:
            changed = copy.deepcopy(report)
            changed["groups"][0][key] = value
            with self.assertRaises(RuntimeError):
                validate_report(changed, self.plan)

    def test_empirical_tail_rank(self):
        self.assertEqual(quantile(range(1, 65), .99), 64)
        self.assertEqual(quantile(range(1, 1025), .99), 1014)


if __name__ == "__main__":
    unittest.main()
