# Stealth Cityline 实验使用说明

本说明用于“新会话、无上下文”场景。  
目标：任何 AI/工程师只靠本文即可正确运行、维护和扩展本实验。

## 1. 实验目标

验证 `chromium.use(stealth())` 在无头模式下的真实效果，并输出“配置项 -> 观测项 -> 生效与否 -> 固定/随机”的对比报告。

固定实验条件：

- 站点：`https://www.cityline.com/zh_CN/Events.html`
- 模式：`headless` 为主，末尾追加 1 次 `headful`
- 跑法：`no-stealth` 1 次 + `stealth` 2 次 + `stealth+headful` 1 次
- 每次重跑前必须清理旧结果

## 2. 目录结构（必须保持）

```text
playwright/experiments/stealth-cityline/
├── probe_once.js         # 单次探针：跑一次并输出一份 JSON
├── run_experiment.js     # 一键实验入口：清理、执行3次、生成报告
├── report.html           # 实验报告（HTML，配置项分组 + 合并单元格）
├── results/              # 实验结果目录（每次重跑会重建）
│   ├── manual-headful-merged.json  # 手工基准（只读，不自动删除/修改）
│   ├── no-stealth.json
│   ├── stealth-run-1.json
│   └── stealth-run-2.json
│   └── stealth-headful-run-1.json
└── USAGE.md              # 当前说明
```

## 3. 标准执行方式

在 `playwright/` 目录执行：

```bash
npm run exp:stealth-cityline
```

该命令会自动：

1. 删除自动生成的旧结果（不会删除 `manual-headful-merged.json`）
2. 运行 4 次探针并写入 JSON
3. 生成 `report.html`

## 4. 报告格式约束（维护时必须遵守）

`report.html` 必须包含：

1. 实验设置（站点、模式、运行方式、清理策略）
2. 结果文件列表
3. 核心对比表（按大类拆成多个表格；每个子表配置项在最前，且包含 headful 对比列）
4. “是否随机”结论
5. 最终结论
6. 建议配置区块（分别针对 `stealth(run1)` 与 `headful-stealth(run1)` 输出可执行模板）

核心对比表必须满足：

- 第一列是“对应配置项”
- 按可读性拆分为多个类别子表（例如：Request Headers、Navigator Fingerprint、Browser Runtime APIs、Graphics & Media）
- 支持“一个配置项对应多个观测项”
- 同组行使用 `rowspan` 合并第一列
- 每行包含：
  - 观测项
  - no-stealth 值
  - stealth(run1) 值
  - headful-stealth(run1) 值
  - 配置值（观测）
  - 生效判断（基于 no-stealth vs stealth-run1）
  - 固定/随机（基于 stealth-run1 vs stealth-run2）
  - headful差异（基于 headless-stealth(run1) vs headful-stealth(run1)）
  - manual基准（手工文件）
  - manual差异（仅 requestHeaders，基于 headful-stealth(run1) vs manual）

高优先级漏洞监控项（不要删）：

- `result.language` 与 `result.languages`（一致性风险）
- `requestHeaders.sec-ch-ua*`（UA hints 一致性）
- `result.userAgent` / `requestHeaders.user-agent`（UA 一致性）
- `window outer/inner 尺寸`（窗口指纹）
- `requestHeaders` 全量字段（以 `manual-headful-merged.json` 为基准自动补齐）

## 5. 变更维护准则

允许改动：

- 新增观测项
- 调整样式
- 优化重试/稳定性逻辑
- 增加更多对比字段

不允许破坏：

- 固定站点（除非明确收到新需求）
- “1 次 no-stealth + 2 次 stealth + 1 次 stealth+headful”实验设计
- 每次先清理旧结果
- 报告的“配置匹配型”表达方式

新增观测项时必须同步改 3 处：

1. `probe_once.js` 的 `page.evaluate` 输出
2. `run_experiment.js` 里的 `checks` 映射（观测项 -> 配置项）
3. `report.html` 表格展示（由生成器自动处理分组与合并）

新增配置项/观测项的分组规则（必须遵守）：

1. 先判断是否能归入现有大类（`request_headers`、`navigator_fingerprint`、`browser_runtime`、`graphics_media`）。
2. 若语义匹配现有大类，直接放入该大类，不要新建大类。
3. 仅当所有现有大类都不适配时，才新增一个大类。
4. 新增大类时，必须同时更新：
   - `run_experiment.js` 的 `renderCategoryTables` 类别定义（标题与顺序）
   - `checks` 中对应项的 `category` 字段
   - 本说明文档中的“核心对比表必须满足”描述与验收清单

## 6. 常见故障与处理

1. `page.goto` 超时、跳到 `chrome-error://chromewebdata/`
   - 这是目标站点波动，优先在 `probe_once.js` 保留/增强重试逻辑
2. “interrupted by another navigation”
   - 若当前 URL 已是目标站点，可按成功处理
3. 报告里内容挤出单元格
   - 通过 `table-wrap` 横向滚动 + `pre-wrap` 换行处理，禁止裸溢出

## 7. 验收清单（每次改动后）

执行：

```bash
npm run exp:stealth-cityline
```

然后检查：

1. `results/` 里是否有 4 个新 JSON
2. `report.html` 是否生成成功
3. 表格是否按配置项分组并正确 `rowspan`
4. `plugins` / `mimeTypes` 是否包含长度和详细数组两类观测
5. “固定/随机”判断是否来自两次 stealth 的实际比较
6. 主表中是否包含 headful 对比列与 headful差异列
7. 报告中是否包含两份“建议配置代码”与“无法稳定自动对齐项”说明

---

如果要把本实验迁移到其它站点，请明确新增需求后再改，并在本文件“实验目标”和“固定实验条件”同步更新。
