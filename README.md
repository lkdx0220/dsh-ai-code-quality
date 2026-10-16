# dsh-ai-code-quality

`dsh-ai-code-quality` 是 DeepSeek Harness（DSH）插件，为 Agent 提供一组类型化的 `cq_*` 工具，用于执行 [ai-code-quality](https://github.com/lkdx0220/ai-code-quality-skill) 的确定性代码质量流程。

插件本身不重新实现检测规则。每次调用都启动 `cq` CLI，并解析其 `--format json` 输出；扫描、聚合、基线、质量门和豁免账本仍由 cq 负责。插件适合需要在 DSH 会话中检查 Python 仓库、比较质量基线或规划修复批次的项目。

> **语言边界：当前版本只支持 Python 仓库的代码质量扫描。** `cq_scan`、`cq_triage`、`cq_gate`、`cq_diff`、`cq_fix_plan` 和 `cq_spec_rebuild` 依赖 Python 目标与 Python 工具链；对 Java、Go、TypeScript 等非 Python 仓库，不会产生完整的代码质量结论，扫描可能因找不到 `.py` 目标而返回空结果。

语言无关的能力仍可使用：`cq_spec_gate`、`cq_waiver` 和 `cq_promote` 只依赖 git 与 Markdown/spec 文本，不要求 Python 源码。多语言 adapter 尚未包含在当前插件版本中。

## Web UI 范围

这是一个 **host 侧工具插件**，不是 Web UI 插件。它可以安装到 DSH Web profile，并在 Web 会话中提供 `cq_*` 工具；但不会注入浏览器脚本、添加设置页、侧栏按钮、主题或其他可视化组件。因此 `package.json` 有 `dsh.bundle` 配置，但没有 `dsh.client` 配置。

## 能力

| 工具 | 用途 | 是否写入项目 |
|---|---|---:|
| `cq_doctor` | 检查 8 个外部工具、解释器和安装来源 | 否 |
| `cq_scan` | 运行完整或选定 adapter 的扫描，返回 run id、工具状态、跳过项和严重度汇总 | 写入 `audits/<run_id>/` |
| `cq_triage` | 按安全、可靠性、可维护性和测试维度归类 findings，并生成修复批次 | 否 |
| `cq_baseline` | 固化一个扫描 run，供后续 diff/gate 使用 | 写入基线 |
| `cq_diff` | 比较 run 与基线，报告 new/fixed/existing/moved/suppressed | 否 |
| `cq_gate` | 执行 blocker/high、复杂度、覆盖率和基线门禁 | 否 |
| `cq_waiver` | 创建带期限、带理由的 spec-drift 豁免 | 写入决策与账本 |
| `cq_spec_gate` | 检查代码变更是否由 spec proposal 声明 | 否 |
| `cq_fix_plan` | 输出分批修复计划；只做 dry-run | 否 |
| `cq_suppress_reapply` | 按稳定签名把已有 suppression 对齐到新 run | 写入 suppression 账本 |
| `cq_spec_rebuild` | 输出 spec 与代码符号的启发式对账线索 | 否 |
| `cq_promote` | 输出可晋升为 constitution 条款的重复决策候选 | 否 |

`cq_scan` 会明确返回每个 adapter 的 `status`，并把缺失工具列为 `skipped`；`cq_gate` 遇到工具不完整时返回 `cannotJudge`，不会把不完整结果当作通过。

## 安全边界

插件工具面不暴露会直接修改代码的操作。`cq fix --apply` 和 `cq spec-rebuild --apply` 必须由用户在 CLI 中显式执行，再重新扫描和过门禁。

插件包含两类有意的写状态操作：创建 baseline、waiver，以及更新 suppression 账本。这些操作都会返回 CLI 结果，并把审计材料落到项目目录，便于复核和回滚。

## 前置条件

- DSH 宿主支持插件的 `defineTool` 和 bundle 配置。
- Node.js ≥ 20。
- 已安装 [ai-code-quality/cq](https://github.com/lkdx0220/ai-code-quality-skill)。
- `cq` 在 PATH 中可执行，或在插件配置的 `command` 字段中提供替代调用方式。
- 代码质量扫描当前只支持 Python 仓库；非 Python 仓库请只使用明确标注为语言无关的 spec 工具。

插件运行时依赖的 `@deepseek-ai/dsh-tools` 由 DSH 宿主提供，不能用裸 Node 直接加载插件来代替宿主验证。

## 安装与验证

开发版或本地目录可以安装到目标 profile：

```bash
dsh plugin --profile <profile> add /path/to/dsh-ai-code-quality
dsh --profile <profile> --dump-config
```

安装后重启 DSH 宿主，让 profile 重新装配 bundle。首次验证建议按这个顺序进行：

1. 调用 `cq_doctor`，确认 cq 和外部工具状态。
2. 调用 `cq_scan`，确认返回 `runId`、`tools`、`toolsSkipped`、`notes` 和 `summary`。
3. 使用该 `runId` 调用 `cq_triage` 或 `cq_gate`。
4. 需要比较历史结果时，再创建 baseline 并调用 `cq_diff`。

如果宿主提示 `@deepseek-ai/dsh-tools unavailable`，说明插件被裸 Node 或错误的 DSH profile 加载；应在实际 DSH 宿主和目标 profile 中验证。

## 配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `command` | `cq` | cq CLI 调用方式，例如 `cq` 或 `py -3 -m ai_code_quality.cli` |
| `project` | `.` | 工具未单独指定项目时使用的项目路径 |
| `timeoutMs` | `900000` | 单次 CLI 调用超时时间；`0` 表示不设超时 |
| `maxOutputChars` | `60000` | 每次调用捕获的 stdout/stderr 上限 |

工具参数中的 `project` 会覆盖插件级默认值。`cq_scan` 还支持 `scope`、`adapters` 和 `noDeepsec`；其他参数以工具 schema 为准。

## 本地开发与测试

在插件目录运行：

```bash
npm test
```

冒烟测试覆盖工具注册与 disposer、`output.render` 宿主契约、真实 cq 主路径（环境允许时）、缺失 CLI、非法项目路径以及非 JSON 输出。受限环境中如果禁止管道子进程，普通测试会明确报告主路径 `SKIP`；`SMOKE_STRICT=1` 会把未执行主路径视为失败：

```bash
SMOKE_STRICT=1 npm test
```

测试插件文件本身不等于 DSH 宿主验证；提交前仍应在目标 DSH profile 重启后实际调用 `cq_doctor` 和 `cq_scan`。

## 与 cq Skill 的关系

DSH 插件和 [`agent-adapters/dsh/SKILL.md`](https://github.com/lkdx0220/ai-code-quality-skill/tree/main/agent-adapters/dsh) 是同一 cq CLI 的两种接入方式：

- 插件已装配时，Agent 优先使用 `cq_*` 类型化工具，结果结构稳定，适合编排 scan → triage → gate 流程。
- 插件未装配时，DSH Skill 仍可直接调用 cq CLI，能力保持可用。

插件版本和 cq 本体版本分别维护。发布插件时应同时记录兼容的 cq 版本范围，并附上 `npm test` 与真实宿主验证结果。

## 许可证与第三方工具声明

本插件及 `cq` 编排代码以 MIT 许可证发布，完整文本见 [`LICENSE`](LICENSE)。插件不包含下列检测工具的源代码，只在运行时调用用户环境中已安装的工具；它们的版权归各自作者，并分别遵循上游许可证：

| 工具 | 用途 | 许可证 | 上游 |
|---|---|---|---|
| [ruff](https://github.com/astral-sh/ruff) | lint、格式检查 | MIT | Astral |
| [mypy](https://github.com/python/mypy) | 静态类型检查 | MIT | python/mypy |
| [radon](https://github.com/rubik/radon) | 圈复杂度、可维护性指数 | MIT | rubik/radon |
| [vulture](https://github.com/jendrikseipp/vulture) | 死代码检测 | MIT | jendrikseipp |
| [pytest](https://github.com/pytest-dev/pytest) / [pytest-cov](https://github.com/pytest-dev/pytest-cov) | 测试执行、覆盖率 | MIT | pytest-dev |
| [import-linter](https://github.com/seddony/import-linter) | 架构依赖契约 | BSD 2-Clause | seddony |
| [DeepSec](https://github.com/Unclecheng-li/DeepSec) | L1/L2 安全扫描 | MIT | Unclecheng-li |

插件自身只负责 DSH 工具注册与 `cq` CLI 调用；底层检测结论由上述工具产生。
