# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
import base64
import binascii
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from decode_joblog import decode, restore_archive, validate_archive


def fixture(names):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name in names:
            member = tarfile.TarInfo(name)
            member.size = 1
            archive.addfile(member, io.BytesIO(b"x"))
    payload = gzip.compress(output.getvalue(), mtime=0)
    header = {"version": 1, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
              "members": len(names), "input_bytes": len(names)}
    lines = ["timestamp WARM_VECTOR_EVIDENCE_BEGIN " + json.dumps(header),
             "timestamp WARM_VECTOR_EVIDENCE_DATA " + base64.b64encode(payload).decode(),
             "timestamp WARM_VECTOR_EVIDENCE_END " + header["sha256"]]
    return payload, header, lines


class DecoderIntegrity(unittest.TestCase):
    def test_roundtrip_and_transport_corruption(self):
        payload, header, lines = fixture(["plan.json", "raw/sample.json.gz"])
        self.assertEqual(decode(lines), (payload, header))
        self.assertEqual(len(validate_archive(payload, header)[1]), 2)
        for broken in [lines[:-1], lines + lines, [lines[0], lines[1] + "AA", lines[2]]]:
            with self.assertRaises((ValueError, binascii.Error)):
                decode(broken)

    def test_rejects_unsafe_members(self):
        for names in [["../escape"], ["/absolute"], ["same", "same"], ["file", "file/child"], ["back\\slash"]]:
            with self.subTest(names=names):
                payload, header, _ = fixture(names)
                with self.assertRaises(ValueError):
                    validate_archive(payload, header)

    def test_declared_input_bound(self):
        payload, header, lines = fixture(["data"])
        with self.assertRaises(ValueError):
            decode(lines, max_bytes=len(payload) - 1)
        header["input_bytes"] = 0
        with self.assertRaises(ValueError):
            validate_archive(payload, header)

    def test_archive_materialization_checks_digest(self):
        payload, header, _ = fixture(["data"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            archive, metadata = path / "evidence.tar.gz", path / "transport.json"
            archive.write_bytes(payload + b"corruption")
            metadata.write_text(json.dumps({"archive": header}))
            with self.assertRaises(ValueError):
                restore_archive(archive, metadata, path / "output", path / "verified.json")
            self.assertFalse((path / "output").exists())
            archive.write_bytes(payload)
            with contextlib.redirect_stdout(io.StringIO()):
                restore_archive(archive, metadata, path / "output", path / "verified.json")
            self.assertEqual((path / "output/data").read_bytes(), b"x")


if __name__ == "__main__":
    unittest.main()
