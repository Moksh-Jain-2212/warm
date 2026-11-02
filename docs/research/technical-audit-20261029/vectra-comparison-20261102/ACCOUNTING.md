<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Comparison execution accounting — preparation

No study data has been scored and no study timing has run. The vector and hybrid
harnesses use a shared phase driver, one preparation deadline, one measurement
deadline, one preflight, and a single no-retry schedule. The combined freeze binds
the selected Node addon, input and installed dependency files, hybrid sources,
tokenizer, Python runtime and fixed schedules. Final integrated source validation and an
execution feasibility assessment remain necessary before freezing; a standalone
vector-only freeze would not qualify the combined comparison.

The declared matrix has 62,000 vector static-quality queries and 2,400 hybrid
static-quality queries. Even if all other preparation work took zero time, the
two-hour ceiling would allow only 111.8 ms per query on average. The measurement
phase has 186,000 vector lifecycle queries, 63,600 timed vector queries, 4,560
vector warmups, 3,600 timed hybrid queries and 480 hybrid warmups: 258,240 queries
before cold opens, graph-first calls, writes, copying, process startup, tokenization
setup, validation, interruption checks and reporting. Two hours would allow at most
27.9 ms per query on average if every other operation took zero time. These are
arithmetic ceilings, not measured or projected performance. Feasibility remains
unestablished; do not infer that the full schedule fits the fixed budget.

The phase watchdog observes controller and descendant RSS and external CPU between
worker jobs as well as during them. It stops the active worker on violation. An
in-progress filesystem operation, including copying or hashing, may not stop
immediately; a violation is recorded and prevents the next job, but the operation
can finish after the deadline. Such a phase is incomplete and cannot qualify. Per-file
clone allocation counts can include shared blocks and are not summed physical disk
usage. One-second RSS sampling can miss shorter peaks, and process CPU observations
do not establish isolation.

The hybrid pair comparator requires the frozen expected query population and
matching repetitions, complete worker outcomes, matching eligible-judgment
populations and no warmup or measured-query errors. The shared controller binds
those populations to the frozen inputs and requires the three planned repetitions.
The vector summary separately gates each timed repetition
against its matched exact reference and oracle. The retained initial review record
and earlier development receipts describe the source at their recording time and
must not be rewritten as though their blockers had already been fixed.
