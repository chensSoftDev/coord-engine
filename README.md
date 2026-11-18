# coord-engine

协调引擎由项目以 Git 子模块固定版本。引擎包含需求状态机、协调事实存储、worktree、lease、发布门禁和测试证据。

## 项目接入

- 将子模块检出到项目根目录的 `.coord-engine`。协调守卫以消费项目根目录为信任边界。
- 通过项目的 `pnpm coord` 使用 CLI，通过 `pnpm coord:api-reference --check` 检查项目 API 参考文档。
- 项目在新 clone、worktree 及发布候选或 tag 检出时初始化固定提交。先提交引擎，再在项目仓库更新子模块指针。
- 从项目根运行 `pnpm test:coordination`，同时运行引擎测试与项目契约测试。单独开发引擎时可从本仓根运行 `pnpm test`。

发布模板、业务迁移草稿和项目契约由消费项目提供。共享 E2E 覆盖校验由引擎提供，消费项目负责运行 Playwright 和配置测试环境。
