# Plan: ~/.omp → ~/.stp 配置目录安全迁移

## Overview
代码层已部分迁移至 `.stp`（`dirs.ts` 中 `CONFIG_DIR_NAME = ".stp"`），但 Rust crash handler、JS natives loader、多个脚本和测试仍硬编码 `.omp`，且磁盘上实际数据都在 `~/.omp`，`~/.stp` 仅有骨架。需完成代码层对齐 + 数据层自动迁移。

## Phase 1: 修复代码层的 split-brain（Rust + JS natives）
**Contract:** 所有路径解析层统一使用 `.stp`，通过 `PI_CONFIG_DIR` 可覆盖。

- [ ] **Task: Rust crash_handler.rs 对齐 .stp**
  - Files: `crates/pi-natives/src/crash_handler.rs`
  - Change: 将 `DEFAULT_CONFIG_DIR` 从 `".omp"` 改为 `".stp"`（line 49），`APP_NAME` 从 `"omp"` 改为 `"stp"`（line 55）。保留 `PI_CONFIG_DIR` 环境变量读取逻辑，确保 TS 侧的 override 也生效。同时将 crash log 写入路径中的 `omp-crash.log` 改为 `stp-crash.log`。
  - Acceptance: Rust 侧所有默认路径指向 `.stp`。`cargo check` 通过。
  - Depends: none

- [ ] **Task: JS natives loader 对齐 .stp**
  - Files: `packages/natives/native/loader-state.js`
  - Change: `getNativesDir()` 中的 `path.join(os.homedir(), ".omp", "natives")` 改为 `path.join(os.homedir(), ".stp", "natives")`（约 line 56）。同时将 `XDG_DATA_HOME` 下的 `omp` 子目录改为 `stp`。
  - Acceptance: natives loader 从 `.stp/natives` 加载 addon，不再引用 `.omp`。
  - Depends: none

- [ ] **Task: 移除 omp-extension-roots.ts 中的硬编码 .omp**
  - Files: `packages/coding-agent/src/discovery/omp-extension-roots.ts`
  - Change: line 85 的 `path.join(ctx.cwd, ".omp")` 改为使用 `CONFIG_DIR_NAME`（即 `.stp`），去掉硬编码。引入 `CONFIG_DIR_NAME` from `@oh-my-pi/pi-utils`。
  - Acceptance: 项目级 config 路径不再硬编码 `.omp`。`bun check` 通过。
  - Depends: none

## Phase 2: 数据层自动迁移（~/.omp → ~/.stp）
**Contract:** 启动时若 `~/.stp` 不存在或为空且有 `~/.omp` 数据，自动迁移。

- [ ] **Task: 在 dirs.ts 中实现 auto-migrate 逻辑**
  - Files: `packages/utils/src/dirs.ts`
  - Change: 在 `getBaseConfigRoot()` 调用后（或首次路径解析时），增加一个 `migrateOmpToStp()` 函数：(1) 检查 `~/.omp` 是否存在且 `~/.stp` 不存在/为空；(2) 若需要迁移，尝试 symlink `~/.omp` → `~/.stp`（首选）；若 symlink 失败则 copy（fallback）；(3) 若 `PI_CONFIG_DIR` 已设置则跳过迁移；(4) 迁移成功后写一个 `~/.stp/.migrated-from-omp` 标记文件；(5) 所有 I/O 错误不崩溃，仅 logger.warn。
  - Acceptance: 新安装中 `~/.stp` 自动指向 `~/.omp` 数据。已有 `~/.stp` 的用户不受影响。
  - Depends: none

- [ ] **Task: 兼容性：agent/ 子目录读取时 fallback 到 .omp**
  - Files: `packages/utils/src/dirs.ts`
  - Change: `DirResolver` 的 `agentSubdir` 和 `rootSubdir` 在 `~/.stp/<subdir>` 不存在时，fallback 检查 `~/.omp/<subdir>` 是否存在（仅当 `.stp` 与 `.omp` 非同一路径时）。这覆盖了 agent.db、models.db、sessions/、blobs/、rules/ 等所有子目录。不阻塞启动——fallback 失败时静默返回 `.stp` 路径。
  - Acceptance: 迁移前的 agent 数据持续可访问。无需手动 `PI_CONFIG_DIR=.omp`。
  - Depends: none

## Phase 3: 清理残留引用（scripts、tests、docs）
**Contract:** 项目代码中不再有误导性的 `.omp` 硬编码。

- [ ] **Task: 更新 scripts/ 中的 .omp 硬编码**
  - Files: `scripts/session-stats/audit.ts`, `scripts/session-stats/analyze.py`, `scripts/install.ps1`
  - Change: `audit.ts:47,49` — `~/.omp/agent/sessions` → 使用 `getAgentDir()` 或 `~/.stp/agent/sessions`；`analyze.py:25` — `Path.home() / ".omp" / "stats.db"` → `.stp`；`install.ps1:105` — `.omp` → `.stp`。
  - Acceptance: 所有 scripts/ 中的 `.omp` 硬编码替换为 `.stp` 或动态解析。
  - Depends: Phase 1 全部完成

- [ ] **Task: 更新 tests 中的 .omp 引用**
  - Files: `packages/coding-agent/test/markit-converters.test.ts`, `packages/ai/test/helpers/index.ts`, `crates/pi-natives/src/fd.rs`
  - Change: 测试中的 `PI_CONFIG_DIR=".omp"` 改为 `".stp"`，`~/.omp/auth-gateway.token` 改为 `~/.stp/auth-gateway.token`，`.omp/skills/opt/scripts` → `.stp/skills/opt/scripts`。
  - Acceptance: `bun test` 相关测试通过。
  - Depends: Phase 1 全部完成

- [ ] **Task: 更新 Dockerfile 和 infra 中的 .omp 引用**
  - Files: `Dockerfile.robomp`, `infra/`（如有）
  - Change: `Dockerfile.robomp:66-67` 的 `.omp/agent` → `.stp/agent`。
  - Acceptance: Docker 构建中路径指向 `.stp`。
  - Depends: Phase 1 全部完成

## Phase 4: 验证
**Contract:** 全链路验证迁移无数据丢失。

- [ ] **Task: 端到端迁移验证**
  - Files: `packages/utils/src/dirs.ts`, `packages/utils/test/`
  - Change: 编写测试：(1) 创建 temp `~/.omp` 含 agent.db + sessions，启动 → `~/.stp` 为 symlink 到 `~/.omp`；(2) `PI_CONFIG_DIR=.omp` 时迁移跳过；(3) 已有 `~/.stp` 时不触发迁移。运行全量 `bun test packages/utils/test/`。
  - Acceptance: 迁移逻辑的 3 个场景通过测试。`bun check` 零新错误。
  - Depends: Phase 2 全部完成
