import { runCq, parseJsonOutput } from './lib/cq.js'

// 宿主契约：@deepseek-ai/dsh-tools 由宿主运行时提供（asar overlay 解析）。
// 不做 passthrough 兜底（项目规则：消除 fallback 触发场景）——本地裸 Node 解析不到
// 属预期，直接 fail-fast，让"插件在不在真宿主里"在加载期就可判定，而不是
// 在每次工具调用时以 output.render 缺失的形式晚爆。
let defineTool
if (globalThis.__DSH_TEST_DEFINE_TOOL__) {
  // 测试宿主模拟（仅 npm test）：注入与宿主同语义的 defineTool——它同样要求
  // output.render 并在包装层调用，复现宿主契约路径而非绕过契约的 passthrough（D5 教训）
  defineTool = globalThis.__DSH_TEST_DEFINE_TOOL__
} else {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    defineTool = mod.defineTool
  } catch (err) {
    throw new Error(
      'dsh-ai-code-quality: @deepseek-ai/dsh-tools unavailable — this plugin must load ' +
      'inside a dsh host profile, not bare Node. Original error: ' + String(err?.message || err),
    )
  }
  if (typeof defineTool !== 'function') {
    throw new Error('dsh-ai-code-quality: dsh-tools did not export defineTool')
  }
}

let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  // schemastery 仅影响 Config 的 schema 形态（z.object），描述符对象同样合法；
  // 它不影响工具 output/parameters 的宿主校验路径，保留兜底不掩盖契约差异
}

export const name = 'dsh-ai-code-quality'
export const inject = ['tools']

const configFields = {
  command: str('cq CLI invocation. Use "cq" when installed on PATH, or a Python form such as "py -3 -m ai_code_quality.cli".', 'cq'),
  project: str('Default project path passed as --project when a tool call does not override it.', '.'),
  timeoutMs: num('Per-command timeout in milliseconds (0 disables). Full scans of large trees can take minutes.', 900000),
  maxOutputChars: num('Cap on captured CLI stdout/stderr per run, in characters.', 60000),
}

export const Config = z ? z.object(configFields) : { type: 'object', properties: configFields }

export function apply(ctx, config = {}) {
  const opts = {
    command: config.command || 'cq',
    project: config.project || '.',
    timeoutMs: numberOr(config.timeoutMs, 900000),
    maxOutputChars: Math.max(1000, numberOr(config.maxOutputChars, 60000)),
  }

  const specs = [
    doctorTool(opts),
    scanTool(opts),
    triageTool(opts),
    baselineTool(opts),
    diffTool(opts),
    gateTool(opts),
    waiverTool(opts),
    specGateTool(opts),
    fixPlanTool(opts),
    suppressReapplyTool(opts),
    specRebuildTool(opts),
    promoteTool(opts),
  ]

  const disposers = specs.map((spec) => ctx.tools.register(defineTool(spec))).filter(Boolean)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// 宿主 defineTool 契约：output.render 为必需项（缺失时注册通过、每次调用在
// 渲染阶段抛 userRender is not a function —— 见缺陷报告 D1）。所有工具都返回
// JSON 对象，共用一个渲染器。
function objectOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

// ---- shared helpers -------------------------------------------------------

async function runJsonTool(opts, args, { accept, exec, json = true } = {}) {
  // 子命令在前，--project 由各工具在子命令后拼接（cq 基于 argparse 子命令，
  // 子命令之前出现参数会 unrecognized → exit 2）
  const res = await runCq({ ...opts, signal: exec?.signal }, args, accept || [0])
  const failure = asFailure(res)
  if (failure) return failure
  if (!json) return { ok: true, exitCode: res.code, text: res.stdout.trim(), stderr: tail(res.stderr, 2000) }
  const parsed = parseJsonOutput(res.stdout)
  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      error: 'cq produced unparseable or non-object JSON output.',
      exitCode: res.code,
      stdout: tail(res.stdout, 2000),
      stderr: tail(res.stderr, 2000),
    }
  }
  return { ok: true, exitCode: res.code, data: parsed }
}

