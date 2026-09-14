# 电力现货市场出清仿真平台

日前市场 · 96 时段 · 三节点网络 · 统一边际电价 + 直流潮流 LMP（PTDF + 再调度）。

> **分工说明**：本人负责 UI 部分，即 `js/app.js`（界面结构、交互逻辑、图表封装）
> 以及 `index.html` 中的整体样式。本文档重点讲解 `js/app.js` 的代码结构，
> 同时给出整站架构、运行方式和测试说明，便于组内交接与答辩讲解。

## 一、项目整体结构

项目采用“界面 / 算法 / 数据”三层分离的写法，层与层之间只通过普通函数和对象通信：

```text
index.html          页面外壳：全局样式 + 按顺序加载脚本 + 挂载点 <div id="app">
├── js/app.js       ★ 界面与交互层（本人负责）：Vue 组件 + ECharts 封装 + 页面模板
├── js/engine.js    算法层：无约束出清、二次曲线离散、PTDF 直流潮流、LMP 再调度
├── js/store.js     数据层：默认场景、96 时段报价生成、localStorage 持久化、JSON/CSV 导出
├── vendor/         本地化的 Vue 3 与 ECharts 5（不联网也能运行）
├── tests/          engine.test.js（算法单测）+ mount.test.js（整站挂载测试）
├── server.js       零依赖本地静态服务器（npm start）
└── package.json    脚本（start / test）与测试依赖（jsdom）
```

三层的职责边界：

| 层 | 文件 | 做什么 | 不做什么 |
|---|---|---|---|
| 界面层 | `js/app.js` | 展示数据、响应用户操作、封装图表 | 不实现任何出清/潮流算法 |
| 算法层 | `js/engine.js` | 纯函数计算，输入报价+网络，输出结果 | 不碰 DOM、不读全局状态 |
| 数据层 | `js/store.js` | 造数据、存数据、导入导出文件 | 不参与计算与渲染 |

`js/app.js` 通过两个全局对象调用另外两层：

```js
const E = window.MarketEngine;   // 算法层入口
const S = window.MarketStore;    // 数据层入口
```

## 二、快速开始

### 运行网页

方式一（推荐）：启动本地服务器

```bash
npm start
```

然后浏览器打开 http://localhost:8080

方式二：直接双击 `index.html`（Vue/ECharts 已本地化，一般也能正常使用）。端口被占用时可用 `PORT=8090 node server.js`。

### 运行测试

首次先安装依赖（仅测试需要 jsdom，网页本身不依赖 npm）：

```bash
npm install
```

然后：

```bash
npm test              # 引擎测试 + 整站挂载测试
npm run test:engine   # 只跑出清/PTDF 算法测试
npm run test:mount    # 只跑页面挂载冒烟测试
```

## 三、`js/app.js` 代码结构（重点）

### 3.1 先建立直觉：Vue 组件 ≈ C++ 类

本文件用 Vue 3 的“组件”描述界面，一个组件对象就相当于一个 C++ 类：

| 本文件写法 | C++ 概念 | 说明 |
|---|---|---|
| 组件对象（`App`、`OverviewPage`…） | 类 | 一个页面 / 一块界面就是一个组件 |
| `setup()` | 构造函数 | 初始化成员，并返回给模板使用的数据与函数 |
| `data() / computed / methods` | 成员变量 / 缓存 getter / 成员函数 | Options API 写法，与 `setup()` 可以混用 |
| `template` 字符串 | 界面布局声明 | 类似 Qt 的 `.ui` 文件，但直接写在代码里 |
| `ref / reactive` | 带通知的成员变量 | 值一改，Vue 自动重画用到它的界面 |
| `computed` | memoization 的 getter | 依赖不变就返回缓存结果，不重复计算 |
| `watch(数据, 回调)` | 信号槽 | 数据变化时自动执行回调 |
| `provide / inject` | 传全局句柄 | 根组件把共享上下文发给所有子页面，避免层层传参 |
| `onMounted / onBeforeUnmount` | 构造后 / 析构前钩子 | 用于初始化图表、清理定时器与事件监听 |

### 3.2 文件内部段落一览

行号为当前版本，改动代码后行号会变化，可按注释标题定位。

