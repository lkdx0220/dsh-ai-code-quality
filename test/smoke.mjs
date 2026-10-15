// dsh-ai-code-quality 冒烟测试（node test/smoke.mjs / npm test）
//
// 覆盖外部审查指出的三个高优先级行为 + 注册/disposer：
//   1. 真实 scan → triage（参数顺序：--project 必须在子命令之后）
//   2. cq 不存在 → { ok:false, notStarted } 而非抛异常
//   3. 不存在的项目路径 → { ok:false } 而非 ok:true + null 数据
//   4. CLI 输出非 JSON 且 exit 0 → diff/gate/fix_plan 全部 { ok:false }
//   5. 12 工具注册 + disposer 卸载
//
// 运行前提：PATH 有 cq（主路径用例）；缺失命令用例自带假 command，不需要任何安装。

import { apply } from '../index.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const LAB_DIR = path.resolve(PLUGIN_DIR, '..') // 实验场根（含 src/tests 的 cq 副本）

let failures = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 300)}`)
  if (!cond) failures++
}

function makeCtx(sink) {
  return { tools: { register: (spec) => { sink.push(spec); return () => { sink.splice(sink.indexOf(spec), 1) } } } }
}
async function exec(sink, name, args, opts) {
  const tool = sink.find((s) => s.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool.execute(args, { signal: null, ...opts })
}

// ---------- 5. 注册 + disposer ----------
{
  const sink = []
  const dispose = apply(makeCtx(sink), { command: 'cq' })
  check('注册 12 个工具', sink.length === 12, sink.map((s) => s.name))
  const names = sink.map((s) => s.name)
  // 检查参数面（而非名字子串：suppress_reapply 合法含 apply）
  const fixPlan = sink.find((s) => s.name === 'cq_fix_plan')
  const rebuild = sink.find((s) => s.name === 'cq_spec_rebuild')
  check('fix 工具无 apply 参数', fixPlan && !('apply' in (fixPlan.parameters || {})), fixPlan?.parameters)
  check('spec-rebuild 工具无 apply 参数', rebuild && !('apply' in (rebuild.parameters || {})), rebuild?.parameters)
  dispose()
  check('disposer 卸载全部工具', sink.length === 0, sink.length)
}

// ---------- 主路径（需要真实 cq） ----------
const hasCq = await import('node:child_process')
  .then(({ execFile }) => new Promise((r) => execFile('cq', ['--version'], (e) => r(!e))))
  .catch(() => false)

if (hasCq) {
  const sink = []
  apply(makeCtx(sink), { command: 'cq', timeoutMs: 300000 })

  // 1. scan → triage（triage 成功即证明参数顺序已修复：此前 --project 前置导致 exit 2）
  const scan = await exec(sink, 'cq_scan', { project: LAB_DIR, adapters: 'ruff-check', noDeepsec: true })
  check('scan 真实执行 ok=true + runId', scan.ok === true && typeof scan.runId === 'string', scan)
  const triage = await exec(sink, 'cq_triage', { project: LAB_DIR, run: scan.runId })
  check('triage 真实执行 ok=true（参数顺序修复）', triage.ok === true, triage)

  // 3. 不存在的项目 → ok:false（exit 1 不再伪装成功）
  const badProj = await exec(sink, 'cq_scan', { project: 'C:\\path\\that\\does\\not\\exist' })
  check('scan 不存在的项目 → ok:false', badProj.ok === false, badProj)

  // waiver 缺理由（真实 CLI 的 exit 3 路径）
  const wv = await exec(sink, 'cq_waiver', { project: LAB_DIR, reason: 'x', ttl: 'bad-ttl' })
  check('waiver 非法 ttl → ok:false 透传', wv.ok === false, wv)
} else {
  console.log('SKIP 主路径用例（PATH 无 cq）')
}

// ---------- 2. cq 不存在 → 规范化错误，不抛异常 ----------
{
  const sink = []
  apply(makeCtx(sink), { command: '__definitely_missing_cq__' })
  let threw = null
  let result = null
  try {
    result = await exec(sink, 'cq_doctor', {})
  } catch (err) {
    threw = err
  }
  check('缺失 CLI 不抛异常', threw === null, String(threw))
  check('缺失 CLI → ok:false + notStarted', result?.ok === false && result?.notStarted === true, result)
}

// ---------- 4. 异常输出（非 JSON / 合法 JSON 但非 object）且 exit 0 → 全部 ok:false ----------
{
  const os = await import('node:os')
  // 存根写 os.tmpdir()（源码目录可能只读，审查反馈）；try/finally 保证中断也清理
  const mkstub = (name, body) => {
    const stub = path.join(os.tmpdir(), name)
    fs.writeFileSync(stub, body, 'utf8')
    return stub
  }
  // spawn 不经 shell，command 按空格拆分；tmpdir 含空格时 spawn 失败 → notStarted
  // （ok:false，合法错误路径，不算测试失败）
  const runWith = async (stubPath, cases) => {
    const rel = path.relative(process.cwd(), stubPath).replace(/\\/g, '/')
    const sink = []
    apply(makeCtx(sink), { command: `node ${rel}`, project: LAB_DIR })
    const out = {}
    for (const [name, args] of cases) {
      out[name] = await exec(sink, name, args).catch((e) => ({ ok: false, error: String(e) }))
    }
    return out
  }

  const cases = [
    ['cq_diff', { run: 'x', baseline: 'y' }],
    ['cq_gate', { run: 'x' }],
    ['cq_fix_plan', { run: 'x' }],
    ['cq_triage', { run: 'x' }],
  ]
  const stubA = mkstub('cq-stub-notjson.mjs', "process.stdout.write('this is definitely not json'); process.exit(0)\n")
  const stubB = mkstub('cq-stub-null.mjs', "process.stdout.write('null'); process.exit(0)\n")
  try {
    const a = await runWith(stubA, cases)
    for (const [name] of cases) check(`${name} 非 JSON 输出 → ok:false`, a[name].ok === false, a[name])
    const b = await runWith(stubB, cases)
    for (const [name] of cases) check(`${name} JSON null 输出 → ok:false`, b[name].ok === false, b[name])
  } finally {
    fs.rmSync(stubA, { force: true })
    fs.rmSync(stubB, { force: true })
  }
}

console.log(failures === 0 ? '\nSMOKE ALL OK' : `\nSMOKE FAILED: ${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
