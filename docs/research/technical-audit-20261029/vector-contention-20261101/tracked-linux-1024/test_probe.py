# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
import copy
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from probe import HERE, classify_processes, emit_evidence, evidence_archive, linux_cpu_observation, validate_report
import probe
from summarize import quantile


class ConfirmationIntegrity(unittest.TestCase):
    def setUp(self):
        self.plan = json.loads((HERE / "plan.json").read_text())

    def process(self, pid, parent, cpu, name="worker"):
        return {"pid": pid, "ppid": parent, "cpu_percent": cpu, "executable": name}

    def test_no_build_before_integrated_source_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "plan.json").write_text(json.dumps({"baseline": "pinned-baseline", "current": None}))
            with patch.object(probe, "HERE", path), patch.object(probe, "OWNED", path / "owned"):
                with self.assertRaisesRegex(RuntimeError, "Pin source before building"):
                    probe.build("baseline")
            self.assertFalse((path / "owned").exists())

    def test_capacity_boundary(self):
        for raw, expected in [(79.9, False), (80, False), (80.1, True)]:
            with self.subTest(raw=raw):
                rows = [self.process(100, 1, 500), self.process(101, 100, 800), self.process(200, 1, raw)]
                excluded, violations, total, capacity = classify_processes(rows, 100, self.plan["host_conditions"])
                self.assertEqual(excluded, [1, 100, 101])
                self.assertEqual(total, raw)
                self.assertEqual(capacity, raw / 4)
                self.assertEqual(bool(violations), expected)

    def test_sibling_of_driver_is_external(self):
        rows = [self.process(10, 1, 0), self.process(100, 10, 0), self.process(200, 10, 81)]
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

    def test_evidence_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "plan.json").write_text('{"pinned":true}\n')
            (path / "raw").mkdir()
            (path / "raw/sample.json.gz").write_bytes(b"sample fixture")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                emit_evidence(path)
            lines = output.getvalue().splitlines()
            header = json.loads(lines[0].removeprefix("WARM_VECTOR_EVIDENCE_BEGIN "))
            payload = base64.b64decode("".join(line.removeprefix("WARM_VECTOR_EVIDENCE_DATA ") for line in lines[1:-1]), validate=True)
            self.assertEqual(len(payload), header["bytes"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), header["sha256"])
            self.assertEqual(lines[-1], "WARM_VECTOR_EVIDENCE_END " + header["sha256"])
            with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
                self.assertEqual(archive.getnames(), ["plan.json", "raw/sample.json.gz"])
                self.assertTrue(all(member.isfile() for member in archive.getmembers()))
                self.assertEqual(archive.extractfile("raw/sample.json.gz").read(), b"sample fixture")

    def test_evidence_input_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for size in [1023, 1024]:
                (path / "data").write_bytes(b"x" * size)
                self.assertEqual(evidence_archive(path, 1024)[2], size)
            (path / "data").write_bytes(b"x" * 1025)
            with self.assertRaisesRegex(RuntimeError, "input exceeds"):
                evidence_archive(path, 1024)

    def test_evidence_compressed_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "data").write_bytes(b"x")
            payload, _, _ = evidence_archive(path)
            size = len(payload)
            with self.assertRaisesRegex(RuntimeError, "Compressed evidence exceeds"):
                evidence_archive(path, size - 1)
            self.assertEqual(evidence_archive(path, size)[0], payload)
            self.assertEqual(evidence_archive(path, size + 1)[0], payload)

    def test_evidence_rejects_symlinks_before_emitting(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            root = path / "evidence"
            root.mkdir()
            (path / "outside").write_text("fixture")
            (root / "link").symlink_to(path / "outside")
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, "symlink rejected"):
                emit_evidence(root)
            self.assertEqual(output.getvalue(), "")

    def test_linux_steal_is_observational(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stat"
            path.write_text("cpu 1 2 3 4 5 6 7 8 9 10\ncpu0 1 2 3 4 5 6 7 8 9 10\n")
            observed = linux_cpu_observation(path)
            self.assertTrue(observed["available"])
            self.assertEqual(observed["steal_ticks"], 8)
            self.assertFalse(observed["acceptance_gate"])
            path.write_text("cpu 1 2 3\n")
            self.assertFalse(linux_cpu_observation(path)["available"])
            path.unlink()
            self.assertFalse(linux_cpu_observation(path)["available"])


if __name__ == "__main__":
    unittest.main()