| 行号 | 段落 | 作用 |
|---|---|---|
| 1–40 | 文件头 + 依赖引入 | 文件说明、C++ 阅读地图、引入 Vue API 与 `E`/`S` 两个库 |
| 42–52 | 格式化函数 | `nf / n0 / n1 / money / pct`，全站数字统一格式 |
| 54–64 | 调色板 | `C` 颜色常量、`nodeColor()` 节点配色 |
| 66–108 | 图表封装 | `useChart()`（核心复用件）+ 公共坐标轴/提示框样式 |
| 110–115 | 共享上下文 | `CTX`（Symbol 钥匙）+ `provide / inject` 机制说明 |
| 119–360 | 根组件 `App` | 全局状态、出清流程、自动保存、侧边栏/顶栏/内容区模板 |
| 362 | `useCtx()` | 子组件取回共享上下文的一行封装 |
| 367–611 | `OverviewPage` | 市场总览页 |
| 615–920 | `BidPage` | 报价申报页 |
| 924–1138 | `CurvePage` | 供需曲线页 |
| 1142–1342 | `PricePage` | 电价与阻塞页 |
| 1346–1538 | `SettlePage` | 结算校验页 |
| 1544–1658 | `NetworkPage` | 网络参数页 |
| 1662–1795 | `DataPage` | 数据管理页 |
| 1797–1813 | 挂载 | `createApp(App).component(...).mount('#app')` 启动整个应用 |

### 3.3 三个基础复用件

**① 格式化函数（`js/app.js:46`）**

`nf(v, d)` 把数字格式化为固定小数位，遇到 `null / undefined / NaN` 统一显示 `—`；`n0 / n1` 是小数位 0 和 1 的快捷版；`money()` 负责千分位；`pct()` 负责百分比。所有模板中的 `{{ ... }}` 都经过它们，保证全站显示风格一致。

**② `useChart()` 图表封装（`js/app.js:74`）**

这是 UI 部分最值得讲的设计：把 ECharts 的创建、刷新、销毁全部封装成一个可复用函数。

```js
function useChart(optGetter) {
  const el = ref(null);        // 绑定模板里 <div ref="xxxChartEl"> 的 DOM
  let chart = null;            // ECharts 实例（第一次渲染时才创建）
  const render = () => { ... }; // 调用 optGetter() 拿到配置并 chart.setOption()
  ...
  watch(optGetter, () => nextTick(render), { flush: 'post' }); // 数据变→自动重画
  return { el, render };
}
```

它的用法固定为三步（以总览页电价曲线为例）：

1. 调用 `useChart(() => ({ ...ECharts 配置 }))`，回调里只负责“根据数据生成配置对象”；
2. 把返回的 `el` 暴露给模板（`return { priceChartEl: priceChart.el }`）；
3. 模板里放一个 `<div class="chart" ref="priceChartEl"></div>` 作为容器。

数据（`results / summary / period` 等）一旦变化，`watch` 会自动重新执行回调并重画，无需手动刷新。组件销毁时 `chart.dispose()` 释放资源，等同于 RAII。

**③ 共享上下文 `CTX`（`js/app.js:114`）**

根组件 `App` 在 `setup()` 末尾执行 `provide(CTX, ctx)`，把“状态 + 公共函数”打包成的 `ctx` 对象发放给所有子页面；子页面通过 `useCtx()`（即 `inject(CTX)`）取回同一个对象。作用相当于把所有子控件需要的东西放进一个全局上下文指针，避免一级一级传参。

### 3.4 根组件 `App`（`js/app.js:119`）

**setup 中的状态（相当于成员变量）**

| 名称 | 创建方式 | 用途 |
|---|---|---|
| `state` | `reactive(...)` | 全站共享数据：网络、市场主体、96 时段报价、选项 |
| `results` | `shallowRef([])` | 96 个时段的出清结果（整体替换，无需深度监听） |
| `period` | `ref(78)` | 当前查看的时段（默认 19:30 晚高峰） |
| `page` | `ref('overview')` | 当前页面标识，决定内容区显示哪个子组件 |
| `running` | `ref(false)` | 是否正在出清，用于禁用按钮、切换文案 |
| `dirty` | `ref(true)` | “数据已修改、尚未重新出清”标记 |
| `toast` | `ref('')` | 右下角临时提示文字 |

