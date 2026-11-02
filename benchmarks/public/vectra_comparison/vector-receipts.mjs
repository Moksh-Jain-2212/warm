// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export const exec = promisify(execFile)
export const LIMITS = Object.freeze({ preparationMs: 7_200_000, measurementMs: 7_200_000, rssBytes: 8 * 1024 ** 3, externalCpuFraction: .20, rssConsecutive: 2, preflightMs: 5000, preflightCount: 2, sampleMs: 1000 })
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
export function hashValue(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export async function writeOnce(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
export async function append(file, value) { await fs.appendFile(file, JSON.stringify(value) + '\n') }
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
export async function manifest(directory) {
  const files = []
  async function visit(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name), stat = await fs.lstat(filename)
      assert.ok(!stat.isSymbolicLink(), `symlink not allowed in evidence/store tree: ${filename}`)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile()) files.push({ path: path.relative(directory, filename), bytes: stat.size, allocatedBytes: stat.blocks * 512, sha256: await sha256(filename) })
      else throw new Error(`unsupported filesystem entry: ${filename}`)
    }
  }
  await visit(directory)
  return { files, logicalBytes: files.reduce((sum, file) => sum + file.bytes, 0), allocatedBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0), allocationUnitBytes: 512 }
}
export async function packageFiles(directory) {
  const files = []
  async function visit(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue
      const filename = path.join(current, entry.name), stat = await fs.lstat(filename)
      assert.ok(!stat.isSymbolicLink(), `dependency symlink refused: ${filename}`)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile()) files.push({ path: path.relative(directory, filename), bytes: stat.size, sha256: await sha256(filename) })
      else throw new Error(`unsupported dependency entry: ${filename}`)
    }
  }
  await visit(directory)
  return files
}
export async function storageReceipt(directory) {
  const files = []
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name), stat = await fs.lstat(filename)
      assert.ok(!stat.isSymbolicLink(), 'store symlink refused')
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile()) files.push({ path: path.relative(directory, filename), logicalBytes: stat.size, allocatedBytes: stat.blocks * 512, category: /vectra-migration|store\.json|indices\.json/.test(entry.name) ? 'profile-and-metadata' : /seg_|index\.json/.test(entry.name) ? 'durable-vectors-and-metadata' : /index\.bin|graph/.test(entry.name) ? 'graph-cache' : 'other' })
    }
  }
  await visit(directory)
  return { files, logicalBytes: files.reduce((sum, file) => sum + file.logicalBytes, 0), allocatedBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0), note: 'Sparse capacity included in logical bytes; native in-memory graph/owner/scratch buffers are measured only by whole-process RSS.' }
}
export function parseProcesses(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    assert.ok(match, 'unrecognized ps output')
    return { pid: +match[1], ppid: +match[2], cpuPercent: +match[3], rssBytes: +match[4] * 1024, command: match[5] }
  })
}
export function descendants(processes, roots) {
  const owned = new Set(roots)
  for (let changed = true; changed;) { changed = false; for (const item of processes) if (owned.has(item.ppid) && !owned.has(item.pid)) { owned.add(item.pid); changed = true } }
  return owned
}
export function externalCpuFraction(processes, ownedPids, logicalCpus) {
  assert.ok(logicalCpus > 0)
  const owned = descendants(processes, ownedPids)
  return { owned, fraction: processes.filter(item => !owned.has(item.pid)).reduce((sum, item) => sum + item.cpuPercent, 0) / (100 * logicalCpus) }
}
export async function hostSample(ownedPids = []) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='], { maxBuffer: 8 * 1024 ** 2 })
  const processes = parseProcesses(stdout), logicalCpus = os.cpus().length
  const { owned, fraction } = externalCpuFraction(processes, [process.pid, ...ownedPids], logicalCpus)
  let procStat = null
  if (process.platform === 'linux') procStat = (await fs.readFile('/proc/stat', 'utf8')).split('\n').find(line => /^cpu\s/.test(line))
  return { utc: new Date().toISOString(), logicalCpus, externalCpuFraction: fraction, ownedPids: [...owned], processes, procStat, scope: 'Observed shared-host process CPU, not host isolation; /proc/stat steal is observational only.' }
}
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function preflight(file, sample = hostSample, sleep = wait) {
  for (let interval = 0; interval < LIMITS.preflightCount; interval++) {
    const readings = []
    for (let second = 0; second < LIMITS.preflightMs / LIMITS.sampleMs; second++) { await sleep(LIMITS.sampleMs); const value = await sample(); readings.push(value.externalCpuFraction); await append(file, { type: 'preflight', interval, ...value }) }
    if (readings.some(value => !Number.isFinite(value) || value < 0 || value > LIMITS.externalCpuFraction)) return { pass: false, failedInterval: interval, readings, noQueryTimings: true }
  }
  return { pass: true }
}
export function watchPhase(file, deadline, quiet, sample = hostSample, sleep = wait) {
  const controller = new AbortController(), consecutive = new Map()
  let stopped = false, failure = null
  const fail = reason => { if (!failure) { failure = reason; controller.abort(reason) } }
  const done = (async () => {
    while (!stopped && !failure) {
      if (Date.now() >= deadline) { fail({ kind: 'phase-timeout', deadline }); break }
      try {
        const observation = await sample()
        await append(file, { type: 'phase-resource', ...observation })
        if (quiet && (!Number.isFinite(observation.externalCpuFraction) || observation.externalCpuFraction < 0 || observation.externalCpuFraction > LIMITS.externalCpuFraction)) fail({ kind: 'external-load', externalCpuFraction: observation.externalCpuFraction })
        const owned = observation.processes.filter(item => observation.ownedPids.includes(item.pid))
        const present = new Set(owned.map(item => item.pid))
        for (const pid of consecutive.keys()) if (!present.has(pid)) consecutive.delete(pid)
        for (const item of owned) {
          consecutive.set(item.pid, item.rssBytes > LIMITS.rssBytes ? (consecutive.get(item.pid) ?? 0) + 1 : 0)
          if (consecutive.get(item.pid) >= LIMITS.rssConsecutive) fail({ kind: 'rss-limit', pid: item.pid, rssBytes: item.rssBytes })
        }
      } catch (error) { fail({ kind: 'resource-observation-failure', message: error.message }) }
      if (!stopped && !failure) await sleep(LIMITS.sampleMs)
    }
  })()
  return { signal: controller.signal, setQuiet(value) { quiet = value }, check() { if (failure) throw new Error(`phase incomplete: ${failure.kind}`); if (Date.now() >= deadline) { fail({ kind: 'phase-timeout', deadline }); throw new Error('phase incomplete: phase-timeout') } }, async stop() { stopped = true; await done }, done, get failure() { return failure } }
}

