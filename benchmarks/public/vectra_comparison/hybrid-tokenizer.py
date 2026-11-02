# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Persistent local token counting; no model execution or network access."""
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import sys

import tokenizers
from tokenizers import Tokenizer


def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def main():
    path = Path(sys.argv[1])
    expected = sys.argv[2]
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError("tokenizer hash mismatch")
    if tokenizers.__version__ != "0.23.3":
        raise ValueError("unexpected tokenizer runtime")
    tokenizer = Tokenizer.from_file(str(path))
    tokenizer.no_padding()
    tokenizer.no_truncation()
    prefix = os.path.realpath(sys.prefix)
    files = {os.path.realpath(module.__file__) for module in list(sys.modules.values())
             if getattr(module, "__file__", None) and os.path.isfile(module.__file__)}
    virtual_files = {os.path.relpath(name, prefix): hashlib.sha256(Path(name).read_bytes()).hexdigest()
                     for name in sorted(files) if os.path.commonpath([prefix, name]) == prefix}
    send({"ready": True, "pid": os.getpid(), "sha256": actual,
          "python": platform.python_version(), "tokenizers": tokenizers.__version__,
          "executable": os.path.realpath(sys.executable), "virtualFiles": virtual_files,
          "tokenizersRoot": os.path.realpath(os.path.dirname(tokenizers.__file__))})
    while True:
        line = sys.stdin.buffer.readline(2 * 1024 * 1024 + 1)
        if not line:
            break
        if len(line) > 2 * 1024 * 1024 or not line.endswith(b"\n"):
            raise ValueError("tokenization request exceeds bound")
        request = json.loads(line)
        if request.get("op") == "close":
            break
        if set(request) != {"id", "text"} or not isinstance(request["id"], int) or not isinstance(request["text"], str):
            raise ValueError("invalid tokenization request")
        count = len(tokenizer.encode(request["text"], add_special_tokens=False).ids)
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        send({"id": request["id"], "count": count,
              "peakRssBytes": rss if sys.platform == "darwin" else rss * 1024})


if __name__ == "__main__":
    main()