**关键函数**


| 函数 | 位置 | 职责 |
|---|---|---|
| `snapshot()` | `js/app.js:140` | 把响应式 `state` 深拷贝成普通对象，交给算法层使用 |
| `run()` | `js/app.js:160` | 循环 96 个时段调用 `E.runPeriod(...)`，汇总为 `results` |
| `current`（computed） | `js/app.js:187` | 当前时段结果的快捷取值 |
| `summary`（computed） | `js/app.js:189` | 全日汇总：电价区间、峰谷、累计中标、收支、阻塞盈余等 |
| `scheduleSave()` + `watch(state)` | `js/app.js:240` | 任意数据修改后 600ms 防抖写入 localStorage，并置 `dirty` |
| `flash(msg)` | `js/app.js:247` | 弹出提示条，2.6 秒后自动消失 |
| `onMounted(() => run())` | `js/app.js:254` | 页面加载后自动出清一次，保证首屏有数据 |

**模板（`js/app.js:267` 起）分为四块**

1. 左侧栏 `.sidebar`：品牌信息 + `v-for` 生成的 7 项导航 + 底部节点/主体数量；
2. 顶栏 `.topbar`：时段切换（`‹ ›` 按钮与滑块）、阻塞开关、状态标签、出清按钮；
3. 内容区 `.content`：用 `v-if / v-else-if` 链按 `page` 切换 7 个页面组件；
4. 提示条：`v-if="toast"` 控制的右下角浮层。

### 3.5 七个页面组件

每个页面组件都是同一套结构：`setup()` 准备数据与图表 → `template` 描述界面 → 需要时用 `computed / methods` 补充。

| 组件（行号） | 页面 | 展示内容 | 主要交互 |
|---|---|---|---|
| `OverviewPage`（367） | 市场总览 | 4 张 KPI 卡、96 时段电价曲线（标注峰/谷与当前时段）、全日中标结构条形图、节点电价区间表、算法说明折叠面板 | 峰谷标记、算法说明展开/收起 |
| `BidPage`（615） | 报价申报 | 市场主体列表、阶梯报价段表、二次曲线参数与曲线预览、本时段全部申报结果 | 选择主体、切换阶梯/二次曲线、增删报价段、复制到全部 96 时段 / 高峰时段、恢复默认 |
| `CurvePage`（924） | 供需曲线 | 供需阶梯曲线与出清点、节点电价分解表、发/用电中标明细、线路潮流表 | 随顶栏时段切换联动 |
| `PricePage`（1142） | 电价与阻塞 | 96 格电价热力条、LMP 走势对比 SMP、LMP 构成堆叠图、线路潮流图、PTDF 灵敏度矩阵 | 点击热力条跳转时段 |
| `SettlePage`（1346） | 结算校验 | 收支 KPI、一致性校验清单（电量守恒、资金守恒、阻塞盈余非负、中标不超申报等）、各主体结算汇总、资金流向说明 | 出清后自动校验并显示通过项数 |
| `NetworkPage`（1544） | 网络参数 | 网络约束开关、平衡节点选择、节点表、线路表（名称/送受端/电抗/容量） | 勾选阻塞、切换平衡节点、新增/删除/编辑线路 |
| `DataPage`（1662） | 数据管理 | 方案存档、结果导出、恢复与清理、当前数据集信息 | 导出/导入方案 JSON、导出出清结果 CSV、导出中标明细 CSV、恢复默认、清空缓存 |

各页面的共性写法：

- 需要图表时调用 `useChart()`，把图表容器挂在模板的 `<div class="chart ..." ref="...">` 上；
- 只读数据来自共享上下文（`state / results / current / summary`），不自己存储副本；
- 修改数据时直接改 `state` 的字段（例如 `v-model="l.cap"`），自动触发脏标记、自动保存和重新渲染。

### 3.6 一次交互的完整数据流

以“把某条线路容量从 260 改成 100”为例：

