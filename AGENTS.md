# 项目协作规则

## PR 交付流程

本项目的 PR 提交、PR-Agent 反馈处理、验证与合并流程，以 [`docs/pr-agent-workflow.prompt.md`](docs/pr-agent-workflow.prompt.md) 为唯一来源。

在开始以下任务前，必须先读取该文件，并按其中的流程执行：

- 提交 PR、监听 PR-Agent
- 处理 PR-Agent 的评论、检查结果与合并
- 验证并修复 PR-Agent 反馈

不要在本文件中复制流程正文；流程有变化时，只修改 `docs/pr-agent-workflow.prompt.md`。

> 注意：DSH 的 `AGENTS.md` 加载器不会自动展开 Markdown 链接或 `@path` 导入。这条引用是明确的读取指令：涉及上述任务时，先用文件读取工具打开目标文件，再开始操作。
