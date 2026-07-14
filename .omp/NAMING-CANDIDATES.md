# Loop Engineering Agent 命名候选方案 — 中国上古神话体系

> 本文档仅用于评审，尚未确认。确认后替换 plan 中所有亚瑟王/希腊体系命名。

---

## 一、Before Loop — 苏格拉底式追问者

| 候选 | 角色 | 匹配理由 |
|------|------|---------|
| **仓颉** | 黄帝史官，造字之神 | 「仰观天象，俯察万物」，洞察本质、提炼归纳 |
| **岐伯** ⭐ | 黄帝医官，《内经》对话者 | 黄帝问、岐伯答，上古最有名的问答模式 |

**推荐：岐伯**

---

## 二、Cloner 主控（Merlin 替代）

| 候选 | 角色 | 匹配理由 |
|------|------|---------|
| **姜子牙** ⭐ | 周朝太师，兵家始祖 | 上古军师，调兵遣将，封神榜对应任务分配 |
| **伊尹** | 商朝名相，厨祖 | 「治大国若烹小鲜」，善将复杂事务分解 |
| **风后** | 黄帝宰相，指南车发明者 | 在迷雾中指出方向 |

**推荐：姜子牙**

---

## 三、12 Workers — 黄帝麾下群英

以黄帝战胜蚩尤的涿鹿之战为背景，黄帝麾下各具神通的战将/贤臣：

| # | 候选 | 角色 | 能力标签 | 对应原骑士 |
|---|------|------|---------|-----------|
| 1 | **应龙** | 创世神龙，黄帝战将 | architecture, coding, patterns | Lancelot |
| 2 | **力牧** | 黄帝大将，力能扛鼎 | testing, ci-cd, reliability | Gawain |
| 3 | **竖亥** | 丈量大地者（《山海经》） | exploration, research, scout | Percival |
| 4 | **常先** | 发明鼓和号角 | security, compliance, audit | Galahad |
| 5 | **共工** | 水神，善水道连接 | integration, api, interop | Tristan |
| 6 | **大挠** | 作甲子（干支纪年系统） | database, infrastructure, storage | Bors |
| 7 | **祝融** | 火神，掌控能量 | performance, profiling, optimization | Kay |
| 8 | **史皇** | 黄帝史官，最早记录者 | documentation, ux, accessibility | Bedivere |
| 9 | **玄女** | 九天玄女，授黄帝兵法 | refactoring, cleanup, technical-debt | Gareth |
| 10 | **羲和** | 日母，驾驭日车精准计时 | benchmarking, measurement, data-analysis | Palamedes |
| 11 | **蚩尤** | 战神，八十一兄弟并行作战 | concurrency, async, parallelism | Lamorak |
| 12 | **嫘祖** | 黄帝正妃，发明养蚕缫丝 | prototyping, experimentation, creativity | Dinadan |

---

## 四、审查核心席 — 三官大帝（Moirai 替代）

| 候选方案 | 成员 | 匹配 |
|---------|------|------|
| **方案A：三皇** | 伏羲、神农、女娲 | 伏羲=correctness, 神农=performance, 女娲=security |
| **方案B：三官大帝** ⭐ | 天官、地官、水官 | 天官赐福(通过)、地官赦罪(给机会)、水官解厄(否决) |

**推荐：方案B - 三官大帝**

| 神祇 | 审查视角 | 特殊权限 |
|------|---------|---------|
| **天官** | 正确性与逻辑（赐福 — 通过则放行） | 对应 Clotho |
| **地官** | 性能与可扩展性（赦罪 — 指出问题给改进机会） | 对应 Lachesis |
| **水官** | 安全与边界（解厄 — **持否决权**） | 对应 Atropos |

---

## 五、可选审查者池（6 席）

| # | 候选 | 来源 | 审查视角 | 对应 tag |
|---|------|------|---------|---------|
| 1 | **青鸟** | 西王母信使 | API 设计与协议 | api, rpc |
| 2 | **容成** | 黄帝历法大臣 | 算法正确性 | algorithm |
| 3 | **女娲** | 创世母神，造人补天 | 可访问性与用户体验 | ui, a11y |
| 4 | **有巢氏** | 教民筑巢，建筑之祖 | 架构一致性 | architecture, module |
| 5 | **文祖** | 黄帝文字之臣 | 文档与知识一致性 | docs, knowledge |
| 6 | **大禹** | 治水，大规模基建先驱 | 基础设施与 CI/CD | ci-cd, infra |

---

## 六、完整对照表

| 原神话体系 | 中国上古体系 |
|-----------|-------------|
| Socrates | **岐伯** |
| Merlin | **姜子牙** |
| Lancelot | **应龙** |
| Gawain | **力牧** |
| Percival | **竖亥** |
| Galahad | **常先** |
| Tristan | **共工** |
| Bors | **大挠** |
| Kay | **祝融** |
| Bedivere | **史皇** |
| Gareth | **玄女** |
| Palamedes | **羲和** |
| Lamorak | **蚩尤** |
| Dinadan | **嫘祖** |
| Clotho | **天官** |
| Lachesis | **地官** |
| Atropos | **水官** |
| Urania | **青鸟** |
| Thoth | **容成** |
| Brigid (女娲已用于方案A) | **（空缺）** |
| Minerva | **有巢氏** |
| Saraswati | **文祖** |
| Vulcan | **大禹** |

> ⚠️ Brigid 对应的 token 待定——女娲在审查核心席三皇方案中已使用，若最终选三官大帝方案，女娲可放回此位。

---

## 七、目录结构变更（确认后生效）

```
.omp/agents/
├── before-loop/
│   └── qibo.md              （岐伯）
├── cloner/
│   └── jiang-ziya.md        （姜子牙）
├── warriors/                 （黄帝麾下 12 将，原 knights/）
│   ├── yinglong.md           （应龙）
│   ├── limu.md               （力牧）
│   ├── shuhai.md             （竖亥）
│   ├── changxian.md          （常先）
│   ├── gonggong.md           （共工）
│   ├── dalao.md              （大挠）
│   ├── zhurong.md            （祝融）
│   ├── shihuang.md           （史皇）
│   ├── xuannv.md             （玄女）
│   ├── xihe.md               （羲和）
│   ├── chiyou.md             （蚩尤）
│   └── leizu.md              （嫘祖）
└── reviewers/
    ├── core/                  （三官大帝，必选）
    │   ├── tianguan.md       （天官）
    │   ├── diguan.md         （地官）
    │   └── shuiguan.md       （水官）
    └── optional/              （神话审查者，按需激活）
        ├── qingniao.md        （青鸟）
        ├── rongcheng.md       （容成）
        ├── nuwa.md            （女娲）— 待确认
        ├── youchao.md         （有巢氏）
        ├── wenzu.md           （文祖）
        └── dayu.md            （大禹）
```