1. 输入框 `v-model.number="l.cap"` 把新值写回响应式对象 `state.network.lines[i].cap`；
2. `watch(state, ..., { deep: true })` 感知到深层字段变化 → 置 `dirty = true`，并启动 600ms 防抖保存；
3. 顶栏出现“数据已修改”标签，用户点击“执行全日出清”；
4. `run()` 调用 `snapshot()` 把 `state` 深拷贝给算法层，循环 96 次 `E.runPeriod(parts, net, opts)`；
5. 结果数组赋给 `results`，`dirty` 复位；
6. `computed` 的 `current / summary` 因依赖 `results` 变化而自动重算；
7. 各页面与图表读取这些响应式数据，Vue 自动重画受影响的部分——全程没有手动刷新界面的代码。

### 3.7 模板语法速查（C++ 视角）

| 模板写法 | 含义 | 类比 |
|---|---|---|
| `{{ 表达式 }}` | 插入文本/数值 | 等价于 `label->setText(fmt(...))`，但会自动更新 |
| `v-model="x"` | 双向绑定表单值 | 控件与成员变量互相同步，省掉读写回调 |
| `@click="fn"` | 绑定点击事件 | `connect(button, clicked, ...)` |
| `v-for="p in list" :key="p.id"` | 循环生成一批元素 | `for (auto& p : list) addWidget(...)`，`:key` 用于高效复用 |
| `v-if / v-else-if / v-else` | 条件渲染 | 条件创建/销毁控件（本例用于页面切换与状态标签） |
| `:class="{...}"` / `:style="{...}"` | 动态类名/样式 | 按状态改控件属性 |
| `ref="xxxEl"` | 模板元素的引用 | 拿到该 DOM 节点的“句柄”，供图表初始化使用 |

### 3.8 如何新增一个页面

1. 在 `js/app.js` 中仿照现有页面定义组件，例如 `const StatsPage = { setup() { ... }, template: '...' }`；
2. 在根组件 `App` 的 `data()` 里给 `nav` 数组增加一项 `{ k: 'stats', t: '统计分析' }`；
3. 在根组件模板的内容区增加 `<stats-page v-else-if="page==='stats'"></stats-page>`；
4. 在文件末尾挂载处注册：`.component('stats-page', StatsPage)`；
5. 若页面含图表：`const c = useChart(() => ({ ...配置 }))`，在 `setup()` 返回值里暴露 `c.el`，模板中用 `<div class="chart" ref="..."></div>` 承接；
6. 运行 `npm run test:mount` 验证 7 个页面仍全部通过（导航项数量断言需同步更新为 8）。

## 四、测试说明

| 测试文件 | 类型 | 覆盖内容 |
|---|---|---|
| `tests/engine.test.js` | 算法单元测试 | 无约束出清（470 MW / 260 元手工核算用例）、PTDF 矩阵、阻塞再调度与 LMP 分解、线路容量放宽对照组、二次曲线报价、报价合法性校验，共 30 项断言 |
| `tests/mount.test.js` | 界面挂载测试 | 用 jsdom 模拟浏览器真实挂载整个应用，依次点击 7 个导航页并断言标志性文案、结算页校验清单已渲染、网络页节点能力取自真实报价，最后检查运行期错误为 0 |

两项测试的期望结果：算法测试 `30 通过 / 0 失败`，挂载测试 `ALL PAGES OK` 且“运行期错误: 0”。

## 五、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开页面空白 | 脚本路径与目录结构不一致 | 确认 `js/`、`vendor/` 目录存在且 `index.html` 引用路径正确 |
| 图表区域空白 | 尚未出清，或 ECharts 未加载 | 先点“执行全日出清”；检查浏览器控制台是否有 `echarts is not defined` |
| 改了报价但数字没变 | 结果不会自动重算 | 点击右上角“执行全日出清”（顶栏会提示“数据已修改”） |
| 刷新后数据恢复默认 | localStorage 被禁用或被清空 | 使用“数据管理 → 导出方案 JSON”备份，需要时再导入 |
| `npm start` 报端口占用 | 8080 已被其他程序使用 | `PORT=8090 node server.js` 换端口启动 |
| 想验证算法是否被改坏 | — | 运行 `npm run test:engine` |
