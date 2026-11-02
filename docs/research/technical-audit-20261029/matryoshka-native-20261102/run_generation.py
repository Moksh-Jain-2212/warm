"""Run the frozen native generator once with a two-hour process ceiling."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--freeze", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--plan-commit", required=True)
    args = parser.parse_args()
    freeze = json.loads(args.freeze.read_text())
    config = json.loads(args.config.read_text())
    assert sha256(args.binary) == freeze["generator_binary_sha256"]
    assert sha256(Path(config["input"])) == freeze["input_sha256"]
    assert not Path(config["output_directory"]).exists()
    subprocess.run(["git", "cat-file", "-e", args.plan_commit + "^{commit}"], check=True)
    receipt = {
        "plan_commit": args.plan_commit,
        "binary_sha256": sha256(args.binary),
        "config_sha256": sha256(args.config),
        "input_sha256": freeze["input_sha256"],
        "started_unix": time.time(), "ceiling_seconds": 7200,
        "environment": {key: os.environ.get(key) for key in ["WARM_MODEL_DEVICE", "RAYON_NUM_THREADS", "CARGO_BUILD_JOBS"]},
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    with args.receipt.open("x") as stream:
        json.dump(receipt, stream)
        stream.write("\n")
    started = time.monotonic()
    with args.log.open("x") as log:
        process = subprocess.Popen([str(args.binary), str(args.config)], stdout=log, stderr=subprocess.STDOUT)
        receipt["pid"] = process.pid
        args.receipt.write_text(json.dumps(receipt) + "\n")
        try:
            returncode = process.wait(timeout=7200)
            receipt["status"] = "complete" if returncode == 0 else "failed"
        except subprocess.TimeoutExpired:
            receipt["status"] = "ceiling_exceeded"
            process.terminate()
            try:
                returncode = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                returncode = process.wait()
        receipt.update(returncode=returncode, elapsed_seconds=time.monotonic() - started, ended_unix=time.time())
        args.receipt.write_text(json.dumps(receipt) + "\n")
    print(json.dumps(receipt))
    if receipt["status"] != "complete":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
