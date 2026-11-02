# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Read existing pinned binaries; never build or execute a benchmark."""
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def instructions(output):
    result = []
    for line in output.splitlines():
        match = re.match(r"^\s*([0-9a-f]+):\s+(.+)$", line)
        if match:
            result.append((int(match[1], 16), match[2].strip()))
    if not result:
        raise RuntimeError("Empty disassembly")
    return result


def normalize(rows):
    start, end = rows[0][0], rows[-1][0] + 4
    output = []
    for _, text in rows:
        symbol = re.search(r"<(.+)>$", text)
        text = re.sub(r"\s*<.+>$", "", text)
        text = " ".join(text.split())
        if text.startswith("adrp "):
            text = re.sub(r"0x[0-9a-f]+", "DATA_PAGE", text)
        else:
            def address(match):
                value = int(match[0], 16)
                if start <= value < end:
                    return f"LOCAL+0x{value-start:x}"
                return f"SYMBOL<{symbol[1]}>" if symbol else "EXTERNAL_ADDRESS"
            text = re.sub(r"(?<![#\w])0x[0-9a-f]{8,}", address, text)
        output.append(text)
    return output


def normalize_data_layout(lines):
    result = list(lines)
    for index in range(1, len(lines)):
        page = re.fullmatch(r"adrp (x\d+), DATA_PAGE", lines[index - 1])
        if page:
            register = page[1]
            result[index] = re.sub(rf"^add {register}, {register}, #0x[0-9a-f]+$",
                                   f"add {register}, {register}, DATA_PAGE_OFFSET", lines[index])
    return result


