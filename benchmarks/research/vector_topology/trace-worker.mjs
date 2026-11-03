// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
const job = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
process.send?.({ type: 'stage', name: `trace-${job.mode}` })
const child = spawn(job.binary, [job.corpus, job.queries, job.oracle, job.output, job.mode], { stdio: 'inherit' })
const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
if (result.code !== 0 || result.signal) throw new Error(`diagnostic child failed: ${JSON.stringify(result)}`)
