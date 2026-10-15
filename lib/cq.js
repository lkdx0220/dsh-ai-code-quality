import { spawn } from 'node:child_process'

// Grace period between SIGTERM and SIGKILL when a run is cancelled or times out.
const KILL_GRACE_MS = 5000

/**
 * Run the cq CLI as a child process and capture its output.
 *
 * cq exit-code contract (per command, see README「用法」):
 *   scan   0 ok / 1 usage / 2 tools error-timeout (partial results kept)
 *   gate   0 pass / 1 failed / 2 tools incomplete / 3 usage
 *   diff   0 ok / 1 new blocker-high / 3 usage
 *   spec-gate 0 ok / 1 drift / 3 usage
 * Callers decide via `acceptExitCodes` and shape the response.
 *
 * Resolves with:
 *   { code, accepted, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, aborted, notStarted }
 *
 * notStarted: the child process could not be spawned at all (CLI missing / spawn
 * rejected). code is 'spawn-error' and stderr carries the friendly message; the
 * promise still resolves — execute() never throws (dsh contract: domain failures
 * belong in the return value).
 */
export function runCq(options, args, acceptExitCodes = [0]) {
  const {
    command = 'cq',
    timeoutMs = 0,
    maxOutputChars = 60000,
    signal,
  } = options || {}

  return new Promise((resolve, reject) => {
    const base = String(command || '').trim().split(/\s+/).filter(Boolean)
    if (base.length === 0) {
      resolve({
        code: 'spawn-error',
        notStarted: true,
        accepted: false,
        stdout: '',
        stderr: 'cq command is empty; set the "command" plugin config (e.g. "cq" or "py -3 -m ai_code_quality.cli").',
        stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false,
      })
      return
    }

    const spawnFailure = (error) => ({
      code: 'spawn-error',
      notStarted: true,
      accepted: false,
      stdout: '',
      stderr: String(spawnError(error, command).message),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    })

    let child
    try {
      child = spawn(base[0], [...base.slice(1), ...args], {
        env: process.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // 启动失败不走 reject：resolve 规范化结果，由调用方统一映射为 { ok:false }，
      // 工具的 execute 永不抛异常（dsh 契约：领域失败放返回值）
      resolve(spawnFailure(error))
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (chunk, kind) => {
      const text = chunk.toString('utf8')
      const current = kind === 'stdout' ? stdout : stderr
      if (current.length >= maxOutputChars) {
        if (kind === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
        return
      }
      const room = maxOutputChars - current.length
      const piece = text.length > room ? text.slice(0, room) : text
      if (kind === 'stdout') {
        stdout += piece
        if (text.length > room) stdoutTruncated = true
      } else {
        stderr += piece
        if (text.length > room) stderrTruncated = true
      }
    }

    let killTimer = null
    const killHard = () => {
      if (killTimer === null) {
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        killTimer.unref()
      }
    }
    const terminate = (reason) => {
      if (reason === 'timeout') timedOut = true
      else aborted = true
      child.kill('SIGTERM')
      killHard()
    }

    const timer = timeoutMs > 0 ? setTimeout(() => terminate('timeout'), timeoutMs) : null
    if (timer) timer.unref()
    const onAbort = () => terminate('abort')

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(spawnFailure(error))
    })
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        code: code === null ? (aborted ? 'aborted' : 'killed') : code,
        accepted: acceptExitCodes.includes(code),
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
      })
    })
  })
}

function spawnError(error, command) {
  const message = String((error && error.message) || error)
  if (error && (error.code === 'ENOENT' || message.includes('ENOENT'))) {
    return new Error(
      `cq CLI not found via command "${command}". ` +
        'Install ai-code-quality first (uv tool install git+https://github.com/lkdx0220/ai-code-quality-skill), ' +
        'or point the plugin "command" config at a Python form such as "py -3 -m ai_code_quality.cli".',
    )
  }
  return error instanceof Error ? error : new Error(message)
}

/**
 * Extract the last JSON document embedded in mixed CLI output.
 * cq may print warnings around the JSON payload.
 */
export function parseJsonOutput(text) {
  const direct = tryParse(text)
  if (direct !== undefined) return direct
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1))
    if (sliced !== undefined) return sliced
  }
  return undefined
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
