# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Restore the single bounded evidence archive from a downloaded job log."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

MAX_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 1000
PREFIX = "WARM_VECTOR_EVIDENCE_"


def decode(lines, max_bytes=MAX_BYTES):
    header = None
    payload = bytearray()
    finished = False
    input_bytes = 0
    for line in lines:
        input_bytes += len(line)
        if input_bytes > 2 * max_bytes + 4 * 1024 * 1024 or len(line) > 1024 * 1024:
            raise ValueError("Transport log exceeds its byte/line bound")
        if PREFIX not in line:
            continue
        marker = line[line.index(PREFIX):].strip()
        if marker.startswith(PREFIX + "BEGIN "):
            if header is not None or finished:
                raise ValueError("Duplicate evidence archive")
            header = json.loads(marker.removeprefix(PREFIX + "BEGIN "))
            if (header.get("version") != 1 or type(header.get("bytes")) is not int
                    or not 0 < header["bytes"] <= max_bytes
                    or type(header.get("members")) is not int or not 0 <= header["members"] <= MAX_MEMBERS
                    or type(header.get("input_bytes")) is not int or not 0 <= header["input_bytes"] <= max_bytes
                    or not isinstance(header.get("sha256"), str)
                    or not re.fullmatch("[0-9a-f]{64}", header["sha256"])):
                raise ValueError("Invalid evidence header")
        elif marker.startswith(PREFIX + "DATA "):
            if header is None or finished:
                raise ValueError("Evidence data outside an open archive")
            chunk = marker.removeprefix(PREFIX + "DATA ")
            if len(chunk) > 16384:
                raise ValueError("Oversized evidence chunk")
            payload.extend(base64.b64decode(chunk, validate=True))
            if len(payload) > header["bytes"]:
                raise ValueError("Evidence exceeds declared length")
        elif marker.startswith(PREFIX + "END "):
            if header is None or finished or marker.removeprefix(PREFIX + "END ") != header["sha256"]:
                raise ValueError("Invalid evidence end marker")
            finished = True
        elif marker.startswith(PREFIX + "ERROR "):
            raise ValueError("The workflow reported evidence-export failure")
        else:
            raise ValueError("Unknown evidence marker")
    if not finished or len(payload) != header["bytes"] or hashlib.sha256(payload).hexdigest() != header["sha256"]:
        raise ValueError("Incomplete or corrupt evidence transport")
    return bytes(payload), header


def validate_archive(payload, header, max_bytes=MAX_BYTES):
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
        raw = compressed.read(max_bytes + 4 * 1024 * 1024 + 1)
    if len(raw) > max_bytes + 4 * 1024 * 1024:
        raise ValueError("Expanded archive exceeds its bound")
    members = []
    names = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for member in archive:
            name = member.name
            parts = name.split("/")
            if (member.type not in [tarfile.REGTYPE, tarfile.AREGTYPE] or member.linkname
                    or name.startswith("/") or "\\" in name
                    or any(part in ["", ".", ".."] for part in parts) or name in names):
                raise ValueError(f"Unsafe or duplicate archive member: {name!r}")
            total += member.size
            if member.size < 0 or total > max_bytes or len(members) >= MAX_MEMBERS:
                raise ValueError("Archive member/byte bound exceeded")
            names.add(name)
            members.append(member)
        if total != header["input_bytes"] or len(members) != header["members"]:
            raise ValueError("Archive contents disagree with transport metadata")
        if any(str(parent) in names for name in names for parent in PurePosixPath(name).parents):
            raise ValueError("File/directory path collision")
    return raw, members


def restore(log, destination, metadata):
    opener = gzip.open if log.suffix == ".gz" else open
    with opener(log, "rt", encoding="utf-8", errors="strict") as source:
        payload, header = decode(iter(lambda: source.readline(1024 * 1024 + 1), ""))
    restore_payload(payload, header, destination, metadata)


def restore_archive(path, transport, destination, metadata):
    header = json.loads(transport.read_text())["archive"]
    with path.open("rb") as source:
        payload = source.read(MAX_BYTES + 1)
    if (len(payload) > MAX_BYTES or len(payload) != header["bytes"]
            or hashlib.sha256(payload).hexdigest() != header["sha256"]):
        raise ValueError("Archive length/SHA256 disagrees with retained transport metadata")
    restore_payload(payload, header, destination, metadata)


def restore_payload(payload, header, destination, metadata):
    raw, members = validate_archive(payload, header)
    if destination.exists():
        raise ValueError("Destination already exists; evidence must not be overwritten")
    destination.mkdir(parents=True)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size:
                raise ValueError("Member size mismatch")
            with path.open("xb") as output:
                output.write(data)
            files[member.name] = hashlib.sha256(data).hexdigest()
    record = {"archive": header, "safe_relative_regular_members": True,
              "destination": destination.name, "files_sha256": files}
    metadata.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"archive_sha256": header["sha256"], "bytes": header["bytes"], "files": len(files)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("log", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("--archive-metadata", type=Path)
    arguments = parser.parse_args()
    if arguments.archive_metadata:
        restore_archive(arguments.log, arguments.archive_metadata, arguments.destination, arguments.metadata)
    else:
        restore(arguments.log, arguments.destination, arguments.metadata)