function isJsonObject(v) {
  // 合法 JSON 的 null / 数组 / 字符串都不是工具的合法返回形态：
  // cq 的 --format json 输出永远是 object（typeof null === 'object' 故显式排除）
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function asFailure(res) {
  if (res.notStarted) {
    return {
      ok: false,
      notStarted: true,
      error: res.stderr || 'cq CLI failed to start.',
      hint: 'Install ai-code-quality (uv tool install git+https://github.com/lkdx0220/ai-code-quality-skill) or fix the plugin "command" config.',
    }
  }
  if (res.timedOut) {
    return { ok: false, error: 'cq command timed out and was terminated.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
  }
  if (res.aborted) {
    return { ok: false, error: 'cq command was cancelled.', exitCode: res.code }
  }
  if (!res.accepted) {
    return {
      ok: false,
      error: `cq exited with code ${res.code}.`,
      exitCode: res.code,
      stdout: tail(res.stdout, 2000),
      stderr: tail(res.stderr, 2000),
    }
  }
  return null
}

function projectParam() {
  return { type: 'string', description: 'Project path. Defaults to the plugin "project" config (default ".").' }
}

function tail(text, max) {
  const value = String(text || '')
  return value.length > max ? `…${value.slice(value.length - max)}` : value
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function str(description, fallback) {
  return z ? z.string().description(description).default(fallback) : { type: 'string', description, default: fallback }
}

function num(description, fallback) {
  return z ? z.number().description(description).default(fallback) : { type: 'number', description, default: fallback }
}

// ---- tools ----------------------------------------------------------------

function doctorTool(opts) {
  return {
    name: 'cq_doctor',
    description:
      'Environment health check for the cq toolchain: probes the 8 external tools (ruff, mypy, radon, vulture, pytest, ' +
      'pytest-cov, import-linter, DeepSec), reports which interpreter is used and where it came from, and gives install ' +
      'commands for anything missing. Machine-level check (no --project); run this first on a new machine; never assume ' +
      'tools are installed.',
    parameters: {},
    output: objectOutput(),
    async execute(args, exec) {
      const res = await runCq({ ...opts, signal: exec?.signal }, ['doctor', '--format', 'json'], [0, 2])
      const failure = asFailure(res)
      if (failure) return failure
      const parsed = parseJsonOutput(res.stdout)
      if (!isJsonObject(parsed)) {
        return { ok: false, error: 'cq doctor produced unparseable or non-object JSON output.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
      }
      return { ok: true, exitCode: res.code, ...parsed }
    },
  }
}

function scanTool(opts) {
  return {
    name: 'cq_scan',
    description:
      'Full deterministic code-quality scan of a Python repository: aggregates ruff, ruff-format, mypy, radon, vulture, ' +
      'pytest-cov, import-linter and DeepSec(L1/L2) into one findings report. Read-only; artifacts land in audits/<run_id>/. ' +
      'Returns run_id, per-tool status (missing tools are reported as skipped, never silently passed) and severity totals.',
    parameters: {
      project: projectParam(),
      scope: { type: 'string', description: '"full" (default) or "changed" (only git-changed .py files).' },
      adapters: { type: 'string', description: 'Comma-separated adapter subset, e.g. "ruff-check,mypy,radon".' },
      noDeepsec: { type: 'boolean', description: 'Skip the DeepSec security adapter.' },
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['scan', '--project', args.project || opts.project, '--format', 'json']
      if (args.scope) argv.push('--scope', args.scope)
      if (args.adapters) argv.push('--adapters', args.adapters)
      if (args.noDeepsec) argv.push('--no-deepsec')
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0, 2])
      const failure = asFailure(res)
      if (failure) return failure
      const parsed = parseJsonOutput(res.stdout)
      if (!isJsonObject(parsed) || typeof parsed.run_id !== 'string') {
        return { ok: false, error: 'cq scan produced unparseable or non-object JSON output.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
      }
      const runId = parsed.run_id
      const artifacts = `audits/${runId}/`
      const tools = Array.isArray(parsed.tools) ? parsed.tools : []
      return {
        ok: true,
        exitCode: res.code,
        runId,
        toolsIncomplete: res.code === 2,
        toolsSkipped: tools.filter((t) => t.status === 'skipped').length,
        tools,
        notes: parsed.notes ?? [],
        summary: parsed.totals ?? null,
        artifacts: {
          report: `${artifacts}report.md`,
          findings: `${artifacts}findings.json`,
          summary: `${artifacts}summary.json`,
        },
      }
    },
  }
}

function triageTool(opts) {
  return {
    name: 'cq_triage',
    description:
      'Categorize a scan run into four dimensions (security / reliability / maintainability / test) with per-finding ' +
      'dispositions (auto_fixable / needs_test / needs_refactor / needs_decision / needs_review) and recommended fix batches.',
    parameters: {
      run: { type: 'string', required: true, description: 'Run id (unique prefix OK) from a previous cq_scan.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      return runJsonTool(opts, ['triage', '--run', args.run, '--format', 'json', '--project', args.project || opts.project], { exec })
    },
  }
}

function baselineTool(opts) {
  return {
    name: 'cq_baseline',
    description: 'Persist a scan run as a named baseline so later diff/gate calls can compare against it.',
    parameters: {
      run: { type: 'string', required: true, description: 'Run id to freeze as baseline.' },
      name: { type: 'string', description: 'Baseline name (letters/digits/_/-). Default "baseline".' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['baseline', '--run', args.run, '--name', args.name || 'baseline', '--project', args.project || opts.project]
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0])
      const failure = asFailure(res)
      if (failure) return failure
      return { ok: true, exitCode: res.code, output: tail(res.stdout, 2000) }
    },
  }
}

function diffTool(opts) {
  return {
    name: 'cq_diff',
    description:
      'Compare a scan run against a baseline: new / fixed / existing / moved findings. Exit-code semantics surface ' +
      'as hasNewBlockerHigh in the response (exit 1 = new blocker/high found).',
    parameters: {
      run: { type: 'string', required: true, description: 'Run id to compare.' },
      baseline: { type: 'string', required: true, description: 'Baseline name or another run id.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['diff', '--run', args.run, '--baseline', args.baseline, '--format', 'json', '--project', args.project || opts.project]
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0, 1])
      const failure = asFailure(res)
      if (failure) return failure
      const parsed = parseJsonOutput(res.stdout)
      if (!isJsonObject(parsed)) {
        return { ok: false, error: 'cq diff produced unparseable or non-object JSON output.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
      }
      return {
        ok: true,
        exitCode: res.code,
        hasNewBlockerHigh: res.code === 1,
        counts: {
          new: parsed.new, fixed: parsed.fixed, existing: parsed.existing,
          moved: parsed.moved, suppressed: parsed.suppressed,
        },
        newDetails: parsed.new_details ?? [],
      }
    },
  }
}

function gateTool(opts) {
  return {
    name: 'cq_gate',
    description:
      'Quality gate acceptance: blocker/high limits, complexity D/E/F = 0, coverage threshold, and (with baseline) ' +
      'zero new blocker/high. Exit 2 means tools were incomplete — treat as "cannot judge", never as pass.',
    parameters: {
      run: { type: 'string', required: true, description: 'Run id to accept.' },
      baseline: { type: 'string', description: 'Baseline name or run id; enables the new-blocker/high check.' },
      target: { type: 'string', description: 'A (default): 0 blocker/0 high. B: 0 blocker/≤2 high.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['gate', '--run', args.run, '--target', args.target || 'A', '--format', 'json', '--project', args.project || opts.project]
      if (args.baseline) argv.push('--baseline', args.baseline)
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0, 1, 2])
      const failure = asFailure(res)
      if (failure) return failure
      const parsed = parseJsonOutput(res.stdout)
      if (!isJsonObject(parsed)) {
        return { ok: false, error: 'cq gate produced unparseable or non-object JSON output.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
      }
      return {
        ok: true,
        exitCode: res.code,
        passed: res.code === 2 ? null : parsed.passed === true,
        cannotJudge: res.code === 2,
        ratings: parsed.ratings ?? null,
        checks: parsed.checks ?? [],
        nextSteps: parsed.next_steps ?? [],
      }
    },
  }
}

function waiverTool(opts) {
  return {
    name: 'cq_waiver',
    description:
      'Create a time-boxed spec-drift waiver for "code first, spec later" workflows: writes a decision file under ' +
      'waiver_dir and records it in .cq/suppressions.json with kind=spec_waiver. Expires automatically; after expiry ' +
      'spec-gate --mode=hard treats it as drift. Requires .specdrift.toml in the project. Reason is mandatory.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why the waiver is needed (mandatory, audited).' },
      ttl: { type: 'string', required: true, description: 'Time-to-live, e.g. "30m", "12h", "7d".' },
      change: { type: 'string', description: 'Related change/proposal id (optional).' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['waiver', '--reason', args.reason, '--ttl', args.ttl, '--project', args.project || opts.project]
      if (args.change) argv.push('--change', args.change)
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0])
      const failure = asFailure(res)
      if (failure) return failure
      return { ok: true, exitCode: res.code, output: tail(res.stdout, 2000) }
    },
  }
}

