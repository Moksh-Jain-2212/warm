# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0

import copy
import unittest

from probe import PLAN, compatible_plan


class PlanCompatibilityTests(unittest.TestCase):
    def test_unchanged_plan_is_accepted_for_every_variant(self):
        for variant in PLAN["revisions"]:
            self.assertTrue(compatible_plan(copy.deepcopy(PLAN), variant, PLAN))

    def test_only_baselines_may_precede_current_revision_selection(self):
        newer = copy.deepcopy(PLAN)
        newer["revisions"]["current"] = "0" * 40
        for variant in ["baseline", "sorted"]:
            self.assertTrue(compatible_plan(PLAN, variant, newer))
        self.assertFalse(compatible_plan(PLAN, "current", newer))

    def test_baseline_revision_or_workload_changes_invalidate_builds(self):
        for changed in ["baseline", "sorted", "rows", "rounds", "budget"]:
            altered = copy.deepcopy(PLAN)
            if changed in ["baseline", "sorted"]:
                altered["revisions"][changed] = "0" * 40
            elif changed == "budget":
                altered["execution_budget_seconds"] += 1
            else:
                altered["workload"][changed] += 1
            for variant in PLAN["revisions"]:
                self.assertFalse(compatible_plan(PLAN, variant, altered))

    def test_current_revision_exception_does_not_hide_a_second_change(self):
        changed = copy.deepcopy(PLAN)
        changed["revisions"]["current"] = "0" * 40
        changed["acceptance"].append("changed acceptance")
        for variant in PLAN["revisions"]:
            self.assertFalse(compatible_plan(PLAN, variant, changed))


if __name__ == "__main__":
    unittest.main()
