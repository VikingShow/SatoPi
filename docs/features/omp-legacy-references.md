# omp → stp 重命名：向后兼容保留项

本文档记录所有**有意保留**的 `omp` 引用，这些引用涉及向后兼容、数据迁移或持久化数据的稳定性，强行改动会破坏已有用户数据。

## 分类说明

- **Config defaults**: 配置项的默认值，已持久化到用户配置文件中
- **Database/storage names**: SQLite 表名、Redis key 前缀、磁盘文件名
- **Extension discovery**: 插件/扩展的 manifest 字段名，需兼容旧版本
- **Env var names**: 环境变量名，用户脚本可能依赖
- **Code comparison**: 代码中与 `"omp"` 字符串的比较逻辑

---

## 完整列表

### 1. `packages/utils/src/dirs.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 34 | `PROFILE_ENV_KEYS = ["OMP_PROFILE", "PI_PROFILE"]` | Env var | 向后兼容旧环境变量 `OMP_PROFILE`，与新的 `STP_PROFILE` 共存 |
| 82-83 | `resolveProfileEnv(omp, pi)` | Code comparison | 参数名 `omp` 指代 legacy profile env var |

### 2. `packages/coding-agent/src/config/settings-schema.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 2824 | `"hindsight.retainContext": { type: "string", default: "omp" }` | Config defaults | 已持久化到用户 settings，修改 default 不影响现有用户但会改变新用户的初始值；且与现有 bank 数据关联 |

### 3. `packages/coding-agent/src/config/settings.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 1076 | `agentName !== "omp"` | Code comparison | 检查 agent 名称是否为默认的 "omp"，需要同时兼容 "stp" 和 "omp" |

### 4. `packages/coding-agent/src/hindsight/bank.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 29 | `const DEFAULT_BANK_NAME = "omp"` | Database/storage | 默认 bank 名称，已有用户数据存储在名为 "omp" 的 bank 中 |

### 5. `packages/coding-agent/src/hindsight/config.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 150 | `retainContext: settings.get("hindsight.retainContext") ?? "omp"` | Config defaults | hindsight 上下文保留配置的默认回退值 |

### 6. `packages/coding-agent/src/session/redis-session-storage.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 45 | `const DEFAULT_PREFIX = "omp:sessions:"` | Database/storage | Redis key 前缀，已有部署使用此前缀存储 session 数据 |

### 7. `packages/coding-agent/src/session/sql-session-storage.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 97 | `const DEFAULT_TABLE = "omp_session_files"` | Database/storage | SQL 表名，已有数据库使用此表名 |

### 8. `packages/coding-agent/src/discovery/helpers.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 584 | `package.json with "omp"/"pi" field` | Extension discovery | 插件发现机制：需兼容使用 `"omp"` manifest 字段的旧扩展 |

### 9. `packages/coding-agent/src/extensibility/extensions/loader.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 443 | `package.json with "omp"/"pi" field` | Extension discovery | 同上，扩展加载器需兼容旧 manifest 格式 |

### 10. `packages/coding-agent/src/cli/update-cli.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 563 | `path.basename(cacheDir).toLowerCase().includes("omp")` | Code comparison | Bun 全局缓存目录检测，检查路径是否包含 "omp" 以判断是否是旧安装 |

### 11. `packages/coding-agent/src/capability/types.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 34 | `"claude", "omp", "mcp-json", "agents-md"` | Code comparison | Provider ID 示例注释，仅文档用途 |

### 12. `packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 47 | `"omp:legacy-pi-shim"` | Extension discovery | 旧版 Pi 插件的虚拟模块命名空间 |
| 1427 | `"omp:legacy-pi-shim"` | Extension discovery | 同上 |

### 13. `packages/coding-agent/scripts/legacy-pi-virtual-module.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 7 | `VIRTUAL_NAMESPACE = "omp-legacy-pi-modules-build"` | Extension discovery | 旧版 Pi 模块的构建虚拟命名空间 |
| 183-184 | `name: "omp:legacy-pi-modules"` | Extension discovery | 同上 |

### 14. `packages/coding-agent/scripts/omp.ts` + `scripts/omp`

| 文件 | 内容 | 分类 | 说明 |
|---|---|---|---|
| `scripts/omp.ts` | `OMP_LAUNCH_CWD` 环境变量 | Env var | 开发启动器 shim，仅 `bun --preload` 使用 |
| `scripts/omp` | 开发启动器脚本 | Dev tool | 开发用的 CLI 启动脚本，文件名 `omp` 保留兼容 |

### 15. `packages/natives/native/embedded-addon.js`

| 内容 | 分类 | 说明 |
|---|---|---|
| Native addon 路径中包含 `omp` | Binary | 原生 Rust 扩展的嵌入路径，与 native build 系统耦合 |

### 16. `packages/coding-agent/src/eval/py/runner.py`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 194 | `contextvars.ContextVar("omp_current_rid")` | Database/storage | Python eval 运行时的 context var 名称 |
| 196 | `contextvars.ContextVar("omp_displayed_matplotlib_figure_ids")` | Database/storage | Python eval 运行时的 context var 名称 |

### 17. `packages/coding-agent/scripts/build-binary.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 14 | `"omp-legacy-pi-modules"` | Binary build | 旧版 Pi 模块引用，仅编译时使用 |

### 18. `packages/coding-agent/scripts/bundle-dist.ts`

| 行号 | 内容 | 分类 | 说明 |
|---|---|---|---|
| 67 | `dist/omp` 目录 | Build artifact | npm bundle 输出目录名 |

---

## 迁移计划

以上所有项应在以下条件满足后再统一迁移：

1. 所有用户已完成从 `omp` → `stp` 的二进制升级
2. 提供自动化的数据迁移脚本（SQLite 表重命名、Redis key 迁移、配置文件迁移）
3. 提供足够的过渡期（至少一个 major version），期间同时兼容新旧名称
4. 旧版 extension/plugin 的 `"omp"` manifest 字段支持需要保留至少 6 个月

---

*最后更新: 2026-07-27*