function specGateTool(opts) {
  return {
    name: 'cq_spec_gate',
    description:
      'Spec anti-drift gate: verify that changed code under managed paths is declared by an active spec proposal. ' +
      'soft mode warns only (exit 0); hard mode exits 1 on drift. For CI use --base <ref> (merge-base range) or ' +
      '--range <A..B>: a clean checkout has an empty working tree and would always pass without them. ' +
      'Requires .specdrift.toml; without it the tool bypasses (ok, notConfigured).',
    parameters: {
      mode: { type: 'string', description: '"soft" (default, warn only) or "hard" (drift → exit 1).' },
      paths: { type: 'string', description: 'Comma-separated managed paths overriding .specdrift.toml code_paths.' },
      base: { type: 'string', description: 'Compare <ref>...HEAD managed changes (CI usage).' },
      range: { type: 'string', description: 'Explicit revision range like main...feature.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['spec-gate', '--mode', args.mode || 'soft', '--project', args.project || opts.project]
      if (args.paths) argv.push('--paths', args.paths)
      if (args.base) argv.push('--base', args.base)
      if (args.range) argv.push('--range', args.range)
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0, 1])
      const failure = asFailure(res)
      if (failure) return failure
      return { ok: true, exitCode: res.code, drift: res.code === 1, report: tail(res.stdout, 6000) }
    },
  }
}

