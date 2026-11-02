"""Prepare exact SciFact row mapping without inference or downloads."""

import argparse
import csv
import hashlib
import json
from pathlib import Path


EXPECTED = {
    "corpus.jsonl": "dec31c8182f3d744c7d2c09423756fd1d17cbef75808db13ba01cc0aab4d1ac6",
    "queries.jsonl": "8ff84a7c903f722981cd8d595c022660140c51867b27608a6d4910db86080313",
    "qrels/test.tsv": "0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source, output, manifest_path):
    sources = {}
    for name, expected in EXPECTED.items():
        path = source / name
        actual = digest(path)
        if actual != expected:
            raise ValueError(f"source changed: {name}: {actual}")
        sources[name] = {"sha256": actual, "bytes": path.stat().st_size}
    corpus = [json.loads(line) for line in (source / "corpus.jsonl").read_text().splitlines()]
    all_queries = [json.loads(line) for line in (source / "queries.jsonl").read_text().splitlines()]
    with (source / "qrels/test.tsv").open() as stream:
        qrels = list(csv.DictReader(stream, delimiter="\t"))
    doc_ids = [str(row["_id"]) for row in corpus]
    test_ids = {row["query-id"] for row in qrels}
    queries = [row for row in all_queries if str(row["_id"]) in test_ids]
    query_ids = [str(row["_id"]) for row in queries]
    assert len(doc_ids) == len(set(doc_ids)) == 5183
    assert len(query_ids) == len(set(query_ids)) == 300
    assert set(query_ids) == test_ids
    assert len(qrels) == len({(r["query-id"], r["corpus-id"]) for r in qrels}) == 339
    assert all(r["corpus-id"] in set(doc_ids) for r in qrels)
    judgments = {qid: {} for qid in query_ids}
    for row in qrels:
        score = int(row["score"])
        assert score > 0
        judgments[row["query-id"]][row["corpus-id"]] = score
    documents = [{"id": str(row["_id"]), "text": row["title"] + "\n" + row["text"]} for row in corpus]
    query_rows = [{"id": str(row["_id"]), "text": row["text"]} for row in queries]
    payload = {"documents": documents, "queries": query_rows}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
    manifest = {
        "source_directory": str(source), "sources": sources,
        "document_ids": doc_ids, "query_ids": query_ids, "qrels": judgments,
        "input_sha256": digest(output), "input_bytes": output.stat().st_size,
        "document_text_sha256": [hashlib.sha256(d["text"].encode()).hexdigest() for d in documents],
        "query_text_sha256": [hashlib.sha256(q["text"].encode()).hexdigest() for q in query_rows],
        "max_document_words": max(len(d["text"].split()) for d in documents),
        "max_document_utf8_bytes": max(len(d["text"].encode()) for d in documents),
        "full_vector_bytes": (len(doc_ids) + len(query_ids)) * 1024 * 4,
    }
    with manifest_path.open("x") as stream:
        json.dump(manifest, stream, separators=(",", ":"))
        stream.write("\n")
    print(json.dumps({"documents": len(doc_ids), "queries": len(query_ids), "qrels": len(qrels), "input_sha256": manifest["input_sha256"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source, args.output, args.manifest)
