# 智能拜访行程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在森特智行 AI 销售作战台中增加可持久化的智能拜访行程，使用高德提供真实地点、距离和路线，使用 DeepSeek 在严格校验下优化拜访顺序并生成行程说明。

**Architecture:** 后端固定调用高德 Web 服务 API，先解析地点并获取驾车距离矩阵，再由确定性优化器产生安全基线顺序；DeepSeek 可基于相同结构化数据返回合法的停靠点排列和说明，异常时自动回退。规划结果作为快照写入 SQLite，历史读取不再次调用外部服务；前端通过高德 Web JS API 渲染保存的折线和停靠点。

**Tech Stack:** Node.js 24、`node:http`、SQLite migrations、DeepSeek JSON Chat Completion、AMap Web Service API、AMap JS API 2.0、React 19、Vite 6、Lucide React、Node test runner、Chrome CDP QA。

---

## 文件边界

- `backend/src/maps/amapClient.js`：唯一允许持有和发送高德 Web 服务 Key 的模块。
- `backend/src/itinerary/optimizer.js`：纯函数路线排序、时间窗和优先级评分。
- `backend/src/itinerary/planner.js`：编排地理编码、距离矩阵、DeepSeek 排序和最终路线。
- `backend/src/itinerary/repository.js`：行程快照读写、版本和软删除。
- `backend/src/db/migrations/0005_visit_itineraries.mjs`：行程数据表和约束。
- `backend/src/modelAnalysis.js`：新增受校验的行程排序和说明模型调用。
- `backend/src/server.js`：仅增加认证 API 路由和审计编排。
- `outputs/product-design-prototype/src/features/visitItinerary/`：表单、只读详情、地图和展示模型。
- `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`：行程 CRUD 客户端。
- `outputs/product-design-prototype/src/App.jsx`：最小导航和状态接线。

### Task 1: 高德配置与客户端

**Files:**
- Create: `backend/src/maps/amapClient.js`
- Create: `backend/tests/amap-client.test.js`
- Modify: `backend/src/config.js`
- Modify: `backend/.env.example`
- Modify: `backend/tests/config.test.js`

- [ ] **Step 1: 写高德客户端失败测试**

覆盖地理编码、距离矩阵、驾车路线、无结果、平台错误、超时和错误信息不泄露 Key：

```js
it("returns normalized geocoding without exposing provider credentials", async () => {
  const client = createAmapClient({
    apiKey: "fixture",
    fetchImpl: async () => jsonResponse({
      status: "1",
      geocodes: [{ formatted_address: "山东省青岛市黄岛区秀兰禧悦山", location: "120.149201,35.987754" }],
    }),
  });
  const result = await client.geocode({ address: "秀兰禧悦山", city: "青岛" });
  assert.deepEqual(result.location, { lng: 120.149201, lat: 35.987754 });
  assert.equal(JSON.stringify(result).includes("fixture"), false);
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `node --test backend/tests/amap-client.test.js`

- [ ] **Step 3: 实现固定域名客户端**

客户端只允许访问 `https://restapi.amap.com`，用 `URLSearchParams` 注入 Key，统一把供应商异常转换成无秘密值的错误；地点上限为 9 个，距离矩阵按目的地批量请求，路线返回米、秒、费用、红绿灯和折线坐标。

- [ ] **Step 4: 增加配置测试和配置项**

```env
AMAP_WEB_SERVICE_KEY=your-amap-web-service-key
AMAP_TIMEOUT_MS=10000
```

生产和测试响应不得返回 Key。

- [ ] **Step 5: 运行客户端与配置测试**

Run: `node --test backend/tests/amap-client.test.js backend/tests/config.test.js`

### Task 2: 确定性排序与 DeepSeek 增强

**Files:**
- Create: `backend/src/itinerary/optimizer.js`
- Create: `backend/src/itinerary/planner.js`
- Create: `backend/tests/itinerary-optimizer.test.js`
- Create: `backend/tests/itinerary-planner.test.js`
- Modify: `backend/src/modelAnalysis.js`
- Modify: `backend/tests/model-analysis.test.js`

- [ ] **Step 1: 写排序失败测试**

```js
it("honors fixed appointment windows before minimizing drive time", () => {
  const plan = optimizeVisitOrder({
    departureAt: "2026-07-28T00:00:00.000Z",
    stops: [
      { id: "normal", priority: "normal", visitMinutes: 60 },
      { id: "appointed", priority: "high", visitMinutes: 45, appointmentAt: "2026-07-28T01:00:00.000Z" },
    ],
    durationMatrix: [[0, 1800, 1200], [1800, 0, 2400], [1200, 2400, 0]],
  });
  assert.deepEqual(plan.orderedStopIds, ["appointed", "normal"]);
});
```

