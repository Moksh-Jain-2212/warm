import unittest

from run_retrieval import cpu_interval, cpu_seconds


class HostTests(unittest.TestCase):
    def test_cpu_time_formats(self):
        self.assertEqual(cpu_seconds("3:12.50"), 192.5)
        self.assertEqual(cpu_seconds("1:03:12.50"), 3792.5)
        with self.assertRaises(ValueError):
            cpu_seconds("1")

    def test_external_cpu_excludes_only_declared_processes_and_sampling(self):
        before = {"monotonic":10,"processes":{1:{"cpu_seconds":50},2:{"cpu_seconds":10},4:{"cpu_seconds":2}}}
        after = {"monotonic":15,"unix":100,"processes":{
            1:{"cpu_seconds":80,"name":"benchmark"}, 2:{"cpu_seconds":19,"name":"external"},
            3:{"cpu_seconds":1,"name":"new"}, 5:{"cpu_seconds":.1,"name":"ps"}}}
        result = cpu_interval(before,after,{1,5})
        self.assertEqual(result["external_capacity_percent_10_cpus"],20)
        self.assertEqual(result["external_core_percent"],200)
        self.assertEqual(result["vanished_pids"],[4])
        self.assertEqual(result["new_pids"],[3,5])
        self.assertEqual(result["top_external"][0]["pid"],2)
        self.assertGreater(cpu_interval(before,after,{1})["external_capacity_percent_10_cpus"],20)


if __name__ == "__main__":
    unittest.main()