function fixPlanTool(opts) {
  return {
    name: 'cq_fix_plan',
    description:
      'Batched fix plan for a scan run (dry-run only): groups findings into auto-fixable / security / refactor / test / ' +
      'manual batches with files and commands. NOTE: the apply step is intentionally NOT exposed here — applying changes ' +
      'code and must be run explicitly via `cq fix --batch N --apply` with user approval, then re-scan and gate.',
    parameters: {
      run: { type: 'string', required: true, description: 'Run id.' },
      batch: { type: 'number', description: 'Show only this batch number.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['fix', '--run', args.run, '--format', 'json', '--project', args.project || opts.project]
      if (args.batch != null) argv.push('--batch', String(args.batch))
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0])
      const failure = asFailure(res)
      if (failure) return failure
      const parsed = parseJsonOutput(res.stdout)
      if (!isJsonObject(parsed)) {
        return { ok: false, error: 'cq fix produced unparseable or non-object JSON output.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
      }
      return { ok: true, exitCode: res.code, plan: parsed }
    },
  }
}

function suppressReapplyTool(opts) {
  return {
    name: 'cq_suppress_reapply',
    description:
      'Re-align existing finding suppressions to a newer run by line-independent signature (source+rule+file+message). ' +
      'Use after large refactors or mass reformats when suppression ids stopped matching. Never creates new suppressions.',
    parameters: {
      run: { type: 'string', required: true, description: 'Run id whose findings define the new ids.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['suppress', '--run', args.run, '--reapply', '--project', args.project || opts.project]
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0])
      const failure = asFailure(res)
      if (failure) return failure
      return { ok: true, exitCode: res.code, output: tail(res.stdout, 2000) }
    },
  }
}

function specRebuildTool(opts) {
  return {
    name: 'cq_spec_rebuild',
    description:
      'Heuristic spec-vs-code reconciliation (lead list, NOT truth): extracts public symbols from code_paths via AST, ' +
      'word-matches them against spec text (code-missing-in-spec) and reverse-matches spec headings (spec-missing-in-code, ' +
      'low confidence). Draft mode only — never writes; --apply is intentionally not exposed. Requires .specdrift.toml.',
    parameters: {
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['spec-rebuild', '--draft', '--json', '--project', args.project || opts.project]
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0])
      const failure = asFailure(res)
      if (failure) return failure
      const parsed = parseJsonOutput(res.stdout)
      if (!isJsonObject(parsed)) {
        return { ok: false, error: 'cq spec-rebuild produced unparseable or non-object JSON output.', exitCode: res.code, stderr: tail(res.stderr, 2000) }
      }
      return { ok: true, exitCode: res.code, ...parsed }
    },
  }
}

function promoteTool(opts) {
  return {
    name: 'cq_promote',
    description:
      'Decision promotion candidates: recurring similar decisions (decisions/ + ledger waivers) clustered by slug/keyword, ' +
      'surfaced as constitution draft paragraphs. Read-only — never writes files. Requires .specdrift.toml.',
    parameters: {
      id: { type: 'string', description: 'Optional decision identifier (file name or slug prefix) to draft specifically.' },
      project: projectParam(),
    },
    output: objectOutput(),
    async execute(args, exec) {
      const argv = ['promote', '--project', args.project || opts.project]
      if (args.id) argv.push('--id', args.id)
      const res = await runCq({ ...opts, signal: exec?.signal }, argv, [0])
      const failure = asFailure(res)
      if (failure) return failure
      return { ok: true, exitCode: res.code, output: tail(res.stdout, 6000) }
    },
  }
}