export function assertOwnedPath(root, destination) {
  const relative = path.relative(path.resolve(root), path.resolve(destination))
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'destination must be strictly inside owned output')
}
export async function cloneStore(root, source, destination) {
  assertOwnedPath(root, destination)
  await fs.mkdir(destination) // Refuse overwrite, including a previous partial copy.
  for (const entry of await fs.readdir(source)) {
    await fs.cp(path.join(source, entry), path.join(destination, entry), { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE, filter: async sourcePath => { assert.ok(!(await fs.lstat(sourcePath)).isSymbolicLink(), 'store symlink refused'); return path.basename(sourcePath) !== '.hms.lock' } })
  }
}

export async function runMonitored({ worker, job, jobFile, receipt, hostFile, deadline, quiet = false, killBoundary = null, environment = {}, signal = null }) {
  const { spawn } = await import('node:child_process')
  assert.ok(['darwin', 'linux'].includes(process.platform), 'resource monitor supports the frozen macOS/Linux ps contract only')
  assert.ok(Number.isFinite(deadline) && deadline > Date.now(), 'phase deadline exhausted')
  await writeOnce(jobFile, job)
  const out = await fs.open(`${receipt}.stdout.log`, 'wx'), err = await fs.open(`${receipt}.stderr.log`, 'wx')
  const started = process.hrtime.bigint()
  const child = spawn(process.execPath, [worker, jobFile], { detached: true, stdio: ['ignore', out.fd, err.fd, 'ipc'], env: { ...process.env, ...environment } })
  await out.close(); await err.close()
  const events = [], consecutive = new Map(), peaks = new Map()
  let done = false, stop = null, currentStage = 'spawn', peakTreeRss = 0, exitResult, openedMs = null
  const kill = reason => { if (stop || done) return; stop = reason; if (!child.pid) return; try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  child.on('message', message => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    events.push({ elapsedMs: job.development ? null : elapsedMs, ...message })
    if (message.type === 'stage') currentStage = message.name
    if (message.type === 'opened') openedMs = job.development ? null : elapsedMs
    if (message.type === 'boundary') {
      if (message.boundary === killBoundary) kill({ kind: 'planned-process-interruption', boundary: killBoundary })
      else if (message.boundary !== 'after-flush-unsupported' && child.connected) child.send({ type: 'controller-ack', boundary: message.boundary }, () => {})
    }
  })
  const abort = () => kill({ kind: 'phase-resource', reason: signal.reason })
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const completion = new Promise(resolve => {
    child.once('error', error => { done = true; exitResult = { error: { name: error.name, message: error.message } }; resolve() })
    child.once('exit', (code, signal) => { done = true; exitResult = { code, signal }; resolve() })
  })
  const timeout = setTimeout(() => kill({ kind: 'phase-timeout', deadline }), Math.max(0, deadline - Date.now()))
  while (!done) {
    if (Date.now() >= deadline) kill({ kind: 'phase-timeout', deadline })
    try {
      const sample = await hostSample([child.pid])
      const ownedPids = descendants(sample.processes, [child.pid])
      const owned = sample.processes.filter(p => ownedPids.has(p.pid))
      const totalRss = owned.reduce((sum, p) => sum + p.rssBytes, 0)
      peakTreeRss = Math.max(peakTreeRss, totalRss)
      const present = new Set(owned.map(p => p.pid))
      for (const pid of consecutive.keys()) if (!present.has(pid)) consecutive.delete(pid)
      for (const p of owned) {
        peaks.set(p.pid, Math.max(peaks.get(p.pid) ?? 0, p.rssBytes))
        consecutive.set(p.pid, p.rssBytes > LIMITS.rssBytes ? (consecutive.get(p.pid) ?? 0) + 1 : 0)
        if (consecutive.get(p.pid) >= LIMITS.rssConsecutive) kill({ kind: 'rss-limit', pid: p.pid, rssBytes: p.rssBytes })
      }
      await append(hostFile, { type: 'worker-resource', workerPid: child.pid, stage: currentStage, ownedTreeRssBytes: totalRss, ...sample })
      if (quiet && (!Number.isFinite(sample.externalCpuFraction) || sample.externalCpuFraction < 0 || sample.externalCpuFraction > LIMITS.externalCpuFraction)) kill({ kind: 'external-load', externalCpuFraction: sample.externalCpuFraction })
    } catch (error) { kill({ kind: 'resource-observation-failure', message: error.message }) }
    if (!done) await Promise.race([completion, wait(LIMITS.sampleMs)])
  }
  await completion
  clearTimeout(timeout)
  signal?.removeEventListener('abort', abort)
  const descendantCleanup = { processGroup: child.pid ?? null, residualGroupFound: false, signal: null }
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      descendantCleanup.residualGroupFound = true
      descendantCleanup.signal = 'SIGKILL'
      if (!stop) stop = { kind: 'unexpected-owned-descendants', processGroup: child.pid }
    } catch (error) {
      if (error.code !== 'ESRCH') {
        descendantCleanup.error = { code: error.code, message: error.message }
        stop = { kind: 'owned-descendant-cleanup-failure', previousStop: stop }
      }
    }
  }
  const result = { job: jobFile, output: job.output, pid: child.pid, exit: exitResult, stop, descendantCleanup, events, processColdOpenMs: openedMs, elapsedMs: job.development ? null : Number(process.hrtime.bigint() - started) / 1e6, peakOwnedTreeRssBytes: peakTreeRss, peakRssByPid: Object.fromEntries(peaks), complete: exitResult?.code === 0 && !stop, resourceQualified: !stop || stop.kind === 'planned-process-interruption', noRetry: true, rssScope: '1-second ps RSS samples; per-process ceiling, descendant-inclusive aggregate peak; transient sub-second peaks may be missed.' }
  await writeOnce(receipt, result)
  return result
}
