<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Graph profile update development diagnostic

In a new exclusive output directory, clone the previously prepared 100,000-row
WARM default and high-recall fixture stores without modifying their sources.
Verify the source and clone file hashes and bind the current local addon and
runtime. For each clone, open the public migration API, run index maintenance,
issue one graph query, then upsert the first 100 distinct IDs with the
next source vector and epoch-1 metadata in one acknowledged batch. Do not
delete records. Validate all 100 values and metadata, query three existing
queries against both graph and exact modes, run maintenance, query the same
three again, flush and reopen in a separate process, run maintenance, and repeat
validation and queries. Preserve revisions, actual routes and graph-profile diagnostics. These
three queries are correctness probes, not a quality certification.

Record initial and post-update maintenance, batch acknowledgement, flush and
probe times as exploratory shared-host observations only, plus one-second owned
process-tree RSS. Run the default profile at ef 2048 and the high-recall profile
at ef 512. The graph builds, page cache, one batch and process ordering are
different from a full sustained-update workload; report both arms and do not
claim a production speed advantage. Use a two-hour ceiling, the existing 8 GiB
per-process monitor and no automatic retries. This is a separate local
development experiment, not a restarted frozen phase. No paid calls or model
downloads are used. Preserve failures and partial outputs.
