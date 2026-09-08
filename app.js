/* =========================================================================
 * 电力现货市场出清仿真平台 —— 界面与交互
 * Vue 3（全局构建，含模板编译器）+ ECharts 5，全部本地化，断网可用。
 *
 * 文件结构：
 *   1. 工具与格式化函数（nf / n0 / n1 / money / pct / nodeColor / useChart）
 *   2. App 根组件 —— 状态容器、出清调度、派生量、持久化
 *   3. 7 个子页面 —— Overview / Bid / Curve / Price / Settle / Network / Data
 *   4. createApp().component(...).mount('#app') 入口挂载
 *
 * 关键约定：
 *   - 时段索引 period ∈ [0, 95]，对应 00:00 → 23:45，间隔 15 分钟
 *   - 报价数据按"主体 × 时段"二维存放在 state.participants[i].bids[j]
 *   - 出清结果一次性算完 96 个时段，存到 shallowRef(results.value)，再分页渲染
 * ========================================================================= */
(function () {
  'use strict';

  const { createApp, reactive, ref, shallowRef, computed, watch, provide, inject,
    onMounted, onBeforeUnmount, nextTick } = Vue;
  const E = window.MarketEngine;   // 出清算法内核
  const S = window.MarketStore;    // 数据模型 / 场景 / 持久化

  /* ------------------------------------------------------------ 格式化 */
  // 数值显示：null / undefined / NaN 统一渲染为破折号，避免表格里出现 "NaN"
  const nf = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toFixed(d === undefined ? 2 : d);
  const n0 = v => nf(v, 0);   // 整数显示（MW、节点数等）
  const n1 = v => nf(v, 1);   // 一位小数
  const money = v => (v === null || v === undefined || !isFinite(v)) ? '—'
    : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });  // 千分位 + 整数
  const pct = v => nf(v * 100, 1) + '%';   // 0~1 → "xx.x%"

  // 配色：节点色按节点下标循环，方便区分；发电蓝 / 用电橙 与出清红线为系统主色
  const C = {
    supply: '#2563eb', demand: '#d97706', clear: '#dc2626',
    energy: '#94a3b8', cong: '#dc2626',
    node: ['#2563eb', '#d97706', '#059669', '#7c3aed', '#0891b2'],
    gen: '#2563eb', con: '#d97706', grid: '#f1f5f9', axis: '#94a3b8',
  };
  // 给定节点 id 返回其固定配色（节点排序决定颜色，因此稳定）
  const nodeColor = (state, id) => {
    const i = (state.network.nodes || []).findIndex(n => n.id === id);
    return C.node[(i < 0 ? 0 : i) % C.node.length];
  };

  /* ------------------------------------------------------------ 图表封装 */
  // ECharts 响应式封装：传入"返回配置"的 getter，数据变化时自动 setOption
  function useChart(optGetter) {
    const el = ref(null);
    let chart = null;
    const render = () => {
      if (!el.value) return;
      let opt;
      try { opt = optGetter(); } catch (e) { return; }   // 数据尚未就绪时静默忽略
      if (!opt) return;
      if (!chart) chart = echarts.init(el.value);
      chart.setOption(opt, true);   // 第二参数 true 表示完整替换
    };
    const onR = () => { if (chart) chart.resize(); };
    onMounted(() => { nextTick(render); window.addEventListener('resize', onR); });
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onR);
      if (chart) { chart.dispose(); chart = null; }   // 必须 dispose，否则 ECharts 实例会泄漏
    });
    watch(optGetter, () => nextTick(render), { flush: 'post' });
    return { el, render };
  }

  // 图表通用边距与坐标轴样式（避免每个图表重复写）
  const baseGrid = { left: 56, right: 22, top: 34, bottom: 40 };
  const axisStyle = {
    axisLine: { lineStyle: { color: '#e2e8f0' } },
    axisTick: { show: false },
    axisLabel: { color: '#64748b', fontSize: 11 },
    splitLine: { lineStyle: { color: '#f1f5f9' } },
  };
  const tooltipStyle = {
    backgroundColor: '#0f172a', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
    padding: [8, 11],
  };

  // provide/inject 的 key：避免与第三方组件命名冲突，用 Symbol 隔离
  const CTX = Symbol('market-ctx');

  /* ==================================================================== */
  /*                              主应用                                   */
  /* ==================================================================== */
  // App 是全局状态容器：负责装载 localStorage、调度一次 run() 出清 96 时段，
  // 并把 state / results / period / summary 等通过 provide 暴露给各页面。
  const App = {
    setup() {
      let loaded = S.load();
      const state = reactive(loaded || S.createDefaultState());
      const results = shallowRef([]);     // shallowRef 即可：内部对象不需要深度响应
      const period = ref(78);             // 默认停在 19:30 时段，晚高峰电价最显眼
      const page = ref('overview');       // 当前页面 key
      const running = ref(false);         // 跑出清时禁用按钮
      const dirty = ref(true);            // 数据被改动后置 true，提示保存
      const lastRun = ref(null);          // 最近一次出清时间，用于角标显示
      const toast = ref('');              // 右下角轻提示

      /* -------- 出清 -------- */
      // 把 Vue 响应式 state 深拷贝为纯对象再传给计算内核，避免 Vue Proxy 进入引擎
      function snapshot() {
        const net = JSON.parse(JSON.stringify(state.network));
        const list = [];
        for (const p of state.participants) {
          if (p.enabled === false) continue;   // 停用主体不出现在快照里
          list.push({
            id: p.id, name: p.name, side: p.side, node: p.node,
            bidMode: p.bidMode, segments: p.segments, quad: p.quad,
            bids: p.bids,
          });
        }
        return { net, list };
      }

      // 一次性跑完 96 时段出清，结果按时段顺序写入 results
      function run() {
        running.value = true;
        const { net, list } = snapshot();
        const out = [];
        for (let i = 0; i < S.PERIODS; i++) {
          // 把"主体模板 + 第 i 时段申报"合并为引擎期望的 participants 格式
          const parts = list.map(p => {
            const b = p.bids[i] || {};
            return {
              id: p.id, name: p.name, side: p.side, node: p.node, enabled: true,
              bidMode: b.bidMode || p.bidMode || 'step',
              segments: b.segments || [],
              quad: b.quad || p.quad,
            };
          });
          out.push(E.runPeriod(parts, net, { quadSteps: state.options.quadSteps }));
        }
        results.value = out;
        running.value = false;
        dirty.value = false;
        lastRun.value = new Date();
        return out;
      }

      /* -------- 派生 -------- */
      // 当前选定时段的出清结果，供顶栏徽章和概览页共用
      const current = computed(() => results.value[period.value] || null);

      // 全日 96 时段的统计聚合：KPI、主体收支排行、阻塞时段数等
      const summary = computed(() => {
        const rs = results.value.filter(r => r && r.ok);
        if (!rs.length) return null;
        const nodes = state.network.nodes.map(n => n.id);
        const prices = rs.map(r => r.price);
        const qty = rs.map(r => r.qty);
        const congestedCount = rs.filter(r => r.congested).length;

        // 各节点全日 LMP 区间（用于"节点电价区间"表）
        const lmpRange = {};
        for (const id of nodes) {
          const vs = rs.map(r => r.lmp[id]).filter(v => v !== undefined);
          lmpRange[id] = { min: Math.min(...vs), max: Math.max(...vs), avg: vs.reduce((a, b) => a + b, 0) / vs.length };
        }
        // 全日累计：按主体聚合中标量与收支
        const genAgg = {}, conAgg = {};
        for (const r of rs) {
          for (const d of r.genDetail) {
            const a = genAgg[d.id] || (genAgg[d.id] = { id: d.id, name: d.name, node: d.node, mw: 0, amt: 0, bid: 0 });
            a.mw += d.awarded; a.amt += d.income; a.bid += d.bidQty;
          }
          for (const d of r.conDetail) {
            const a = conAgg[d.id] || (conAgg[d.id] = { id: d.id, name: d.name, node: d.node, mw: 0, amt: 0, bid: 0 });
            a.mw += d.awarded; a.amt += d.payment; a.bid += d.bidQty;
          }
        }
        // 全日总收支与阻塞盈余合计
        const genTotal = Object.values(genAgg).reduce((s, a) => s + a.amt, 0);
        const conTotal = Object.values(conAgg).reduce((s, a) => s + a.amt, 0);
        const rentTotal = rs.reduce((s, r) => s + r.rent, 0);
        const genMw = Object.values(genAgg).reduce((s, a) => s + a.mw, 0);
        const conMw = Object.values(conAgg).reduce((s, a) => s + a.mw, 0);
        const peak = prices.indexOf(Math.max(...prices));
        const valley = prices.indexOf(Math.min(...prices));

        return {
          count: rs.length, nodes, lmpRange, congestedCount,
          priceMin: Math.min(...prices), priceMax: Math.max(...prices),
          priceAvg: prices.reduce((a, b) => a + b, 0) / prices.length,
          qtyMin: Math.min(...qty), qtyMax: Math.max(...qty),
          qtyAvg: qty.reduce((a, b) => a + b, 0) / qty.length,
          genAgg: Object.values(genAgg), conAgg: Object.values(conAgg),
          genTotal, conTotal, rentTotal, genMw, conMw,
          peakIdx: peak, valleyIdx: valley,
          infeasible: rs.filter(r => r.infeasible).length,  // 无可行解的时段（再调度无法缓解越限）
          unmatched: rs.filter(r => !r.matched).length,      // 完全无成交的时段
        };
      });

      /* -------- 持久化 -------- */
      // 防抖保存：用户连续编辑时不会高频写 localStorage，停止 600ms 后再落盘
      let saveTimer = null;
      function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => S.save(JSON.parse(JSON.stringify(state))), 600);
      }
      watch(state, () => { dirty.value = true; scheduleSave(); }, { deep: true });

      // 2.6 秒自动消失的 toast 提示（同一提示连点会刷新计时器）
      function flash(msg) {
        toast.value = msg;
        clearTimeout(flash._t);
        flash._t = setTimeout(() => { toast.value = ''; }, 2600);
      }

      onMounted(() => { run(); });   // 首次进入页面立刻跑一次出清

      // 暴露给所有子页面的上下文（provide/inject）
      const ctx = {
        state, results, period, page, running, dirty, lastRun, toast,
        current, summary, nodeColor,
        run, flash, nf, n0, n1, money, pct,
      };
      provide(CTX, ctx);
      return ctx;
    },

    template: `
    <!-- 整体布局：左侧深色导航 + 右侧主区（顶栏 + 内容） -->
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-title">电力现货市场出清仿真</div>
          <div class="brand-sub">日前市场 · 96 时段 · 节点电价</div>
        </div>
        <nav class="nav">
          <div class="nav-group">分析</div>
          <!-- 7 个导航项由 setup().data().nav 配置驱动，page 切换 v-if 渲染对应页面 -->
          <div v-for="it in nav" :key="it.k" class="nav-item" :class="{active:page===it.k}" @click="page=it.k">
            <span class="nav-dot"></span><span>{{it.t}}</span>
          </div>
        </nav>
        <!-- 侧栏底部：当前场景规模摘要 -->
        <div class="side-foot">
          {{state.network.nodes.length}} 节点 / {{state.network.lines.length}} 线路<br>
          {{state.participants.length}} 个市场主体
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <!-- 时段切换：prev/next 按钮 + 滑块；+95 %96 与 +1 %96 实现环形跳转 -->
          <div class="period-box">
            <button class="btn btn-sm" @click="period=(period+95)%96">‹</button>
            <div>
              <div class="period-time">{{timeLabel}}</div>
              <div class="period-idx">第 {{period+1}} / 96 时段</div>
            </div>
            <input type="range" min="0" max="95" v-model.number="period">
            <button class="btn btn-sm" @click="period=(period+1)%96">›</button>
          </div>

          <!-- 网络阻塞开关：关掉则所有时段按统一边际价 SMP 出清（不做 PTDF） -->
          <label class="switch" title="关闭后全网执行统一边际电价，忽略线路容量约束">
            <input type="checkbox" v-model="state.network.enabled">
            考虑网络阻塞
          </label>

          <!-- 当前时段网络状态徽章 -->
          <span v-if="current && current.congested" class="pill pill-warn">该时段阻塞</span>
          <span v-else-if="current" class="pill pill-ok">该时段畅通</span>

          <div class="topbar-spacer"></div>

          <span v-if="dirty" class="pill pill-warn">数据已修改</span>
          <button class="btn btn-primary" :disabled="running" @click="run">
            {{running ? '出清中…' : '执行全日出清'}}
          </button>
        </header>

        <!-- 7 个子页面：page === 'xxx' 时渲染对应组件；其余 v-if 移除 -->
        <div class="content">
          <overview-page v-if="page==='overview'"></overview-page>
          <bid-page v-else-if="page==='bid'"></bid-page>
          <curve-page v-else-if="page==='curve'"></curve-page>
          <price-page v-else-if="page==='price'"></price-page>
          <settle-page v-else-if="page==='settle'"></settle-page>
          <network-page v-else-if="page==='network'"></network-page>
          <data-page v-else-if="page==='data'"></data-page>
        </div>
      </main>

      <!-- 右下角轻提示：2.6 秒自动消失 -->
      <div v-if="toast" style="position:fixed;right:22px;bottom:22px;background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99">{{toast}}</div>
    </div>`,

    data() {
      // 导航项配置：新增/删除页面时只需改这里与 createApp().component() 两处
      return {
        nav: [
          { k: 'overview', t: '市场总览' },
          { k: 'bid', t: '报价申报' },
          { k: 'curve', t: '供需曲线' },
          { k: 'price', t: '电价与阻塞' },
          { k: 'settle', t: '结算校验' },
          { k: 'network', t: '网络参数' },
          { k: 'data', t: '数据管理' },
        ],
      };
    },
    computed: {
      timeLabel() { return S.periodLabel(this.period); },
    },
  };

  // 各页面统一通过 inject(CTX) 获取根组件上下文
  const useCtx = () => inject(CTX);

  /* ==================================================================== */
  /*                            市场总览                                    */
  /* ==================================================================== */
  // 入口页：4 个 KPI（当前时段出清 / 当前时段 SMP / 全日区间 / 阻塞统计）+
  //        全日出清电价曲线（含峰谷标注）+
  //        全日中标电量结构（按主体分色堆叠）+
  //        节点电价区间表 +
  //        可展开的"算法说明"卡片。
  const OverviewPage = {
    setup() {
      const ctx = useCtx();
      const { state, results, period, current, summary } = ctx;

      const priceChart = useChart(() => {
        const rs = results.value;
        if (!rs.length) return null;
        const sm = summary.value;
        const labels = [], data = [];
        for (let i = 0; i < 96; i++) {
          labels.push(S.periodLabel(i));
          data.push(rs[i] && rs[i].ok ? +(rs[i].price).toFixed(2) : null);
        }
        return {
          grid: { ...baseGrid, right: 26, top: 40 },
          tooltip: {
            ...tooltipStyle, trigger: 'axis',
            formatter: p => {
              const i = p[0].dataIndex;
              const r = rs[i];
              if (!r || !r.ok) return S.periodLabel(i);
              let s = '<b>' + S.periodLabel(i) + '</b>（第 ' + (i + 1) + ' 时段）<br>'
                + '出清电量 ' + n0(r.qty) + ' MW<br>'
                + '系统边际电价 ' + n0(r.price) + ' 元/MWh<br>';
              s += r.congested ? '<span style="color:#fbbf24">线路阻塞</span>' : '无阻塞';
              return s;
            },
          },
          xAxis: {
            type: 'category', data: labels, boundaryGap: false, ...axisStyle,
            axisLabel: { ...axisStyle.axisLabel, interval: 7 },
          },
          yAxis: { type: 'value', name: '元/MWh', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          series: [{
            type: 'line', data, smooth: true, symbol: 'none',
            lineStyle: { width: 2, color: C.supply },
            areaStyle: {
              color: {
                type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [{ offset: 0, color: 'rgba(37,99,235,.22)' }, { offset: 1, color: 'rgba(37,99,235,0)' }],
              },
            },
            markLine: {
              silent: true, symbol: 'none',
              data: [{ xAxis: period.value, lineStyle: { color: '#dc2626', width: 1, type: 'dashed' } }],
              label: { show: false },
            },
            markPoint: sm ? {
              symbolSize: 42,
              data: [
                { coord: [sm.peakIdx, +sm.priceMax.toFixed(2)], value: '峰', itemStyle: { color: '#dc2626' }, label: { color: '#fff', fontSize: 10 } },
                { coord: [sm.valleyIdx, +sm.priceMin.toFixed(2)], value: '谷', itemStyle: { color: '#059669' }, label: { color: '#fff', fontSize: 10 } },
              ],
            } : undefined,
          }],
        };
      });

      const structChart = useChart(() => {
        const sm = summary.value;
        if (!sm) return null;
        const gen = sm.genAgg.slice().sort((a, b) => b.mw - a.mw);
        const con = sm.conAgg.slice().sort((a, b) => b.mw - a.mw);
        const names = gen.map(g => g.name).concat(con.map(c => c.name));
        return {
          grid: { left: 92, right: 56, top: 16, bottom: 30 },
          tooltip: { ...tooltipStyle, trigger: 'axis', axisPointer: { type: 'shadow' } },
          xAxis: { type: 'value', name: 'MWh', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          yAxis: { type: 'category', data: names, inverse: true, ...axisStyle, splitLine: { show: false } },
          series: [{
            type: 'bar', barWidth: 13,
            data: gen.map(g => ({
              value: +(g.mw / 4).toFixed(1),
              itemStyle: { color: ctx.nodeColor(state, g.node), borderRadius: [0, 3, 3, 0] },
            })).concat(con.map(c => ({
              value: +(c.mw / 4).toFixed(1),
              itemStyle: { color: ctx.nodeColor(state, c.node), borderRadius: [0, 3, 3, 0], opacity: .55 },
            }))),
            label: {
              show: true, position: 'right', fontSize: 11, color: '#475569',
              formatter: p => n0(p.value),
            },
          }],
        };
      });

      return {
        ctx, state, results, period, current, summary,
        priceChartEl: priceChart.el, structChartEl: structChart.el,
        n0, n1, money, nf,
      };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">市场总览</div>
        <div class="page-sub">{{state.meta.scenario}} · 统一边际价格出清 + 直流潮流节点电价</div>
      </div>

      <div v-if="!summary" class="empty">尚未出清，请点击右上角「执行全日出清」。</div>

      <template v-else>
        <div class="grid g4" style="margin-bottom:16px">
          <div class="kpi accent">
            <div class="kpi-label">当前时段出清电量</div>
            <div class="kpi-value">{{n0(current.qty)}}<span class="kpi-unit">MW</span></div>
            <div class="kpi-note">{{timeLabel}} · {{current.congested?'存在阻塞':'无阻塞'}}</div>
          </div>
          <div class="kpi accent">
            <div class="kpi-label">当前时段系统边际电价</div>
            <div class="kpi-value">{{n0(current.price)}}<span class="kpi-unit">元/MWh</span></div>
            <div class="kpi-note">能量分量 λ = {{n0(current.energy)}} 元/MWh</div>
          </div>
          <div class="kpi warn">
            <div class="kpi-label">全日电价区间</div>
            <div class="kpi-value">{{n0(summary.priceMin)}} <span style="color:#cbd5e1;font-weight:400">–</span> {{n0(summary.priceMax)}}</div>
            <div class="kpi-note">均价 {{n0(summary.priceAvg)}} · 峰谷比 {{nf(summary.priceMax/summary.priceMin,2)}}</div>
          </div>
          <div class="kpi" :class="summary.congestedCount?'bad':'ok'">
            <div class="kpi-label">阻塞时段</div>
            <div class="kpi-value">{{summary.congestedCount}}<span class="kpi-unit">/ 96</span></div>
            <div class="kpi-note">阻塞盈余合计 {{money(summary.rentTotal)}} 元</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">全日出清电价曲线</span>
            <span class="card-desc">日前市场 96 点，早晚双高峰；点击曲线可跳转时段</span>
            <div class="head-actions">
              <span class="pill pill-mute">峰 {{timeOf(summary.peakIdx)}}</span>
              <span class="pill pill-mute">谷 {{timeOf(summary.valleyIdx)}}</span>
            </div>
          </div>
          <div class="card-body">
            <div class="chart chart-lg" ref="priceChartEl"></div>
          </div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="card-head">
              <span class="card-title">全日中标电量结构</span>
              <span class="card-desc">单位 MWh（15 分钟时段按 /4 折算）</span>
            </div>
            <div class="card-body">
              <div class="legend">
                <span v-for="n in state.network.nodes" :key="n.id">
                  <i :style="{background:ctx.nodeColor(state,n.id)}"></i>{{n.name}}
                </span>
                <span style="color:#94a3b8">半透明为用电侧</span>
              </div>
              <div class="chart chart-sm" ref="structChartEl"></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">节点电价区间</span></div>
            <div class="card-body tight">
              <table>
                <thead><tr>
                  <th>节点</th><th class="num">最低</th><th class="num">最高</th><th class="num">均价</th><th class="num">峰谷差</th>
                </tr></thead>
                <tbody>
                  <tr v-for="n in state.network.nodes" :key="n.id">
                    <td>
                      <span class="pdot" :style="{background:ctx.nodeColor(state,n.id),display:'inline-block',marginRight:'7px'}"></span>
                      {{n.name}}
                      <span v-if="n.id===state.network.slackId" class="tag" style="margin-left:6px">平衡节点</span>
                    </td>
                    <td class="num">{{n0(summary.lmpRange[n.id].min)}}</td>
                    <td class="num">{{n0(summary.lmpRange[n.id].max)}}</td>
                    <td class="num">{{n0(summary.lmpRange[n.id].avg)}}</td>
                    <td class="num">{{n0(summary.lmpRange[n.id].max-summary.lmpRange[n.id].min)}}</td>
                  </tr>
                </tbody>
              </table>
              <div style="padding:13px 18px">
                <div class="note">
                  送端（电源基地）外送受阻时电价被压低，受端（负荷中心）需就地调用高价机组而电价抬升。
                  峰谷差越大，说明该节点受网络约束影响越显著。
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">出清算法说明</span>
            <div class="head-actions">
              <button class="btn btn-sm" @click="showAlgo=!showAlgo">{{showAlgo?'收起':'展开'}}</button>
            </div>
          </div>
          <div class="card-body" v-show="showAlgo">
            <div class="mono-block">一、无约束出清（统一边际价格法 / pay-as-clear）
  1. 发电侧各报价段按价格升序排队（经济调度序），用电侧按价格降序排队；
  2. 双指针逐段撮合：只要「最低未成交供给价 ≤ 最高未成交需求价」即成交，
     成交量取两者剩余量的较小值，末次成交的供给段报价即系统边际电价 SMP；
  3. 一旦供给价高于需求价，边际条件破坏，撮合停止 —— 此时的累计成交量即出清电量。

  注：本实现采用逐段撮合而非「沿累计电量扫描阶梯曲线找交点」。后者在边际段
  部分成交时会多算电量（例：Qt 版示例数据正确解为 470 MW / 260 元，
  断点扫描法会给出 520 MW，多出 50 MW 无人愿意按该价购买）。

二、二次曲线报价
  发电侧可申报连续曲线 P = a·Q² + b·Q + c（Q ∈ [0, qMax]）。
  引擎将其离散为若干微段（默认 120 段，段价取中点函数值），
  再并入同一套阶梯撮合逻辑，从而复用全部出清与结算代码。

三、网络约束与节点电价 LMP（直流潮流 + 再调度法）
  1. PTDF：由线路电抗构造降阶节点电纳矩阵 B′（去掉平衡节点），求逆后
     得 PTDF[l][n] = (X[from][n] − X[to][n]) / x_l；线路潮流 f_l = Σ_n PTDF[l][n]·注入_n；
  2. 若 |f_l| 越限，选取「单位潮流缓解成本」最小的机组对 (下调 d，上调 u) 做再调度：
       σ_g = s·PTDF[l][node_g]，s 为越限方向
       缓解灵敏度 = σ_d − σ_u
       单位成本   = (c_u − c_d) / (σ_d − σ_u)   → 取最小者，即该约束的影子价格 μ_l
  3. 由再调度后仍处部分出力的机组，按 KKT 驻点条件反解能量分量：
       λ = c_g + Σ_l μ_l·σ_l,node_g
  4. 节点电价 LMP_n = λ − Σ_l μ_l·σ_l,n
     送端阻塞分量为负（电价被压低），受端为正（电价被抬高）。

四、结算
  发电侧按所在节点 LMP 结算收入，用电侧按所在节点 LMP 支付电费。
  阻塞盈余 = Σ 用电支出 − Σ 发电收入 ≥ 0，用于补偿输电阻碍成本。
  LMP 结果与平衡节点选取无关（本页可通过「网络参数」自行验证）。</div>
          </div>
        </div>
      </template>
    </div>`,
    data() { return { showAlgo: false }; },
    computed: {
      timeLabel() { return S.periodLabel(this.period); },
    },
    methods: {
      timeOf(i) { return S.periodLabel(i); },
    },
  };

  /* ==================================================================== */
  /*                            报价申报                                    */
  /* ==================================================================== */
  // 主体维度编辑页：左侧主体列表 + 右侧当前时段报价表/曲线。
  // 支持阶梯 / 二次曲线两种模式，可批量复制到全部 96 时段或高峰时段。
  const BidPage = {
    setup() {
      const ctx = useCtx();
      const { state, period, results } = ctx;
      const selected = ref(state.participants[0].id);

      // 当前选中主体的模板数据（含全时段报价 bids 数组）
      const cur = computed(() => state.participants.find(p => p.id === selected.value));
      // 当前时段申报：注意 bids 是按 96 时段索引的二维数组
      const bid = computed(() => cur.value ? (cur.value.bids[period.value] || {}) : {});
      // 实时校验：调用引擎的 validateBid 把错误列在表单顶部
      const errs = computed(() => {
        if (!cur.value) return [];
        const b = cur.value.bids[period.value] || {};
        return E.validateBid({
          side: cur.value.side,
          bidMode: b.bidMode || 'step',
          segments: b.segments || [],
          quad: b.quad,
        });
      });

      // 切换阶梯 / 二次曲线：补默认参数以避免空表
      function setMode(m) {
        const p = cur.value, b = p.bids[period.value];
        b.bidMode = m;
        if (m === 'step' && (!b.segments || !b.segments.length)) {
          b.segments = [{ power: 100, price: 300 }, { power: 100, price: 380 }];
        }
        if (m === 'quadratic' && !b.quad) {
          b.quad = { a: 0.0004, b: 0.3, c: 250, qMax: 300, steps: 120 };
        }
        ctx.flash('已切换为' + (m === 'step' ? '阶梯' : '二次曲线') + '报价');
      }
      // 增加一段：新段默认复制上一段参数，方便用户微调
      function addSeg() {
        const b = state.participants.find(p => p.id === selected.value).bids[period.value];
        if (b.segments.length >= 10) { ctx.flash('最多 10 段'); return; }   // 与引擎校验保持一致
        const last = b.segments[b.segments.length - 1] || { power: 100, price: 300 };
        b.segments.push({ power: last.power, price: last.price });
      }
      function delSeg(i) {
        const b = state.participants.find(p => p.id === selected.value).bids[period.value];
        b.segments.splice(i, 1);
      }
      // 把当前时段报价应用到全部 96 时段（深拷贝避免时段间共享对象引用）
      function copyToAll() {
        const p = state.participants.find(x => x.id === selected.value);
        const src = JSON.parse(JSON.stringify(p.bids[period.value]));
        for (let i = 0; i < 96; i++) p.bids[i] = JSON.parse(JSON.stringify(src));
        ctx.flash('已把该时段报价复制到全部 96 个时段');
      }
      // 仅复制到归一化负荷率 ≥ 0.6 的高峰时段
      function copyToPeak() {
        const p = state.participants.find(x => x.id === selected.value);
        const src = JSON.parse(JSON.stringify(p.bids[period.value]));
        let n = 0;
        for (let i = 0; i < 96; i++) {
          if (S.normalizedLoad(i) >= 0.6) { p.bids[i] = JSON.parse(JSON.stringify(src)); n++; }
        }
        ctx.flash('已复制到 ' + n + ' 个高峰时段');
      }
      // 恢复主体的"出厂"报价曲线：从模板重新生成 96 时段
      function resetOne() {
        const p = state.participants.find(x => x.id === selected.value);
        const tpl = S.TEMPLATE.find(t => t.id === p.id);
        if (!tpl) return;
        p.bidMode = tpl.bidMode;
        p.bids = S.TEMPLATE ? seedOne(tpl) : p.bids;
        ctx.flash('已重置为默认报价曲线');
      }
      // 借默认状态播种同一主体的 96 时段报价曲线
      function seedOne(tpl) {
        return S.createDefaultState().participants.find(x => x.id === tpl.id).bids;
      }

      // 二次曲线预览：仅发电侧显示 P-Q 曲线，标注当前出清点 (Q*, P*)
      const quadChart = useChart(() => {
        const p = cur.value;
        if (!p || p.side !== 'gen') return null;
        const b = p.bids[period.value] || {};
        const q = (b.bidMode === 'quadratic') ? b.quad : p.quad;
        if (!q) return null;
        const pts = [];
        const N = 80, qm = Math.max(1, +q.qMax || 1);
        for (let i = 0; i <= N; i++) {
          const Q = qm * i / N;
          // 报价不允许为负，截断在 0
          pts.push([+Q.toFixed(2), +Math.max(0, (+q.a) * Q * Q + (+q.b) * Q + (+q.c)).toFixed(2)]);
        }
        const r = results.value[period.value];
        const mark = (r && r.ok) ? [[r.genDetail.find(d => d.id === p.id)?.awarded || 0, r.price]] : [];
        return {
          grid: { left: 58, right: 22, top: 20, bottom: 34 },
          tooltip: { ...tooltipStyle, trigger: 'axis' },
          xAxis: { type: 'value', name: 'Q (MW)', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          yAxis: { type: 'value', name: 'P (元/MWh)', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          series: [
            { type: 'line', data: pts, smooth: true, symbol: 'none', lineStyle: { width: 2, color: C.supply }, name: '报价曲线' },
            {
              type: 'scatter', data: mark, symbolSize: 11,
              itemStyle: { color: C.clear }, name: '出清点', z: 5,
            },
          ],
        };
      });

      return {
        ctx, state, period, results, selected, cur, bid, errs,
        quadChartEl: quadChart.el,
        setMode, addSeg, delSeg, copyToAll, copyToPeak, resetOne,
        n0, n1, nf,
      };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">报价申报</div>
        <div class="page-sub">编辑第 {{period+1}} 时段（{{timeLabel}}）的申报数据；修改后需重新出清</div>
      </div>

      <div class="grid" style="grid-template-columns:270px 1fr;align-items:start">
        <div class="card">
          <div class="card-head"><span class="card-title">市场主体</span></div>
          <div class="card-body">
            <div class="plist">
              <div v-for="p in state.participants" :key="p.id" class="prow"
                   :class="{active:selected===p.id, off:p.enabled===false}"
                   @click="selected=p.id">
                <span class="pdot" :style="{background:p.color}"></span>
                <div>
                  <div class="pname">{{p.name}}</div>
                  <div class="pmeta">
                    <span class="tag" :class="p.side==='gen'?'tag-gen':'tag-con'">{{p.side==='gen'?'发电':'用电'}}</span>
                    {{nodeName(p.node)}}
                  </div>
                </div>
                <div class="prow-right">
                  <div class="pbid">{{totQty(p)}} MW</div>
                  <input type="checkbox" v-model="p.enabled" @click.stop style="cursor:pointer" title="启用/停用">
                </div>
              </div>
            </div>
            <div class="note" style="margin-top:11px">
              勾选框用于临时停用某个主体（不参与出清）。MW 值为该时段申报总电力。
            </div>
          </div>
        </div>

        <div>
          <div class="card" v-if="cur">
            <div class="card-head">
              <span class="card-title">{{cur.name}}</span>
              <span class="card-desc">{{cur.side==='gen'?'发电侧':'用电侧'}} · {{nodeName(cur.node)}}</span>
              <div class="head-actions" v-if="cur.side==='gen'">
                <div class="seg-ctl">
                  <button :class="{on:(bid.bidMode||'step')==='step'}" @click="setMode('step')">阶梯报价</button>
                  <button :class="{on:bid.bidMode==='quadratic'}" @click="setMode('quadratic')">二次曲线</button>
                </div>
              </div>
            </div>
            <div class="card-body">
              <div v-if="errs.length" class="alert alert-bad">
                <div v-for="e in errs" :key="e">· {{e}}</div>
              </div>
              <div v-else class="alert alert-ok">报价校验通过</div>

              <template v-if="(bid.bidMode||'step')==='step'">
                <table style="max-width:520px">
                  <thead><tr>
                    <th style="width:52px">段号</th>
                    <th>电力 (MW)</th>
                    <th>电价 (元/MWh)</th>
                    <th style="width:60px"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(s,i) in bid.segments" :key="i">
                      <td>{{i+1}}</td>
                      <td><input class="inp-sm" type="number" v-model.number="s.power" step="10" min="0"></td>
                      <td><input class="inp-sm" type="number" v-model.number="s.price" step="10" min="0"></td>
                      <td><button class="btn btn-sm btn-ghost" @click="delSeg(i)">删除</button></td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>合计</td>
                      <td class="num">{{n1(totalPower(bid))}} MW</td>
                      <td colspan="2"></td>
                    </tr>
                  </tfoot>
                </table>
                <div class="row" style="margin-top:12px">
                  <button class="btn btn-sm" @click="addSeg">+ 增加一段</button>
                  <span class="note">
                    每段电力为该段「增量」而非累计值。
                    {{cur.side==='gen'?'发电侧电价需单调非递减。':'用电侧电价需单调非递增。'}}最多 10 段。
                  </span>
                </div>
              </template>

              <template v-else>
                <div class="grid g4" style="max-width:640px">
                  <div class="field">
                    <label class="field-label">系数 a</label>
                    <input type="number" v-model.number="bid.quad.a" step="0.0001">
                  </div>
                  <div class="field">
                    <label class="field-label">系数 b</label>
                    <input type="number" v-model.number="bid.quad.b" step="0.05">
                  </div>
                  <div class="field">
                    <label class="field-label">系数 c</label>
                    <input type="number" v-model.number="bid.quad.c" step="10">
                  </div>
                  <div class="field">
                    <label class="field-label">最大出力 qMax (MW)</label>
                    <input type="number" v-model.number="bid.quad.qMax" step="50" min="0">
                  </div>
                </div>
                <div class="note" style="margin:11px 0">
                  报价曲线 P = a·Q² + b·Q + c，Q 为出力 (MW)。引擎按 {{bid.quad.steps||120}} 段离散后参与撮合。
                </div>
                <div class="chart chart-sm" ref="quadChartEl"></div>
              </template>

              <div class="row" style="margin-top:14px;padding-top:13px;border-top:1px solid #f1f5f9">
                <button class="btn btn-sm" @click="copyToAll">复制到全部 96 时段</button>
                <button class="btn btn-sm" @click="copyToPeak">复制到高峰时段</button>
                <button class="btn btn-sm" @click="resetOne">恢复默认曲线</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <span class="card-title">本时段全部申报</span>
              <span class="card-desc">{{timeLabel}}</span>
            </div>
            <div class="card-body tight tbl-scroll">
              <table>
                <thead><tr>
                  <th>主体</th><th>角色</th><th>节点</th><th>方式</th>
                  <th class="num">申报电力</th><th class="num">报价区间</th>
                  <th class="num">中标量</th><th class="num">结算电价</th><th class="num">金额 (元)</th>
                </tr></thead>
                <tbody>
                  <tr v-for="p in state.participants" :key="p.id" v-show="p.enabled!==false">
                    <td><span class="pdot" :style="{background:p.color,display:'inline-block',marginRight:'7px'}"></span>{{p.name}}</td>
                    <td><span class="tag" :class="p.side==='gen'?'tag-gen':'tag-con'">{{p.side==='gen'?'发电':'用电'}}</span></td>
                    <td>{{nodeName(p.node)}}</td>
                    <td>{{(p.bids[period].bidMode||'step')==='step'?'阶梯':'二次曲线'}}</td>
                    <td class="num">{{n1(totQty(p))}}</td>
                    <td class="num">{{priceRange(p)}}</td>
                    <td class="num">{{n1(awardOf(p))}}</td>
                    <td class="num">{{n0(priceOf(p))}}</td>
                    <td class="num">{{money(amountOf(p))}}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    computed: {
      timeLabel() { return S.periodLabel(this.period); },
    },
    methods: {
      // 节点 id → 显示名（北区 / 中区 / 南区），由 MarketStore 提供
      nodeName(id) { return S.nodeName(this.state, id); },
      // 阶梯报价总电力：累加各段增量
      totalPower(b) { return (b.segments || []).reduce((s, x) => s + (+x.power || 0), 0); },
      // 主体在当前时段的"申报总电力"：阶梯报价求和 / 二次曲线直接取 qMax
      totQty(p) {
        const b = p.bids[this.period] || {};
        if ((b.bidMode || 'step') === 'quadratic') return +(b.quad && b.quad.qMax) || 0;
        return (b.segments || []).reduce((s, x) => s + (+x.power || 0), 0);
      },
      // 报价区间显示：阶梯 "min → max"，二次曲线 "c → C(qMax)"
      priceRange(p) {
        const b = p.bids[this.period] || {};
        if ((b.bidMode || 'step') === 'quadratic') {
          const q = b.quad; if (!q) return '—';
          return this.n0(q.c) + ' → ' + this.n0(Math.max(0, q.a * q.qMax * q.qMax + q.b * q.qMax + q.c));
        }
        const ps = (b.segments || []).map(x => +x.price || 0);
        if (!ps.length) return '—';
        return this.n0(Math.min(...ps)) + ' → ' + this.n0(Math.max(...ps));
      },
      // 当前时段中标量：从结果里按主体 id 查
      awardOf(p) {
        const r = this.results[this.period];
        if (!r || !r.ok) return 0;
        const d = (p.side === 'gen' ? r.genDetail : r.conDetail).find(x => x.id === p.id);
        return d ? d.awarded : 0;
      },
      // 当前时段结算电价：所在节点的 LMP
      priceOf(p) {
        const r = this.results[this.period];
        if (!r || !r.ok) return null;
        const d = (p.side === 'gen' ? r.genDetail : r.conDetail).find(x => x.id === p.id);
        return d ? d.price : null;
      },
      // 发电侧取收入、用电侧取支出
      amountOf(p) {
        const r = this.results[this.period];
        if (!r || !r.ok) return null;
        const d = (p.side === 'gen' ? r.genDetail : r.conDetail).find(x => x.id === p.id);
        return d ? (p.side === 'gen' ? d.income : d.payment) : null;
      },
      money: money,
    },
  };

  /* ==================================================================== */
  /*                            供需曲线                                    */
  /* ==================================================================== */
  // 单时段视角下的出清图：阶梯式供需曲线 + 出清点 (Q*, P*) 标记 +
  //                     节点电价分解表（阻塞时）+ 发/用两侧中标明细 + 线路潮流表
  const CurvePage = {
    setup() {
      const ctx = useCtx();
      const { state, period, results } = ctx;

      // 阶梯式供需曲线 + 出清点：把引擎返回的 stepCurve 数据直接画成 step: 'end' 的折线
      const chart = useChart(() => {
        const r = results.value[period.value];
        if (!r || !r.ok) return null;
        const sup = (r.supplyCurve || []).map(p => [p[0], p[1]]);   // 供给段累计
        const dem = (r.demandCurve || []).map(p => [p[0], p[1]]);   // 需求段累计
        // 自适应坐标轴上限：在最大累计电量上再加 6%，在所有电价上再加 8%
        const maxQ = Math.max(
          sup.length ? sup[sup.length - 1][0] : 0,
          dem.length ? dem[dem.length - 1][0] : 0) * 1.06 + 10;
        const allP = sup.concat(dem).map(p => p[1]).concat([r.price]);
        const maxP = Math.max(...allP) * 1.08 + 10;
        return {
          grid: { ...baseGrid, top: 40 },
          tooltip: {
            ...tooltipStyle, trigger: 'axis',
            formatter: ps => {
              const q = ps[0].axisValue;
              let s = '电量 ' + n0(q) + ' MW<br>';
              for (const p of ps) s += p.marker + p.seriesName + '：' + n0(p.data[1]) + ' 元/MWh<br>';
              return s;
            },
          },
          legend: {
            top: 4, right: 8, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: '#475569' },
            data: ['供应曲线', '需求曲线'],
          },
          xAxis: { type: 'value', name: '累计电量 (MW)', max: maxQ, nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          yAxis: { type: 'value', name: '电价 (元/MWh)', max: maxP, nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          series: [
            {
              name: '供应曲线', type: 'line', step: 'end', data: sup, symbol: 'none',
              lineStyle: { width: 2.2, color: C.supply },
              areaStyle: { color: 'rgba(37,99,235,.08)' },   // 半透明面积仅为视觉提示
            },
            {
              name: '需求曲线', type: 'line', step: 'end', data: dem, symbol: 'none',
              lineStyle: { width: 2.2, color: C.demand },
              areaStyle: { color: 'rgba(217,119,6,.08)' },
            },
            // 第三个系列：单点散点 + 两条参考线，标注 (Q*, P*)
            {
              name: '出清', type: 'scatter', symbolSize: 12, z: 6,
              data: [[r.qty, r.price]],
              itemStyle: { color: C.clear, borderColor: '#fff', borderWidth: 2 },
              tooltip: { show: false },
              markLine: {
                silent: true, symbol: 'none',
                data: [
                  { yAxis: r.price, lineStyle: { color: C.clear, type: 'dashed', width: 1 },
                    label: { formatter: 'SMP ' + n0(r.price), fontSize: 10, color: '#dc2626', position: 'insideEndTop' } },
                  { xAxis: r.qty, lineStyle: { color: C.clear, type: 'dashed', width: 1 },
                    label: { formatter: n0(r.qty) + ' MW', fontSize: 10, color: '#dc2626', position: 'insideEndBottom' } },
                ],
              },
            },
          ],
        };
      });

      return { ctx, state, period, results, chartEl: chart.el, n0, n1, nf, money };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">供需曲线与出清点</div>
        <div class="page-sub">第 {{period+1}} 时段（{{timeLabel}}）· 阶梯曲线交点即统一出清结果</div>
      </div>

      <div v-if="!results[period] || !results[period].ok" class="empty">该时段无可展示的出清结果。</div>

      <template v-else>
        <div class="grid g4" style="margin-bottom:16px">
          <div class="kpi accent">
            <div class="kpi-label">出清电量</div>
            <div class="kpi-value">{{n0(r.qty)}}<span class="kpi-unit">MW</span></div>
          </div>
          <div class="kpi accent">
            <div class="kpi-label">系统边际电价 SMP</div>
            <div class="kpi-value">{{n0(r.price)}}<span class="kpi-unit">元/MWh</span></div>
          </div>
          <div class="kpi" :class="r.congested?'warn':'ok'">
            <div class="kpi-label">网络状态</div>
            <div class="kpi-value" style="font-size:20px">{{r.congested?'发生阻塞':'无阻塞'}}</div>
            <div class="kpi-note">能量分量 {{n0(r.energy)}} 元/MWh</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">本时段阻塞盈余</div>
            <div class="kpi-value">{{money(r.rent)}}<span class="kpi-unit">元</span></div>
            <div class="kpi-note">再调度成本 {{money(r.redispatchCost)}} 元</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">供需阶梯曲线</span>
            <span class="card-desc">供应按报价升序累加，需求按报价降序累加</span>
          </div>
          <div class="card-body">
            <div class="chart chart-lg" ref="chartEl"></div>
          </div>
        </div>

        <div class="card" v-if="r.congested">
          <div class="card-head"><span class="card-title">节点电价分解</span>
            <span class="card-desc">LMP = 能量分量 + 阻塞分量</span></div>
          <div class="card-body tight tbl-scroll">
            <table>
              <thead><tr>
                <th>节点</th><th class="num">能量分量 λ</th><th class="num">阻塞分量</th>
                <th class="num">节点电价 LMP</th><th class="num">该节点发电</th><th class="num">该节点用电</th>
              </tr></thead>
              <tbody>
                <tr v-for="n in state.network.nodes" :key="n.id">
                  <td><span class="pdot" :style="{background:ctx.nodeColor(state,n.id),display:'inline-block',marginRight:'7px'}"></span>{{n.name}}</td>
                  <td class="num">{{n0(r.energy)}}</td>
                  <td class="num" :style="{color:(r.congestion[n.id]||0)>0.5?'#dc2626':(r.congestion[n.id]||0)<-0.5?'#059669':'#475569'}">
                    {{nf(r.congestion[n.id],2)}}
                  </td>
                  <td class="num" style="font-weight:600">{{n0(r.lmp[n.id])}}</td>
                  <td class="num">{{n1(nodeGen(n.id))}}</td>
                  <td class="num">{{n1(nodeCon(n.id))}}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="card-head"><span class="card-title">发电侧中标明细</span></div>
            <div class="card-body tight tbl-scroll">
              <table>
                <thead><tr><th>电厂</th><th>节点</th><th class="num">申报</th><th class="num">中标</th><th class="num">利用率</th><th class="num">电价</th><th class="num">收入 (元)</th></tr></thead>
                <tbody>
                  <tr v-for="d in r.genDetail" :key="d.id">
                    <td>{{d.name}}</td><td>{{nodeName(d.node)}}</td>
                    <td class="num">{{n1(d.bidQty)}}</td><td class="num">{{n1(d.awarded)}}</td>
                    <td class="num">{{d.bidQty>0?nf(d.awarded/d.bidQty*100,0)+'%':'—'}}</td>
                    <td class="num">{{n0(d.price)}}</td><td class="num">{{money(d.income)}}</td>
                  </tr>
                </tbody>
                <tfoot><tr><td colspan="3">合计</td><td class="num">{{n1(sumGenMw)}}</td><td></td><td></td><td class="num">{{money(r.totalGenIncome)}}</td></tr></tfoot>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">用电侧中标明细</span></div>
            <div class="card-body tight tbl-scroll">
              <table>
                <thead><tr><th>用户</th><th>节点</th><th class="num">申报</th><th class="num">中标</th><th class="num">满足率</th><th class="num">电价</th><th class="num">支出 (元)</th></tr></thead>
                <tbody>
                  <tr v-for="d in r.conDetail" :key="d.id">
                    <td>{{d.name}}</td><td>{{nodeName(d.node)}}</td>
                    <td class="num">{{n1(d.bidQty)}}</td><td class="num">{{n1(d.awarded)}}</td>
                    <td class="num">{{d.bidQty>0?nf(d.awarded/d.bidQty*100,0)+'%':'—'}}</td>
                    <td class="num">{{n0(d.price)}}</td><td class="num">{{money(d.payment)}}</td>
                  </tr>
                </tbody>
                <tfoot><tr><td colspan="3">合计</td><td class="num">{{n1(sumConMw)}}</td><td></td><td></td><td class="num">{{money(r.totalConPayment)}}</td></tr></tfoot>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">线路潮流</span></div>
          <div class="card-body tight">
            <table>
              <thead><tr><th>线路</th><th>方向</th><th class="num">电抗 (pu)</th><th class="num">潮流 (MW)</th><th class="num">容量 (MW)</th><th style="width:170px">负载率</th><th class="num">影子价格</th></tr></thead>
              <tbody>
                <tr v-for="(l,i) in state.network.lines" :key="l.id">
                  <td>{{l.name}}</td>
                  <td>{{nodeName(l.from)}} → {{nodeName(l.to)}}</td>
                  <td class="num">{{nf(l.x,3)}}</td>
                  <td class="num" :style="{color:Math.abs(r.flows[i]||0)>l.cap+1e-6?'#dc2626':'inherit'}">{{n1(r.flows[i]||0)}}</td>
                  <td class="num">{{n0(l.cap)}}</td>
                  <td>
                    <div class="bar-track">
                      <div class="bar-fill" :style="{width:loadPct(i)+'%',background:loadPct(i)>99.5?'#dc2626':loadPct(i)>85?'#d97706':'#2563eb'}"></div>
                    </div>
                  </td>
                  <td class="num">{{(r.mu[i]||0)>0.01?nf(r.mu[i],2):'—'}}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>`,
    computed: {
      r() { return this.results[this.period] || {}; },
      timeLabel() { return S.periodLabel(this.period); },
      sumGenMw() { return (this.r.genDetail || []).reduce((s, d) => s + d.awarded, 0); },
      sumConMw() { return (this.r.conDetail || []).reduce((s, d) => s + d.awarded, 0); },
    },
    methods: {
      nodeName(id) { return S.nodeName(this.state, id); },
      nodeGen(id) { return (this.r.genDetail || []).filter(d => d.node === id).reduce((s, d) => s + d.awarded, 0); },
      nodeCon(id) { return (this.r.conDetail || []).filter(d => d.node === id).reduce((s, d) => s + d.awarded, 0); },
      loadPct(i) {
        const l = this.state.network.lines[i];
        if (!l || !l.cap) return 0;
        return Math.min(100, Math.abs(this.r.flows[i] || 0) / l.cap * 100);
      },
      money: money,
    },
  };

  /* ==================================================================== */
  /*                          电价与阻塞                                    */
  /* ==================================================================== */
  // 全日 96 时段视角下的电价分析：热力气泡图 + LMP 走势 + LMP 构成分解 + 线路潮流 + PTDF 矩阵
  const PricePage = {
    setup() {
      const ctx = useCtx();
      const { state, results, period, summary } = ctx;

      // 节点电价 LMP 走势：每个节点一条线；如启用网络约束，再叠加一条 SMP 虚线
      const lmpChart = useChart(() => {
        const rs = results.value;
        if (!rs.length) return null;
        const labels = []; for (let i = 0; i < 96; i++) labels.push(S.periodLabel(i));
        const series = [];
        if (state.network.enabled) {
          series.push({
            name: '系统边际电价 SMP（无约束）', type: 'line', smooth: true, symbol: 'none',
            data: rs.map(r => r && r.ok ? +r.price.toFixed(2) : null),
            lineStyle: { width: 1.6, color: '#94a3b8', type: 'dashed' },
          });
        }
        state.network.nodes.forEach((n, i) => {
          series.push({
            name: 'LMP · ' + n.name, type: 'line', smooth: true, symbol: 'none',
            data: rs.map(r => r && r.ok && r.lmp[n.id] !== undefined ? +r.lmp[n.id].toFixed(2) : null),
            lineStyle: { width: 2, color: C.node[i % C.node.length] },
            itemStyle: { color: C.node[i % C.node.length] },
          });
        });
        return {
          grid: { ...baseGrid, top: 44, right: 26 },
          tooltip: {
            ...tooltipStyle, trigger: 'axis',
            formatter: ps => {
              let s = '<b>' + ps[0].axisValue + '</b><br>';
              for (const p of ps) if (p.data !== null && p.data !== undefined) s += p.marker + p.seriesName + '：' + n0(p.data) + '<br>';
              const r = rs[ps[0].dataIndex];
              if (r && r.congested) s += '<span style="color:#fbbf24">该时段阻塞</span>';
              return s;
            },
          },
          legend: { top: 4, left: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: '#475569' } },
          xAxis: { type: 'category', data: labels, boundaryGap: false, ...axisStyle, axisLabel: { ...axisStyle.axisLabel, interval: 7 } },
          yAxis: { type: 'value', name: '元/MWh', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          series,
        };
      });

      // LMP 构成分解：堆叠柱状图 —— 灰色基座是能量分量 λ，彩色是各节点的阻塞分量
      const stackChart = useChart(() => {
        const rs = results.value;
        if (!rs.length) return null;
        const labels = []; for (let i = 0; i < 96; i++) labels.push(S.periodLabel(i));
        const energy = rs.map(r => r && r.ok ? +Math.max(0, r.energy).toFixed(2) : 0);
        const series = [{
          name: '能量分量 λ', type: 'bar', stack: 'lmp', data: energy,
          itemStyle: { color: '#94a3b8' }, barWidth: '72%',
        }];
        const nodes = state.network.nodes;
        nodes.forEach((n, i) => {
          series.push({
            name: '阻塞分量 · ' + n.name, type: 'bar', stack: 'lmp',
            // 阻塞分量可能为负（送端），堆叠图仅显示绝对值高度，颜色提示正负
            data: rs.map(r => r && r.ok && r.lmp[n.id] !== undefined
              ? +Math.max(0, r.lmp[n.id] - r.energy).toFixed(2) : 0),
            itemStyle: { color: C.node[i % C.node.length], opacity: .85 },
          });
        });
        return {
          grid: { ...baseGrid, top: 44, right: 26 },
          tooltip: { ...tooltipStyle, trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 4, left: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: '#475569' } },
          xAxis: { type: 'category', data: labels, ...axisStyle, axisLabel: { ...axisStyle.axisLabel, interval: 7 } },
          yAxis: { type: 'value', name: '元/MWh', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          series,
        };
      });

      // 线路潮流：每条线路一条 |f| 折线，红色点线标容量
      const flowChart = useChart(() => {
        const rs = results.value;
        if (!rs.length) return null;
        const labels = []; for (let i = 0; i < 96; i++) labels.push(S.periodLabel(i));
        const series = state.network.lines.map((l, li) => ({
          name: l.name, type: 'line', smooth: true, symbol: 'none',
          data: rs.map(r => r && r.ok ? +Math.abs(r.flows[li] || 0).toFixed(1) : null),
          lineStyle: { width: 1.8, color: C.node[li % C.node.length] },
          itemStyle: { color: C.node[li % C.node.length] },
          markLine: {
            silent: true, symbol: 'none',
            data: [{ yAxis: +l.cap, lineStyle: { color: '#dc2626', type: 'dotted', width: 1.2 } }],
            label: { show: false },
          },
        }));
        return {
          grid: { ...baseGrid, top: 44, right: 26 },
          tooltip: { ...tooltipStyle, trigger: 'axis' },
          legend: { top: 4, left: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: '#475569' } },
          xAxis: { type: 'category', data: labels, boundaryGap: false, ...axisStyle, axisLabel: { ...axisStyle.axisLabel, interval: 7 } },
          yAxis: { type: 'value', name: 'MW', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          series,
        };
      });

      return {
        ctx, state, results, period, summary,
        lmpChartEl: lmpChart.el, stackChartEl: stackChart.el, flowChartEl: flowChart.el,
        n0, n1, nf, money,
      };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">电价与阻塞</div>
        <div class="page-sub">96 时段节点电价走势、LMP 构成分解与线路潮流</div>
      </div>

      <div v-if="!summary" class="empty">尚未出清。</div>
      <template v-else>
        <div class="card">
          <div class="card-head">
            <span class="card-title">时段电价速览</span>
            <span class="card-desc">颜色越暖电价越高，点击可直接跳转</span>
          </div>
          <div class="card-body">
            <div style="display:flex;gap:1px;height:34px">
              <div v-for="i in 96" :key="i" @click="period=i-1"
                   :title="label(i-1)+' · '+n0(results[i-1].price)+' 元/MWh'"
                   :style="{flex:1,background:heat(i-1),cursor:'pointer',
                            outline:period===i-1?'2px solid #0f172a':'none',borderRadius:'2px'}"></div>
            </div>
            <div class="row" style="margin-top:9px;justify-content:space-between">
              <span class="note">00:00</span><span class="note">06:00</span>
              <span class="note">12:00</span><span class="note">18:00</span><span class="note">24:00</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">节点电价 LMP 走势</span>
            <span class="card-desc">虚线为不考虑网络约束时的系统边际电价 SMP</span>
          </div>
          <div class="card-body"><div class="chart chart-lg" ref="lmpChartEl"></div></div>
        </div>

        <div class="card" v-if="state.network.enabled">
          <div class="card-head">
            <span class="card-title">LMP 构成分解</span>
            <span class="card-desc">堆叠高度 = 节点电价，灰色为能量分量，彩色为阻塞分量</span>
          </div>
          <div class="card-body"><div class="chart chart-lg" ref="stackChartEl"></div></div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">线路潮流</span>
            <span class="card-desc">红色点线为线路容量上限</span>
          </div>
          <div class="card-body"><div class="chart" ref="flowChartEl"></div></div>
        </div>

        <div class="card" v-if="pt">
          <div class="card-head">
            <span class="card-title">PTDF 灵敏度矩阵</span>
            <span class="card-desc">节点注入单位功率在线路上的分布因子 · 平衡节点 {{nodeName(state.network.slackId)}}</span>
          </div>
          <div class="card-body tight tbl-scroll">
            <table>
              <thead><tr><th>线路</th><th v-for="n in state.network.nodes" :key="n.id" class="num">{{n.name}}</th></tr></thead>
              <tbody>
                <tr v-for="(l,li) in state.network.lines" :key="l.id">
                  <td>{{l.name}}</td>
                  <td v-for="(n,ni) in state.network.nodes" :key="n.id" class="num">{{nf(pt.matrix[li][ni],4)}}</td>
                </tr>
              </tbody>
            </table>
            <div style="padding:13px 18px" class="note">
              线路潮流 f = Σ PTDF[l][n] × 节点净注入。平衡节点所在列的 PTDF 恒为 0，
              这是直流潮流的参考节点约定，也是「能量分量 λ = 平衡节点电价」的由来。
            </div>
          </div>
        </div>
      </template>
    </div>`,
    computed: {
      pt() {
        const r = this.results[this.period];
        return r && r.ptdf ? r.ptdf : null;
      },
    },
    methods: {
      nodeName(id) { return S.nodeName(this.state, id); },
      heat(i) {
        const r = this.results[i];
        if (!r || !r.ok) return '#f1f5f9';
        const sm = this.summary;
        const t = sm.priceMax > sm.priceMin ? (r.price - sm.priceMin) / (sm.priceMax - sm.priceMin) : 0.5;
        // 蓝 → 黄 → 红
        const h = (1 - t) * 210;
        return 'hsl(' + h.toFixed(0) + ',72%,' + (58 - t * 8).toFixed(0) + '%)';
      },
      label(i) { return S.periodLabel(i); },
    },
  };

  /* ==================================================================== */
  /*                            结算校验                                    */
  /* ==================================================================== */
  // 全日累计结算与一致性校验：4 个 KPI + 5 项校验清单 + 主体收支排行 + 资金流向展示
  const SettlePage = {
    setup() {
      const ctx = useCtx();
      const { state, results, summary } = ctx;

      // 5 项一致性自检 —— 任何一项不通过都说明 LMP/再调度计算有 bug
      const checks = computed(() => {
        const sm = summary.value;
        if (!sm) return [];
        const out = [];

        // 1. 电量守恒：发电中标 = 用电中标（必有等量成交）
        const diff = Math.abs(sm.genMw - sm.conMw);
        out.push({
          name: '电量守恒：发电侧中标总量 = 用电侧中标总量',
          ok: diff < 1e-3, detail: '差额 ' + nf(diff, 4) + ' MW',
        });

        // 2. 资金守恒：用电支出 = 发电收入 + 阻塞盈余
        const balDiff = Math.abs(sm.conTotal - sm.genTotal - sm.rentTotal);
        out.push({
          name: '资金守恒：用电支出 = 发电收入 + 阻塞盈余',
          ok: balDiff < Math.max(1, sm.conTotal * 1e-6),
          detail: '差额 ' + nf(balDiff, 2) + ' 元',
        });

        // 3. 阻塞盈余非负：LMP 结算理论性质，若出现负值则说明计算有误
        const minRent = Math.min(...results.value.filter(r => r && r.ok).map(r => r.rent));
        out.push({
          name: '阻塞盈余非负（LMP 结算的理论性质）',
          ok: minRent > -0.05, detail: '单时段最小值 ' + nf(minRent, 2) + ' 元',
        });

        // 4. 中标量不超过申报量：所有主体的 awarded ≤ bidQty
        const over = results.value.filter(r => r && r.ok)
          .some(r => r.genDetail.concat(r.conDetail).some(d => d.awarded > d.bidQty + 1e-6));
        out.push({
          name: '中标量不超过申报量',
          ok: !over, detail: over ? '存在超申报中标' : '全部时段通过',
        });

        // 5. 出清有效性：不存在"无成交"或"无可行解"的时段
        out.push({
          name: '出清有效性：不存在无成交或无可行解时段',
          ok: sm.unmatched === 0 && sm.infeasible === 0,
          detail: '无成交 ' + sm.unmatched + ' 个，无可行解 ' + sm.infeasible + ' 个',
        });
        return out;
      });

      // 主体收支排行柱状图：横向条形按金额排序，发电蓝 / 用电橙
      const chart = useChart(() => {
        const sm = summary.value;
        if (!sm) return null;
        const names = sm.genAgg.map(a => a.name).concat(sm.conAgg.map(a => a.name));
        return {
          grid: { left: 96, right: 76, top: 16, bottom: 30 },
          tooltip: {
            ...tooltipStyle, trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: ps => {
              const i = ps[0].dataIndex;
              const all = sm.genAgg.concat(sm.conAgg)[i];
              return '<b>' + all.name + '</b><br>节点：' + S.nodeName(state, all.node)
                + '<br>全日中标：' + n0(all.mw / 4) + ' MWh<br>金额：' + money(all.amt) + ' 元';
            },
          },
          xAxis: { type: 'value', name: '元', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, ...axisStyle },
          yAxis: { type: 'category', data: names, inverse: true, ...axisStyle, splitLine: { show: false } },
          series: [{
            type: 'bar', barWidth: 13,
            data: sm.genAgg.map(a => ({
              value: +a.amt.toFixed(0),
              itemStyle: { color: C.gen, borderRadius: [0, 3, 3, 0] },
            })).concat(sm.conAgg.map(a => ({
              value: +a.amt.toFixed(0),
              itemStyle: { color: C.con, borderRadius: [0, 3, 3, 0] },
            }))),
            label: { show: true, position: 'right', fontSize: 11, color: '#475569', formatter: p => money(p.value) },
          }],
        };
      });
      return { ctx, state, results, summary, chartEl: chart.el, checks, n0, n1, nf, money };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">结算与校验</div>
        <div class="page-sub">全日 96 时段累计结算，以及市场出清结果的一致性自检</div>
      </div>

      <div v-if="!summary" class="empty">尚未出清。</div>
      <template v-else>
        <div class="grid g4" style="margin-bottom:16px">
          <div class="kpi">
            <div class="kpi-label">发电侧总收入</div>
            <div class="kpi-value" style="font-size:21px">{{money(summary.genTotal)}}<span class="kpi-unit">元</span></div>
            <div class="kpi-note">{{n0(summary.genMw/4)}} MWh</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">用电侧总支出</div>
            <div class="kpi-value" style="font-size:21px">{{money(summary.conTotal)}}<span class="kpi-unit">元</span></div>
            <div class="kpi-note">{{n0(summary.conMw/4)}} MWh</div>
          </div>
          <div class="kpi warn">
            <div class="kpi-label">阻塞盈余</div>
            <div class="kpi-value" style="font-size:21px">{{money(summary.rentTotal)}}<span class="kpi-unit">元</span></div>
            <div class="kpi-note">占支出 {{nf(summary.conTotal>0?summary.rentTotal/summary.conTotal*100:0,2)}}%</div>
          </div>
          <div class="kpi" :class="allOk?'ok':'bad'">
            <div class="kpi-label">一致性校验</div>
            <div class="kpi-value" style="font-size:21px">{{passed}} / {{checks.length}}</div>
            <div class="kpi-note">{{allOk?'全部通过':'存在异常'}}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">一致性校验清单</span></div>
          <div class="card-body">
            <div v-for="c in checks" :key="c.name" class="check-row">
              <span class="check-mark" :class="c.ok?'ok':'bad'">{{c.ok?'✓':'!'}}</span>
              <span>{{c.name}}</span>
              <span style="margin-left:auto;color:#94a3b8;font-size:12px">{{c.detail}}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">各市场主体全日结算</span>
            <div class="head-actions">
              <span class="legend" style="margin:0">
                <span><i style="background:#2563eb"></i>发电收入</span>
                <span><i style="background:#d97706"></i>用电支出</span>
              </span>
            </div>
          </div>
          <div class="card-body"><div class="chart" ref="chartEl"></div></div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="card-head"><span class="card-title">发电侧结算汇总</span></div>
            <div class="card-body tight tbl-scroll">
              <table>
                <thead><tr><th>电厂</th><th>节点</th><th class="num">中标 MWh</th><th class="num">平均电价</th><th class="num">收入 (元)</th></tr></thead>
                <tbody>
                  <tr v-for="a in summary.genAgg" :key="a.id">
                    <td>{{a.name}}</td><td>{{nodeName(a.node)}}</td>
                    <td class="num">{{n0(a.mw/4)}}</td>
                    <td class="num">{{a.mw>0?n0(a.amt/a.mw):'—'}}</td>
                    <td class="num">{{money(a.amt)}}</td>
                  </tr>
                </tbody>
                <tfoot><tr><td colspan="2">合计</td><td class="num">{{n0(summary.genMw/4)}}</td><td></td><td class="num">{{money(summary.genTotal)}}</td></tr></tfoot>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">用电侧结算汇总</span></div>
            <div class="card-body tight tbl-scroll">
              <table>
                <thead><tr><th>用户</th><th>节点</th><th class="num">中标 MWh</th><th class="num">平均电价</th><th class="num">支出 (元)</th></tr></thead>
                <tbody>
                  <tr v-for="a in summary.conAgg" :key="a.id">
                    <td>{{a.name}}</td><td>{{nodeName(a.node)}}</td>
                    <td class="num">{{n0(a.mw/4)}}</td>
                    <td class="num">{{a.mw>0?n0(a.amt/a.mw):'—'}}</td>
                    <td class="num">{{money(a.amt)}}</td>
                  </tr>
                </tbody>
                <tfoot><tr><td colspan="2">合计</td><td class="num">{{n0(summary.conMw/4)}}</td><td></td><td class="num">{{money(summary.conTotal)}}</td></tr></tfoot>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">资金流向</span></div>
          <div class="card-body">
            <div class="mono-block">用电侧总支出        {{pad(money(summary.conTotal))}} 元
− 发电侧总收入        {{pad(money(summary.genTotal))}} 元
= 阻塞盈余（ congestion rent ）
                     {{pad(money(summary.rentTotal))}} 元

阻塞盈余产生于送端与受端的节点电价差异：
用电侧按各自节点 LMP 付费，发电侧按各自节点 LMP 结算，
两者之差由市场运营机构收取，用于回收输电阻塞管理费用。
理论上该值恒 ≥ 0，可作为 LMP 计算结果正确性的一个判据。</div>
          </div>
        </div>
      </template>
    </div>`,
    computed: {
      allOk() { return this.checks.every(c => c.ok); },
      passed() { return this.checks.filter(c => c.ok).length; },
    },
    methods: {
      nodeName(id) { return S.nodeName(this.state, id); },
      pad(s) { return String(s).padStart(14, ' '); },
    },
  };

  /* ==================================================================== */
  /*                            网络参数                                    */
  /* ==================================================================== */
  // 电网拓扑编辑页：网络约束开关、平衡节点选择、节点列表、线路编辑
  const NetworkPage = {
    setup() {
      const ctx = useCtx();
      const { state, period } = ctx;
      // 在两端默认节点之间追加一条新线路
      function addLine() {
        const ns = state.network.nodes;
        state.network.lines.push({
          id: 'L' + (state.network.lines.length + 1) + '_' + Date.now().toString(36),   // 加时间戳避免重复 id
          name: '新增线路', from: ns[0].id, to: ns[ns.length - 1].id, x: 0.1, cap: 300,
        });
      }
      function delLine(i) { state.network.lines.splice(i, 1); }
      return { ctx, state, period, addLine, delLine, nf };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">网络参数</div>
        <div class="page-sub">定义电网拓扑与输电容量；修改后需重新出清</div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">模型开关</span></div>
        <div class="card-body">
          <div class="row">
            <label class="switch">
              <input type="checkbox" v-model="state.network.enabled">
              考虑网络阻塞（关闭则全网执行统一边际电价）
            </label>
            <span style="width:16px"></span>
            <span class="note">平衡节点</span>
            <select v-model="state.network.slackId" style="width:150px">
              <option v-for="n in state.network.nodes" :key="n.id" :value="n.id">{{n.name}}（{{n.id}}）</option>
            </select>
            <span class="note">LMP 结果不随平衡节点改变，可自行切换验证</span>
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card">
          <div class="card-head"><span class="card-title">节点</span></div>
          <div class="card-body tight">
            <table>
              <thead><tr><th>标识</th><th>名称</th><th>说明</th><th class="num">发电</th><th class="num">用电</th></tr></thead>
              <tbody>
                <tr v-for="n in state.network.nodes" :key="n.id">
                  <td><span class="pdot" :style="{background:ctx.nodeColor(state,n.id),display:'inline-block',marginRight:'7px'}"></span>{{n.id}}</td>
                  <td>{{n.name}}</td>
                  <td style="color:#64748b;font-size:12px">{{n.desc}}</td>
                  <td class="num">{{n1(capAt(n.id,'gen'))}} MW</td>
                  <td class="num">{{n1(capAt(n.id,'con'))}} MW</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">线路</span>
            <div class="head-actions"><button class="btn btn-sm" @click="addLine">+ 新增线路</button></div>
          </div>
          <div class="card-body tight tbl-scroll">
            <table>
              <thead><tr>
                <th>名称</th><th>送端</th><th>受端</th><th class="num" style="width:88px">电抗 x</th>
                <th class="num" style="width:96px">容量 MW</th><th style="width:48px"></th>
              </tr></thead>
              <tbody>
                <tr v-for="(l,i) in state.network.lines" :key="l.id">
                  <td><input class="inp-sm" type="text" v-model="l.name"></td>
                  <td>
                    <select class="inp-sm" v-model="l.from">
                      <option v-for="n in state.network.nodes" :key="n.id" :value="n.id">{{n.name}}</option>
                    </select>
                  </td>
                  <td>
                    <select class="inp-sm" v-model="l.to">
                      <option v-for="n in state.network.nodes" :key="n.id" :value="n.id">{{n.name}}</option>
                    </select>
                  </td>
                  <td><input class="inp-sm" type="number" v-model.number="l.x" step="0.01" min="0.001"></td>
                  <td><input class="inp-sm" type="number" v-model.number="l.cap" step="20" min="0"></td>
                  <td><button class="btn btn-sm btn-ghost" @click="delLine(i)">×</button></td>
                </tr>
              </tbody>
            </table>
            <div style="padding:13px 18px" class="note">
              电抗越小线路越"容易走电"，容量越小越容易阻塞。
              把某条线路容量调低，可在「电价与阻塞」页看到送受端电价被拉开。
            </div>
          </div>
        </div>
      </div>
    </div>`,
    methods: {
      // 节点在某侧的"申报总电力"：累加该节点所有主体在该时段的申报量
      // 二次曲线取 qMax，阶梯报价取 segments.power 之和
      capAt(id, side) {
        let t = 0;
        const per = this.period;
        for (const p of this.state.participants) {
          if (p.enabled === false || p.side !== side || p.node !== id) continue;
          const b = p.bids[per] || {};
          if ((b.bidMode || 'step') === 'quadratic') t += +(b.quad && b.quad.qMax) || 0;
          else t += (b.segments || []).reduce((s, x) => s + (+x.power || 0), 0);
        }
        return t;
      },
      n1: n1,
    },
  };

  /* ==================================================================== */
  /*                            数据管理                                    */
  /* ==================================================================== */
  // 方案存档、读档、结果导出、恢复默认、清空缓存
  const DataPage = {
    setup() {
      const ctx = useCtx();
      const { state, results } = ctx;
      const fileRef = ref(null);

      // 导出方案 JSON（含全部 96 时段报价）
      function doExport() { S.exportJSON(JSON.parse(JSON.stringify(state))); ctx.flash('方案已导出'); }
      // 触发隐藏的 <input type="file"> 点击
      function pickFile() { fileRef.value && fileRef.value.click(); }
      // 读 JSON 文件 → 校验 → 替换 state → 重新出清
      function onFile(e) {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const s = S.deserialize(rd.result);
            state.network = s.network;
            state.participants = s.participants;
            state.options = s.options || { quadSteps: 120 };
            state.meta = s.meta || state.meta;
            ctx.run();
            ctx.flash('方案已导入并重新出清');
          } catch (err) {
            ctx.flash('导入失败：' + err.message);
          }
        };
        rd.readAsText(f, 'utf-8');
        // 清空 value 以便下次能再次选同名文件
        e.target.value = '';
      }
      // 恢复为默认演示场景（不删 localStorage，仅替换当前 state）
      function doReset() {
        if (!confirm('确定要恢复为默认演示场景吗？当前的全部报价修改将丢失。')) return;
        const d = S.createDefaultState();
        state.network = d.network;
        state.participants = d.participants;
        state.options = d.options;
        state.meta = d.meta;
        ctx.run();
        ctx.flash('已恢复默认场景');
      }
      // 清空 localStorage（仅缓存，不影响当前已加载 state）
      function clearCache() {
        if (!confirm('确定清空本地缓存吗？下次打开将回到默认场景。')) return;
        S.clear();
        ctx.flash('本地缓存已清空');
      }
      return { ctx, state, results, fileRef, doExport, pickFile, onFile, doReset, clearCache, nf, n0 };
    },
    template: `
    <div>
      <div class="page-head">
        <div class="page-title">数据管理</div>
        <div class="page-sub">方案存档与结果导出，便于答辩前保存现场、事后复盘</div>
      </div>

      <div class="grid g2">
        <div class="card">
          <div class="card-head"><span class="card-title">方案存档</span></div>
          <div class="card-body">
            <div class="note" style="margin-bottom:12px">
              导出为 JSON 文件，包含完整网络拓扑、全部市场主体及其 96 时段报价。
              答辩前导出一份，现场手抖改坏了可以一键恢复。
            </div>
            <div class="row">
              <button class="btn btn-primary" @click="doExport">导出方案 JSON</button>
              <button class="btn" @click="pickFile">导入方案 JSON</button>
              <input ref="fileRef" type="file" accept=".json,application/json" class="file-input" @change="onFile">
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">结果导出</span></div>
          <div class="card-body">
            <div class="note" style="margin-bottom:12px">
              导出为 CSV（含 BOM，Excel 双击直接打开不乱码），
              可直接用于课程设计报告的图表制作。
            </div>
            <div class="row">
              <button class="btn" @click="exportCsv">出清结果 CSV</button>
              <button class="btn" @click="exportAward">中标明细 CSV</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">恢复与清理</span></div>
        <div class="card-body">
          <div class="row">
            <button class="btn" @click="doReset">恢复默认演示场景</button>
            <button class="btn" @click="clearCache">清空本地缓存</button>
            <span class="note">报价修改会自动保存在浏览器本地，刷新页面不会丢失。</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">当前数据集</span></div>
        <div class="card-body tight">
          <table>
            <tbody>
              <tr><td style="width:180px;color:#64748b">场景</td><td>{{state.meta.scenario}}</td></tr>
              <tr><td style="color:#64748b">节点 / 线路</td><td>{{state.network.nodes.length}} / {{state.network.lines.length}}</td></tr>
              <tr><td style="color:#64748b">市场主体</td><td>{{state.participants.length}}（发电 {{genCount}} · 用电 {{conCount}}）</td></tr>
              <tr><td style="color:#64748b">时段数</td><td>96（15 分钟一点，覆盖 24 小时）</td></tr>
              <tr><td style="color:#64748b">二次曲线离散段数</td><td>{{state.options.quadSteps}}</td></tr>
              <tr><td style="color:#64748b">网络约束</td><td>{{state.network.enabled?'启用（计算 LMP）':'关闭（统一边际电价）'}}</td></tr>
              <tr><td style="color:#64748b">依赖</td><td>Vue 3 + ECharts 5，已本地化，无需联网</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    computed: {
      // 发电主体数（用于"当前数据集"展示）
      genCount() { return this.state.participants.filter(p => p.side === 'gen').length; },
      // 用电主体数
      conCount() { return this.state.participants.filter(p => p.side === 'con').length; },
    },
    methods: {
      // 导出"出清结果 CSV"：按时段 × 节点 × 线路展开，含 BOM 防 Excel 乱码
      exportCsv() {
        if (!this.results.length) { this.ctx.flash('请先执行出清'); return; }
        S.exportCSV(JSON.parse(JSON.stringify(this.state)), this.results);
        this.ctx.flash('出清结果已导出');
      },
      // 导出"中标明细 CSV"：按时段 × 主体展开，包含申报量、中标量、电价、金额
      exportAward() {
        if (!this.results.length) { this.ctx.flash('请先执行出清'); return; }
        S.exportAwardCSV(JSON.parse(JSON.stringify(this.state)), this.results);
        this.ctx.flash('中标明细已导出');
      },
    },
  };

  /* ---------------------------------------------------------------- 挂载 */
  // 注册 7 个页面组件并挂载到 #app
  createApp(App)
    .component('overview-page', OverviewPage)
    .component('bid-page', BidPage)
    .component('curve-page', CurvePage)
    .component('price-page', PricePage)
    .component('settle-page', SettlePage)
    .component('network-page', NetworkPage)
    .component('data-page', DataPage)
    .mount('#app');
})();