def inspect():
    objdump = subprocess.check_output(["xcrun", "--find", "llvm-objdump"], text=True).strip()
    manifests = {"baseline": HERE / "build-baseline.json",
                 "original_candidate": HERE.parent / "confirmation-1024/build-current.json",
                 "integrated_candidate": HERE / "build-current.json"}
    evidence = {"inspected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "scope": "Code generation of existing optimized instrumented test binaries; no timing or causal latency attribution",
                "normalization": "Preserve mnemonics, registers, immediates and local branch offsets; replace external instruction addresses by their symbol and ADRP page addresses by DATA_PAGE. Static-data low-page ADD immediates remain unchanged, so address-only data-layout differences can still produce unequal hashes.",
                "variants": {}}
    normalized_scorers = {}
    normalized_collectors = {}
    unwind_stubs = {}
    for variant, path in manifests.items():
        manifest = json.loads(path.read_text())
        binary = Path(manifest["binary"])
        if sha(binary.read_bytes()) != manifest["binary_sha256"]:
            raise RuntimeError(f"Changed binary: {variant}")
        names = [line.split()[-1] for line in subprocess.check_output(["nm", "-an", str(binary)], text=True).splitlines() if line.split()]
        rank = [name for name in names if name.endswith("20rank_vector_snapshot")]
        scorer = [name for name in names if "16search_canonicalNCNv" in name and "20rank_vector_snapshot0E" in name]
        if len(rank) != 1 or len(scorer) != 1:
            raise RuntimeError(f"Ambiguous symbols: {variant} rank={rank} scorer={scorer}")
        selected = {"dispatch": rank[0], "fresh_scorer": scorer[0]}
        scorer_output = subprocess.check_output([objdump, "-d", "--no-show-raw-insn",
                                                f"--disassemble-symbols={scorer[0]}", str(binary)], text=True)
        stub_addresses = re.findall(r"\bbl\s+0x([0-9a-f]+)\s+<dyld_stub_binder[^>]+>", scorer_output)
        indirect_command = ["otool", "-Iv", str(binary)]
        indirect = subprocess.check_output(indirect_command, text=True)
        stub_lines = [line for line in indirect.splitlines() if any(address in line for address in stub_addresses)]
        if len(stub_lines) != 1 or not stub_lines[0].endswith("__Unwind_Resume"):
            raise RuntimeError(f"Unexpected unwind stub: {stub_lines}")
        unwind_stubs[variant] = {"command": indirect_command, "matching_lines": stub_lines}
        collectors = re.findall(r"\bbl\s+0x[0-9a-f]+\s+<([^>]*from_iter_in_place[^>]*)>", scorer_output)
        if len(collectors) != 1:
            raise RuntimeError(f"Ambiguous fresh collector: {collectors}")
        selected["fresh_collector"] = collectors[0]
        for function in ["rank_stale_exact_snapshot", "finish_vector_hits"]:
            matches = [name for name in names if name.endswith(f"{len(function)}{function}")]
            if len(matches) > 1:
                raise RuntimeError(f"Ambiguous helper: {matches}")
            if matches:
                selected[function] = matches[0]
        result = {"revision": manifest["revision"], "binary_sha256": manifest["binary_sha256"],
                  "engine_vector_sha256": manifest.get("engine_vector_sha256"), "functions": {}}
        for label, symbol in selected.items():
            command = [objdump, "-d", "--no-show-raw-insn", f"--disassemble-symbols={symbol}", str(binary)]
            output = subprocess.check_output(command, text=True)
            rows = instructions(output)
            artifact = HERE / f"codegen-{variant}-{label}.log.gz"
            artifact.write_bytes(gzip.compress(output.encode(), mtime=0))
            normalized = normalize(rows)
            stack = 0
            for _, instruction in rows[:16]:
                if instruction.startswith(("mov", "ldr", "cmp")):
                    break
                for pattern in [r"sub\s+sp, sp, #0x([0-9a-f]+)", r"\[sp, #-0x([0-9a-f]+)\]!"]:
                    match = re.search(pattern, instruction)
                    if match:
                        stack += int(match[1], 16)
            calls = [line for line in normalized if line.startswith(("bl ", "blr "))]
            result["functions"][label] = {"symbol": symbol, "command": command,
                "disassembly_gzip_sha256": sha(artifact.read_bytes()), "instruction_count": len(rows),
                "initial_stack_reservation_bytes": stack, "first_instructions": [text for _, text in rows[:24]],
                "calls": calls, "normalized_instructions_sha256": sha("\n".join(normalized).encode())}
            if label == "fresh_scorer":
                normalized_scorers[variant] = normalized
            if label == "fresh_collector":
                normalized_collectors[variant] = normalize_data_layout(normalized)
        evidence["variants"][variant] = result
    evidence["fresh_scorer_normalized_equal"] = {
        variant: normalized_scorers[variant] == normalized_scorers["baseline"]
        for variant in normalized_scorers}
    collectors_equal = all(value == normalized_collectors["baseline"] for value in normalized_collectors.values())
    adjusted = {}
    for variant, lines in normalized_scorers.items():
        adjusted[variant] = []
        for line in normalize_data_layout(lines):
            line = re.sub(r"SYMBOL<dyld_stub_binder\+0x[0-9a-f]+>", "SYMBOL<__Unwind_Resume>", line)
            if collectors_equal and line.startswith("bl ") and "from_iter_in_place" in line:
                line = "bl VERIFIED_EQUIVALENT_FRESH_COLLECTOR"
            adjusted[variant].append(line)
    evidence["layout_review"] = {
        "rules": "Additional diagnostic only: normalize ADD low-page offsets immediately following ADRP to the same register; resolve the inspected unwind stub with otool; collapse collector symbol aliases only after independently comparing all 89 collector instructions under data-layout normalization. Retain stricter hashes and raw disassembly above.",
        "collector_instruction_sequences_equal_after_data_layout_normalization": collectors_equal,
        "scorer_instruction_sequences_equal_after_verified_layout_and_alias_normalization":
            all(value == adjusted["baseline"] for value in adjusted.values()),
        "resolved_unwind_stubs": unwind_stubs}
    (HERE / "codegen-inspection.json").write_text(json.dumps(evidence, indent=2) + "\n")
    (HERE / "fresh-scorer-normalized.json").write_text(json.dumps(normalized_scorers, indent=2) + "\n")
    print(json.dumps({"variants": {variant: {name: {key: value for key, value in function.items()
                           if key in ["instruction_count", "initial_stack_reservation_bytes", "normalized_instructions_sha256"]}
                           for name, function in result["functions"].items()}
                           for variant, result in evidence["variants"].items()},
                      "fresh_scorer_normalized_equal": evidence["fresh_scorer_normalized_equal"]}, indent=2))


if __name__ == "__main__":
    inspect()
