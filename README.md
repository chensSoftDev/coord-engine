# coord-engine

AI Agent 需求迭代协调引擎：BACKLOG 状态机、coordination branch 事实存储、
worktree 并行、lease、gate/preflight、UX 门禁、completion PR 规划。
2026-10 自 `chensSoftDev/luggage-platform` 的 `scripts/lib/coordination/` 抽取
（需求 I-249）；抽取前的完整历史留在原仓库。

零 npm 依赖（纯 Node 内置），以 git submodule 分发，不需要 install 步骤。

## 集成契约（consuming 项目）

1. 以 submodule 挂载到项目根：`git submodule add <url> .coord-engine`
   —— 路径必须是仓库根下的一级目录：引擎的 PROJECT_ROOT 自路径推导以
   `.coord-engine/lib/coordination/commands/` 的深度为兜底。
2. 项目侧保留薄 shim `scripts/coordination.mjs`：

   ```js
   #!/usr/bin/env node
   import { main } from '../.coord-engine/lib/coordination/cli.mjs';
   process.exitCode = await main(process.argv.slice(2));
   ```

   项目脚本（guard.sh、playwright-guard、package.json 的 `coord` 命令）继续
   引用 `scripts/coordination.mjs`，不感知引擎位置。
3. `package.json` 接线：

   ```json
   {
     "scripts": {
       "coord": "node scripts/coordination.mjs",
       "coord:api-reference": "node .coord-engine/scripts/generate-api-reference.mjs",
       "test:coordination": "node --test scripts/test/coordination/*.test.mjs .coord-engine/test/coordination/*.test.mjs"
     }
   }
   ```

4. 部署/服务器侧：任何 `git checkout <ref>` 之后必须
   `git submodule update --init`，否则 guard/coord 入口不可用。
5. worktree：`coord worktree create/join` 会自动 init submodule（I-249）。

## 已知项目耦合（引擎命令读取 consuming 项目内容）

- `coord manifest init` 模板：`deploy/release-manifests/_example.env`
- `coord migration draft` 模板：`docs/releases/_TEMPLATE/MIGRATION.md`
- `.github/workflows/*` 契约与真实历史锚定的 completion 测试留在项目仓库
  （`scripts/test/coordination/`），由项目侧 `test:coordination` 一并执行

## 开发

```sh
node --test test/coordination/*.test.mjs   # 或 pnpm test
node scripts/coordination.mjs --help
```

版本随 consuming 项目的 submodule 指针浮动，暂不独立发版。
