# dsh-ai-code-quality

[ai-code-quality（`cq`）](https://github.com/lkdx0220/ai-code-quality-skill) 的 DeepSeek Harness（DSH）工具插件：把确定性代码质量流水线（doctor / scan / triage / baseline / diff / gate / waiver / spec-drift）包装成 Agent 可直接调用的类型化工具。

**薄封装，不重写引擎**：插件以子进程调用 `cq` CLI（`--format json` 采集机器可读结果），检测、聚合、门禁逻辑全部复用 cq 本体。行为与 CLI 完全一致。

## 工具一览

| 工具 | 作用 |
|---|---|
| `cq_doctor` | 环境体检：8 个外部工具的就绪状态、解释器与来源、缺失安装命令 |
| `cq_scan` | 全量扫描（8 adapter 聚合），返回 run_id + 分级统计 + 产物路径 |
| `cq_triage` | findings 四维归因 + 处置建议 + 修复批次 |
| `cq_baseline` | 固化基线（供 diff/gate 引用） |
| `cq_diff` | 对比基线：new/fixed/existing/moved（`hasNewBlockerHigh` 直接给判定） |
| `cq_gate` | 质量门：逐项检查 + local_rating + 通过/未达标 |
| `cq_waiver` | spec 驱动项目的有期限豁免（decisions/ 留痕 + 债务账本） |
| `cq_spec_gate` | spec 防漂移门（CI 场景用 `--base origin/main`） |
| `cq_fix_plan` | 分批修复计划（**dry-run**；apply 不在工具面——改代码必须走 CLI 显式批准） |
| `cq_suppress_reapply` | 存量豁免按签名对齐新 run |
| `cq_spec_rebuild` | 启发式对账线索清单（draft，永不写入） |
| `cq_promote` | 决策晋升候选（只输出，永不写文件） |

**安全设计**：工具面只读 + 账本审计类写入；`fix --apply` / `spec-rebuild --apply` 刻意不暴露——
改代码必须由用户通过 CLI 显式批准执行。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `cq` | cq 调用方式；PATH 无 cq 时可用 `"py -3 -m ai_code_quality.cli"` 等 Python 形式 |
| `project` | `.` | 各工具 `--project` 的默认值 |
| `timeoutMs` | 900000 | 单命令超时（大仓库全量扫描可能需要更久） |
| `maxOutputChars` | 60000 | 捕获的 stdout/stderr 上限 |

## 安装

前置：Node.js ≥ 20、[ai-code-quality](https://github.com/lkdx0220/ai-code-quality-skill) 已安装且 `cq` 在 PATH（或通过 `command` 配置指定调用形式）。

```bash
dsh plugin --profile <profile> add /path/to/dsh-ai-code-quality
dsh --profile <profile> --dump-config   # 验证
```

安装后对 Agent 直接说自然语言即可，例如：

- “帮我审一下这个项目的代码质量”（scan → triage → gate）
- “这次改动和基线比有没有引入新的严重问题”（diff）
- “检查一下我们项目 spec 有没有和代码漂移”（spec-gate）

## 与 skill 的关系

`SKILL.md`（行为说明书）与本插件（类型化工具）是同一 `cq` CLI 的两种接入形态：
插件优先；插件未安装时 Agent 按 SKILL.md 直接调 CLI，能力无损降级。
