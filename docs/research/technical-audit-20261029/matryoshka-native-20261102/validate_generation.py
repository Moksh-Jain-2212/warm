"""Validate completed fresh native arrays and freeze their hashes without scoring."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--generation-commit", required=True)
    parser.add_argument("--retrieval-commit", required=True)
    args = parser.parse_args()
    generated = args.data / "generated"
    source = json.loads((args.evidence / "retrieval-source-freeze.json").read_text())
    inputs = json.loads((args.evidence / "inputs.json").read_text())
    receipt = json.loads((generated / "complete.json").read_text())
    run = json.loads((args.evidence / "generation-run.json").read_text())
    assert run["status"] == "complete" and run["returncode"] == 0
    assert sha256(args.data / "input.json") == inputs["input_sha256"] == source["input_sha256"]
    assert receipt["configuration"]["device"] == "Metal" and receipt["configuration"]["batch"] == 1
    assert receipt["configuration"]["embedding_space"]["dimensions"] == 1024
    assert receipt["configuration"]["query_prefix"] == "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"
    statistics = {}
    vector_hashes = {}
    for name, rows, ids in [("corpus",5183,inputs["document_ids"]),("queries",300,inputs["query_ids"])]:
        path = generated / f"{name}.f32"
        assert path.stat().st_size == rows * 1024 * 4
        vectors = np.fromfile(path, dtype="<f4").reshape(rows,1024)
        assert np.isfinite(vectors).all()
        widened = vectors.astype(np.float64)
        norms = np.sqrt(np.sum(widened*widened,axis=1))
        assert np.max(np.abs(norms-1)) < 1e-4
        progress = json.loads((generated / f"{name}.progress.json").read_text())
        assert progress["completed_rows"] == progress["expected_rows"] == rows
        assert progress["last_id"] == ids[-1] and receipt[name]["rows"] == rows
        prefix_norms = {str(dim): np.sqrt(np.sum(widened[:,:dim] ** 2,axis=1)) for dim in [256,512]}
        statistics[name] = {"rows":rows,"dimensions":1024,"dtype":"little-endian f32",
                            "bytes":path.stat().st_size,"norm_min":float(norms.min()),"norm_max":float(norms.max()),
                            "prefix_norms":{dim:{"min":float(values.min()),"max":float(values.max()),"zero_rows":int(np.sum(values==0))}
                                            for dim,values in prefix_norms.items()}}
        vector_hashes[path.name] = sha256(path)
    tokens = json.loads((generated / "tokens.json").read_text())
    for key, count in [("documents",5183),("queries",300)]:
        assert len(tokens[key]["untruncated_lengths"]) == count
        statistics[key + "_tokens"] = {"max":max(tokens[key]["untruncated_lengths"]),"truncated_rows":len(tokens[key]["over_cap"])}
    validation = {"generation_commit":args.generation_commit,"retrieval_commit":args.retrieval_commit,
                  "vector_sha256":vector_hashes,"array_validation":statistics,"generation_receipt":receipt,
                  "supervisor_receipt":run,"numpy":np.__version__,"no_scoring_performed":True}
    with (args.evidence / "generation-validation.json").open("x") as stream:
        json.dump(validation,stream,indent=2)
        stream.write("\n")
    freeze = {**source,"stage":"retrieval_with_fresh_data","generation_plan_commit":args.generation_commit,
              "retrieval_source_commit":args.retrieval_commit,"vector_sha256":vector_hashes,
              "generation_validation_sha256":sha256(args.evidence / "generation-validation.json")}
    with (args.evidence / "retrieval-freeze.json").open("x") as stream:
        json.dump(freeze,stream,indent=2)
        stream.write("\n")
    print(json.dumps({"vectors":statistics,"hashes":vector_hashes}))


if __name__ == "__main__":
    main()