还要覆盖稳定排序、等待时间、迟到惩罚、1 至 8 个停靠点和非法矩阵。

- [ ] **Step 2: 验证排序测试失败**

Run: `node --test backend/tests/itinerary-optimizer.test.js`

- [ ] **Step 3: 实现纯函数优化器**

枚举最多 8 个停靠点的排列，评分由驾车时长、迟到分钟、优先级位置和等待时间组成；相同分数使用原输入顺序稳定决胜。

- [ ] **Step 4: 写 DeepSeek 排序失败测试**

模型仅可返回所有停靠点 ID 的完整排列：

```json
{
  "orderedStopIds": ["customer-a", "customer-b"],
  "summary": "先处理有明确预约的重点客户，再沿返程方向拜访第二位客户。",
  "advice": ["出发前确认停车入口"]
}
```

缺失、重复或未知 ID 必须回退到确定性顺序。

- [ ] **Step 5: 实现规划编排**

顺序为：逐个地理编码 -> 距离矩阵 -> 确定性基线 -> DeepSeek 可选增强 -> 合法排列校验 -> 高德最终路线 -> 到达/离开时间 -> 输出快照。

- [ ] **Step 6: 运行规划测试**

Run: `node --test backend/tests/itinerary-optimizer.test.js backend/tests/itinerary-planner.test.js backend/tests/model-analysis.test.js`

### Task 3: SQLite 行程快照与仓储

**Files:**
- Create: `backend/src/db/migrations/0005_visit_itineraries.mjs`
- Create: `backend/src/itinerary/repository.js`
- Create: `backend/tests/itinerary-migrations.test.js`
- Create: `backend/tests/itinerary-repository.test.js`
- Modify: `backend/tests/db-maintenance.test.js`

- [ ] **Step 1: 写迁移失败测试**

表必须包含 `id`、`version`、`title`、`visit_date`、`status`、`request_json`、`plan_json`、创建人、时间戳和软删除字段；状态只允许 `planned/completed/cancelled`。

- [ ] **Step 2: 运行迁移测试并确认失败**

Run: `node --test backend/tests/itinerary-migrations.test.js`

- [ ] **Step 3: 实现迁移和仓储**

规划结果保存为不可变 JSON 快照；PATCH 重新规划时覆盖快照并增加版本；列表不返回已删除记录；读取历史不触发任何外部调用。

- [ ] **Step 4: 写并运行仓储测试**

Run: `node --test backend/tests/itinerary-repository.test.js backend/tests/migrations.test.js backend/tests/db-maintenance.test.js`

### Task 4: 认证 API、校验、审计和并发

**Files:**
- Create: `backend/tests/itinerary-api.test.js`
- Modify: `backend/src/validation/requests.js`
- Modify: `backend/src/server.js`
- Modify: `backend/tests/auth-http.test.js`

- [ ] **Step 1: 写 API 失败测试**

覆盖：

- `GET /api/itineraries`
- `GET /api/itineraries/:id`
- `POST /api/itineraries`
- `PATCH /api/itineraries/:id`
- `DELETE /api/itineraries/:id`

所有写入要求 Cookie、CSRF；PATCH/DELETE 要求 `If-Match`；1 至 8 个停靠点；地址、时间、优先级、停留分钟和嵌套未知字段严格校验。

- [ ] **Step 2: 运行 API 测试并确认 404/缺少实现失败**

Run: `node --test backend/tests/itinerary-api.test.js`

- [ ] **Step 3: 实现 API**

外部规划成功后再进入 SQLite 事务；数据库或审计失败不得留下行程；PATCH 只在显式修改时重新调用高德/DeepSeek；GET 历史必须为零外部调用。

- [ ] **Step 4: 运行完整后端测试**

Run: `npm --prefix backend test`

### Task 5: 前端 API 契约与表单模型

