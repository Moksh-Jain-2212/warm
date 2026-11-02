# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Synthetic reporting fixtures; no benchmark or timing measurements."""
import contextlib
import gzip
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from probe import HERE, digest
import summarize


class SummaryExit(unittest.TestCase):
    def check_fixture(self, query_ns, writer_wait_ns, accepted):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            plan = json.loads((HERE / "plan.json").read_text())
            (path / "plan.json").write_text(json.dumps(plan))
            runs = []
            reports = {}
            for variant in ["baseline", "current"]:
                groups = []
                for dim in plan["dimensions"]:
                    for phase in plan["phases"]:
                        sample = {"query_ns": query_ns if variant == "current" and dim == 16 and phase == "fresh_idle" else 10000,
                                  "writer_wait_ns": writer_wait_ns if variant == "current" else 100,
                                  "writer_total_ns": 100, "peak_requested_bytes": 100, "allocations": 2}
                        groups.append({"dimensions": dim, "phase": phase, "samples": [sample] * 1024,
                                       "ordered_results": [[]] * 1024, "oracle_checks": 1032})
                reports[variant] = gzip.compress(json.dumps({"groups": groups}).encode(), mtime=0)
            for index, order in enumerate(plan["orders"]):
                for variant in order:
                    name = f"synthetic-{index}-{variant}"
                    (path / f"{name}.json.gz").write_bytes(reports[variant])
                    (path / f"{name}.log.gz").write_bytes(gzip.compress(b"synthetic reporting fixture", mtime=0))
                    runs.append({"name": name, "variant": variant, "ordered_equal": True, "exit_code": 0,
                                 "json_sha256": digest(path / f"{name}.json.gz"),
                                 "log_sha256": digest(path / f"{name}.log.gz")})
            ledger = {"complete": True, "status": "complete", "plan": plan,
                      "plan_sha256": digest(path / "plan.json"), "observations": [],
                      "runs": runs, "execution_seconds": 0}
            (path / "execution.json").write_text(json.dumps(ledger))
            output = io.StringIO()
            with patch.object(summarize, "HERE", path), contextlib.redirect_stdout(output):
                if accepted:
                    summarize.summarize()
                else:
                    with self.assertRaises(SystemExit) as error:
                        summarize.summarize()
                    self.assertEqual(error.exception.code, 1)
            stored = json.loads((path / "summary.json").read_text())
            self.assertEqual(stored["confirmation_acceptance"], accepted)
            self.assertEqual(json.loads(output.getvalue()), stored)

    def test_query_boundary_retains_summary_before_failure(self):
        for query_ns, accepted in [(11499, True), (11500, True), (11501, False)]:
            with self.subTest(query_ns=query_ns):
                self.check_fixture(query_ns, 50, accepted)

    def test_writer_failure_retains_summary_before_exit(self):
        self.check_fixture(10000, 51, False)


if __name__ == "__main__":
    unittest.main()