**Files:**
- Create: `outputs/product-design-prototype/src/features/visitItinerary/visitItineraryModel.js`
- Create: `outputs/product-design-prototype/src/features/visitItinerary/visitItineraryModel.test.js`
- Modify: `shared/salesWorkbenchApiContract.mjs`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`

- [ ] **Step 1: 写失败测试**

验证新建表单始终空白、客户选择只填充当前停靠点、日期时间转换包含时区、最多 8 个停靠点、历史快照映射和每段高德导航链接。

- [ ] **Step 2: 运行并确认失败**

Run: `node --test outputs/product-design-prototype/src/features/visitItinerary/visitItineraryModel.test.js outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`

- [ ] **Step 3: 实现契约和 CRUD 客户端**

API 客户端只接受完整的 `visitItinerary` 契约，并通过 `If-Match` 修改/删除；网络错误保留现有会话失效语义。

- [ ] **Step 4: 运行前端模型与 API 测试**

Run: `npm --prefix outputs/product-design-prototype run test:itinerary && npm --prefix outputs/product-design-prototype run test:api`

### Task 6: Apple 风格行程界面与高德地图

**Files:**
- Create: `outputs/product-design-prototype/src/features/visitItinerary/VisitItineraryPage.jsx`
- Create: `outputs/product-design-prototype/src/features/visitItinerary/AmapRouteMap.jsx`
- Create: `outputs/product-design-prototype/src/features/visitItinerary/amapLoader.js`
- Modify: `outputs/product-design-prototype/src/styles/global.css`
- Modify: `outputs/product-design-prototype/scripts/form-accessibility.test.mjs`
- Modify: `outputs/product-design-prototype/scripts/interactive-controls.test.mjs`

- [ ] **Step 1: 写静态与交互失败测试**

要求列表 -> 只读详情 -> 显式修改/删除，新建默认空白；地图配置缺失时显示明确可用的路线列表而不是空白；所有输入有 label，按钮有真实处理函数。

- [ ] **Step 2: 实现页面**

PC 使用 360px 规划栏 + 自适应地图/时间轴；移动端按表单、地图、结果顺序纵向排布。使用现有白色工作台、细边框、蓝色主操作和 Lucide 图标，不引入营销式卡片或装饰渐变。

- [ ] **Step 3: 实现地图生命周期**

`amapLoader.js` 只加载一次 JS API；地图创建、折线、编号 Marker、`setFitView` 和卸载清理完整；安全密钥只从未提交的 Vite 运行环境读取。

- [ ] **Step 4: 运行表单、交互和构建测试**

Run: `npm --prefix outputs/product-design-prototype run test:forms && npm --prefix outputs/product-design-prototype run test:controls && npm --prefix outputs/product-design-prototype run build`

### Task 7: 导航、路由和工作台联动

**Files:**
- Modify: `outputs/product-design-prototype/src/data/salesWorkbenchData.js`
- Modify: `outputs/product-design-prototype/src/app/routes.js`
- Modify: `outputs/product-design-prototype/src/app/routes.test.js`
- Modify: `outputs/product-design-prototype/src/app/workbenchState.js`
- Modify: `outputs/product-design-prototype/src/app/workbenchState.test.js`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/scripts/module-coverage.test.mjs`
- Modify: `outputs/product-design-prototype/scripts/visual-rhythm.test.mjs`

- [ ] **Step 1: 写导航与状态失败测试**

规范路径包括 `/itineraries`、`/itineraries/new`、`/itineraries/:id` 和 `/itineraries/:id/edit`；bootstrap 明确包含 `itineraries` 数组。

- [ ] **Step 2: 实现最小 App 接线**

新增 `MapPinned` 导航项、页面分支、集合更新和标题上下文；不把行程逻辑继续堆进 `App.jsx`。

- [ ] **Step 3: 运行路由、状态和模块测试**

Run: `npm --prefix outputs/product-design-prototype run test:routes && npm --prefix outputs/product-design-prototype run test:state && npm --prefix outputs/product-design-prototype run test:modules`

### Task 8: 真实 Key、浏览器和发布验证

**Files:**
- Modify: `docs/开发进度与路线图.md`
- Modify: `docs/需求与验收矩阵.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 本机私密配置**

`backend/.env` 保存 `AMAP_WEB_SERVICE_KEY`；前端 `.env.local` 保存 Web JS Key 与安全密钥。三个值均保持 Git 忽略并通过 `git check-ignore` 验证。

- [ ] **Step 2: 真实 API 验证**

使用“黄岛区秀兰禧悦山 -> 济宁市第二人民医院”验证地理编码、驾车里程、时长和费用，输出不得包含 Key。

- [ ] **Step 3: 完整自动化验证**

Run:

```bash
npm run scan:secrets
npm run test:release
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
```

- [ ] **Step 4: Chrome 视觉验收**

检查 `1440x900`、`1366x768`、`1024x768`、`390x844`、`360x800`；地图非空、折线可见、Marker 完整、表单无横向溢出、列表/详情/修改/删除可完成。

## 执行记录

- 后端、前端模型、API、静态交互和构建验证已完成。
- 高德 Web JS Geocoder、Web Service 逆地理、距离矩阵和驾车路线已用真实 Key 验证。
- 真实 Chrome 集成在无 WSL 的 Windows 环境使用原生 Node 运行，并覆盖历史读取、空白新建、真实创建、地图渲染和删除。
- 当前工作树中的真实 Key 仅存在于被忽略的 `backend/.env` 和前端 `.env.local`，示例文件只保留空占位符。

- [ ] **Step 5: 安全和提交检查**

Run: `git diff --check && git status --short && git grep -n -E 'AMAP_(WEB_SERVICE_KEY|SECURITY_CODE)=' -- ':!*.example'`

预期：无真实密钥被跟踪，只有 `.env.example` 占位值。
