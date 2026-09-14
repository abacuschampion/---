/* =========================================================================
 * 电力现货市场出清引擎
 *
 * 1. 无约束出清：统一边际价格法（统一出清价 / pay-as-clear）
 *    供给段按报价升序、需求段按报价降序，双指针逐段撮合至边际条件破坏，
 *    末次成交的供给段报价即系统边际电价 SMP。
 *
 * 2. 二次曲线报价：P = a·Q² + b·Q + c，数值离散为细密微段后并入阶梯撮合。
 *
 * 3. 网络约束：直流潮流 PTDF + 再调度法（redispatch）求线路影子价格，
 *    节点边际电价 LMP = 能量分量 + 阻塞分量。
 *
 * 依赖：无。可在浏览器 <script> 或 Node 中直接加载。
 * ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  /* ---------------------------------------------------------------- 工具 */

  const num = (v, d) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : (d === undefined ? 0 : d);
  };
  const round = (v, n) => {
    const f = Math.pow(10, n === undefined ? 4 : n);
    return Math.round((v + Number.EPSILON) * f) / f;
  };

  /* ------------------------------------------- 二次曲线离散为阶梯微段 */
  // P = a·Q² + b·Q + c，Q ∈ [0, qMax] 均分 steps 段，段价取中点函数值
  function quadraticToSegments(coef, qMax, steps) {
    const a = num(coef && coef.a), b = num(coef && coef.b), c = num(coef && coef.c);
    const q = Math.max(0, num(qMax));
    const n = Math.max(1, Math.floor(num(steps, 120)));
    if (q <= 0 || n <= 0) return [];
    const dq = q / n;
    const segs = [];
    for (let i = 1; i <= n; i++) {
      const qMid = (i - 0.5) * dq;
      let price = a * qMid * qMid + b * qMid + c;
      if (price < 0) price = 0;
      segs.push({ power: dq, price: price });
    }
    return segs;
  }

  /* ------------------------------------------- 报价展开为供给/需求增量段 */
  // side: 'gen' -> 供给, 报价应单调非递减; 'con' -> 需求, 报价应单调非递增
  function expandSide(participants, side, quadSteps) {
    const blocks = [];
    for (const p of participants || []) {
      if (p.side !== side || p.enabled === false) continue;
      let segs;
      if (side === 'gen' && p.bidMode === 'quadratic') {
        segs = quadraticToSegments(p.quad, num(p.quad && p.quad.qMax), quadSteps || (p.quad && p.quad.steps) || 120);
      } else {
        segs = p.segments || [];
      }
      for (const s of segs) {
        const power = num(s.power);
        if (power <= EPS) continue;
        blocks.push({
          owner: p.id,
          name: p.name,
          node: p.node,
          power: power,
          price: Math.max(0, num(s.price))
        });
      }
    }
    if (side === 'gen') {
      // 经济调度序：低价优先；同价按主体标识稳定排序
      blocks.sort((x, y) => (x.price - y.price) || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
    } else {
      // 需求侧：高价优先（愿意付更多的先成交）
      blocks.sort((x, y) => (y.price - x.price) || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
    }
    return blocks;
  }

  /* ------------------------------------------- 由有序增量段生成阶梯曲线点 */
  // 返回 [[q, price], ...]，相邻点之间形成"水平 + 垂直"的阶梯折线
  function stepCurve(sortedBlocks) {
    const pts = [];
    let cum = 0;
    for (const b of sortedBlocks) {
      if (b.power <= EPS) continue;
      pts.push([round(cum, 6), round(b.price, 4)]);
      cum += b.power;
      pts.push([round(cum, 6), round(b.price, 4)]);
    }
    return pts;
  }

  /* ------------------------------------------- 无约束统一边际价格出清 */
  // genBlocks 需已按价格升序，conBlocks 需已按价格降序
  function clearUnconstrained(genBlocks, conBlocks) {
    const supply = genBlocks.map(b => ({ ...b }));
    const demand = conBlocks.map(b => ({ ...b }));

    const genAward = {};   // ownerId -> 中标 MW
    const conAward = {};
    let qty = 0, price = 0, matched = false;

    let i = 0, j = 0;
    while (i < supply.length && j < demand.length) {
      // 边际条件：最低未成交供给价 > 最高未成交需求价 => 无更多互利交易
      if (supply[i].price > demand[j].price + EPS) break;
      const deal = Math.min(supply[i].power, demand[j].power);
      if (deal <= EPS) break;

      genAward[supply[i].owner] = (genAward[supply[i].owner] || 0) + deal;
      conAward[demand[j].owner] = (conAward[demand[j].owner] || 0) + deal;
      qty += deal;
      price = supply[i].price;   // 边际机组报价 = 系统边际电价
      matched = true;

      supply[i].power -= deal;
      demand[j].power -= deal;
      if (supply[i].power <= EPS) i++;
      if (demand[j].power <= EPS) j++;
    }

    return {
      qty: round(qty, 6),
      price: matched ? round(price, 4) : 0,
      matched: matched,
      genAward, conAward
    };
  }

  /* ---------------------------------------------------------------- 矩阵 */
  function zeros(r, c) {
    const a = [];
    for (let i = 0; i < r; i++) a.push(new Array(c).fill(0));
    return a;
  }

  // 高斯-约当消元求逆；奇异返回 null
  function invertMatrix(A) {
    const n = A.length;
    if (n === 0) return [];
    const M = A.map((row, i) => {
      const r = row.slice();
      for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
      return r;
    });
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) {
        if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      }
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const d = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (!f) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map(r => r.slice(n));
  }

  /* ------------------------------------------- 直流潮流 PTDF */
  // nodes: [{id}]; lines: [{from,to,x}]; slackId: 平衡节点 id
  // 返回 {ptdf: number[lineIdx][nodeIdx], nodeIndex: {id: idx}} 或 null（网络不连通/奇异）
  function computePTDF(nodes, lines, slackId) {
    const ids = (nodes || []).map(n => n.id);
    const N = ids.length;
    if (N === 0) return null;
    const nodeIndex = {};
    ids.forEach((id, i) => { nodeIndex[id] = i; });

    const slack = ids.indexOf(slackId);
    const keep = ids.filter(id => id !== slackId);
    const M = keep.length;
    if (M === 0) return null;

    // 降阶节点电纳矩阵 B'（去掉平衡节点）
    const B = zeros(M, M);
    for (const l of lines || []) {
      const x = num(l.x);
      if (x <= EPS) continue;
      const b = 1 / x;
      const fi = keep.indexOf(l.from);
      const ti = keep.indexOf(l.to);
      if (fi >= 0 && ti >= 0) {
        B[fi][fi] += b; B[ti][ti] += b;
        B[fi][ti] -= b; B[ti][fi] -= b;
      } else if (fi >= 0) {
        B[fi][fi] += b;
      } else if (ti >= 0) {
        B[ti][ti] += b;
      }
    }
    const Xr = invertMatrix(B);
    if (!Xr) return null;

    // 扩展为全阶 X（平衡节点行列置零）
    const X = zeros(N, N);
    for (let r = 0; r < M; r++) {
      const ri = nodeIndex[keep[r]];
      for (let c = 0; c < M; c++) {
        const ci = nodeIndex[keep[c]];
        X[ri][ci] = Xr[r][c];
      }
    }
    if (slack >= 0) {
      for (let i = 0; i < N; i++) { X[slack][i] = 0; X[i][slack] = 0; }
    }

    // PTDF[l][n] = (X[from][n] - X[to][n]) / x_l
    const ptdf = [];
    for (const l of lines || []) {
      const x = num(l.x);
      const row = new Array(N).fill(0);
      const f = nodeIndex[l.from];
      const t = nodeIndex[l.to];
      if (x > EPS && f !== undefined && t !== undefined) {
        for (let n = 0; n < N; n++) row[n] = (X[f][n] - X[t][n]) / x;
      }
      ptdf.push(row);
    }
    return { ptdf, nodeIndex, ids };
  }

  /* ------------------------------------------- 节点净注入与线路潮流 */
  function nodeInjection(nodes, genBlocks, conBlocks, genAward, conAward) {
    const inj = {};
    for (const n of nodes) inj[n.id] = 0;
    // 注入 = 该节点发电中标 - 该节点用电中标
    const nodeOf = {};
    for (const b of genBlocks) nodeOf[b.owner] = b.node;
    for (const b of conBlocks) nodeOf[b.owner] = b.node;
    for (const id in genAward) {
      const nd = nodeOf[id];
      if (nd !== undefined && inj[nd] !== undefined) inj[nd] += genAward[id];
    }
    for (const id in conAward) {
      const nd = nodeOf[id];
      if (nd !== undefined && inj[nd] !== undefined) inj[nd] -= conAward[id];
    }
    return inj;
  }

  function lineFlows(net, ptdf, inj) {
    const flows = [];
    (net.lines || []).forEach((l, li) => {
      let f = 0;
      const row = ptdf[li] || [];
      (net.nodes || []).forEach((n, ni) => { f += (row[ni] || 0) * (inj[n.id] || 0); });
      flows.push(f);
    });
    return flows;
  }

  /* ------------------------------------------- 机组边际/增量价格 */
  // 按经济调度序累加某主体的段，返回 {blocks:[{power,price,cumBefore}], total}
  function ownerStack(blocks, owner) {
    const own = [];
    let cum = 0;
    for (const b of blocks) {
      if (b.owner !== owner) continue;
      own.push({ power: b.power, price: b.price, cumBefore: cum });
      cum += b.power;
    }
    return { blocks: own, total: cum };
  }

  // 已出力 awarded 时，正在运行的边际段报价（用于"下调"机组）
  function marginalPrice(stack, awarded) {
    if (!stack.blocks.length) return null;
    if (awarded <= EPS) return stack.blocks[0].price;
    for (let i = stack.blocks.length - 1; i >= 0; i--) {
      const b = stack.blocks[i];
      if (awarded > b.cumBefore + EPS) return b.price;
    }
    return stack.blocks[0].price;
  }

  // 已出力 awarded 时，下一段可增出力的报价（用于"上调"机组）；无余量返回 null
  function incrementalPrice(stack, awarded) {
    for (const b of stack.blocks) {
      if (b.cumBefore + b.power > awarded + EPS) {
        // 该段尚有未调用容量
        return b.price;
      }
    }
    return null;
  }

  /* ------------------------------------------- 阻塞再调度，求 LMP */
  // input:
  //   net         {nodes, lines, slackId, enabled}
  //   genBlocks   经济调度序供给段（含 node）
  //   conBlocks   需求段（含 node）
  //   base        无约束出清结果 {qty, price, genAward, conAward}
  // 返回 {lmp:{nodeId:price}, energy, congestion:{nodeId:price}, flows, mu, congested,
  //       redispatchCost, rent, infeasible}
  function solveLMP(net, genBlocks, conBlocks, base) {
    const nodes = net.nodes || [];
    const energy = base.price;

    // 无网络或关闭阻塞 -> 全网统一价
    const ptdfRes = (net.enabled === false) ? null : computePTDF(nodes, net.lines || [], net.slackId);
    if (!ptdfRes) {
      const lmp = {}, cong = {};
      for (const n of nodes) { lmp[n.id] = energy; cong[n.id] = 0; }
      return {
        lmp, energy, congestion: cong, flows: (net.lines || []).map(() => 0),
        mu: (net.lines || []).map(() => 0), congested: false,
        redispatchCost: 0, rent: 0, infeasible: false, ptdf: null
      };
    }

    const { ptdf, nodeIndex } = ptdfRes;
    const genAward = { ...base.genAward };
    const conAward = base.conAward;

    // 各机组按经济调度序的容量栈
    const stacks = {};
    for (const b of genBlocks) {
      if (stacks[b.owner]) continue;
      const st = ownerStack(genBlocks, b.owner);
      st.node = b.node;
      stacks[b.owner] = st;
    }

    const mu = (net.lines || []).map(() => 0);
    const muSign = (net.lines || []).map(() => 0);   // 各线路约束的 Binding 方向 s
    let redispatchCost = 0;
    let congested = false;
    let infeasible = false;
    const TOL = 1e-6;

    for (let iter = 0; iter < 60; iter++) {
      const inj = nodeInjection(nodes, genBlocks, conBlocks, genAward, conAward);
      const flows = lineFlows(net, ptdf, inj);

      // 找越限最严重的线路
      let worst = -1, worstOver = 0;
      (net.lines || []).forEach((l, li) => {
        const cap = num(l.cap);
        const over = Math.abs(flows[li]) - cap;
        if (over > worstOver && over > TOL) { worstOver = over; worst = li; }
      });
      if (worst < 0) break;
      congested = true;

      const l = net.lines[worst];
      const s = flows[worst] >= 0 ? 1 : -1;      // 越限方向
      const row = ptdf[worst] || [];

      // 灵敏度 σ_g = s · PTDF[line][node(g)]
      const sigmaOf = (ownerId) => {
        const nd = stacks[ownerId] ? stacks[ownerId].node : null;
        const ni = (nd !== null && nd !== undefined) ? nodeIndex[nd] : undefined;
        return (ni === undefined) ? 0 : s * (row[ni] || 0);
      };

      // 候选：可下调机组（已中标，σ 大者优先缓解越限）
      const downs = [], ups = [];
      for (const ownerId in stacks) {
        const st = stacks[ownerId];
        const awarded = genAward[ownerId] || 0;
        const sig = sigmaOf(ownerId);
        if (awarded > TOL) {
          const pd = marginalPrice(st, awarded);
          if (pd !== null) downs.push({ owner: ownerId, sig, price: pd, room: awarded });
        }
        const pu = incrementalPrice(st, awarded);
        if (pu !== null) ups.push({ owner: ownerId, sig, price: pu, room: st.total - awarded });
      }

      // 选"单位潮流缓解成本"最小的机组对 —— 这一步等价于对阻塞约束做一次单纯形换基
      let best = null;
      for (const d of downs) {
        for (const u of ups) {
          if (u.owner === d.owner) continue;
          const sens = d.sig - u.sig;            // 每 MW 再调度可缓解的越限量
          if (sens <= TOL) continue;
          const ratio = (u.price - d.price) / sens;   // 影子价格候选
          if (!best || ratio < best.ratio) best = { d, u, sens, ratio };
        }
      }
      if (!best) { infeasible = true; break; }

      const dP = Math.min(best.d.room, best.u.room, worstOver / best.sens);
      if (dP <= TOL) { infeasible = true; break; }

      genAward[best.d.owner] -= dP;
      genAward[best.u.owner] += dP;
      redispatchCost += (best.u.price - best.d.price) * dP;
      mu[worst] = Math.max(0, best.ratio);   // 该约束的边际缓解成本 = 影子价格
      muSign[worst] = s;
    }

    // 注入 -> 最终潮流
    const injFinal = nodeInjection(nodes, genBlocks, conBlocks, genAward, conAward);
    const flows = lineFlows(net, ptdf, injFinal);

    // ---- 能量分量 λ ----
    // 再调度后，仍处"部分出力"（既不空载也未满发）的机组满足 KKT 驻点条件：
    //     c_g - λ + Σ_l μ_l · s_l · PTDF[l][node_g] = 0
    // 由此反解 λ。无内部解时退化为无约束系统边际电价。
    const lambdaCandidates = [];
    for (const ownerId in stacks) {
      const st = stacks[ownerId];
      const a = genAward[ownerId] || 0;
      if (a <= TOL || a >= st.total - TOL) continue;   // 仅取严格内部解
      const c = marginalPrice(st, a);
      if (c === null) continue;
      let adj = 0;
      (net.lines || []).forEach((l, li) => {
        if (mu[li] <= 0) return;
        const ni = nodeIndex[st.node];
        if (ni === undefined) return;
        adj += mu[li] * muSign[li] * ((ptdf[li] || [])[ni] || 0);
      });
      lambdaCandidates.push(c + adj);
    }
    const lambda = lambdaCandidates.length
      ? lambdaCandidates.reduce((s, v) => s + v, 0) / lambdaCandidates.length
      : energy;

    // ---- 节点电价 LMP ----
    // 由包络定理，节点 n 增加单位负荷的边际成本：
    //     LMP_n = λ - Σ_l μ_l · s_l · PTDF[l][n]
    // 送端（低价电源外送受阻）阻塞分量为负、受端为正，与物理直觉一致。
    const lmp = {}, cong = {};
    for (const n of nodes) {
      const ni = nodeIndex[n.id];
      let c = 0;
      (net.lines || []).forEach((l, li) => {
        if (mu[li] <= 0) return;
        if (ni === undefined) return;
        c -= mu[li] * muSign[li] * ((ptdf[li] || [])[ni] || 0);
      });
      cong[n.id] = round(c, 4);
      lmp[n.id] = round(lambda + c, 4);
    }

    // 阻塞盈余 = Σ 用电支出 - Σ 发电收入（按 LMP 结算，理论上 ≥ 0）
    let pay = 0, recv = 0;
    const nodeOf = {};
    for (const b of genBlocks) nodeOf[b.owner] = b.node;
    for (const b of conBlocks) nodeOf[b.owner] = b.node;
    for (const id in conAward) {
      const nd = nodeOf[id];
      pay += conAward[id] * (lmp[nd] !== undefined ? lmp[nd] : energy);
    }
    for (const id in genAward) {
      const nd = nodeOf[id];
      recv += genAward[id] * (lmp[nd] !== undefined ? lmp[nd] : energy);
    }

    return {
      lmp, energy: round(lambda, 4), congestion: cong,
      flows: flows.map(f => round(f, 4)), mu: mu.map(m => round(m, 4)),
      congested, redispatchCost: round(redispatchCost, 4),
      rent: round(pay - recv, 4), infeasible,
      ptdf: { matrix: ptdf, nodeIndex },
      finalAward: genAward
    };
  }

  /* ------------------------------------------- 单时段完整出清 */
  // input:
  //   participants 全部市场主体（含 side / node / bidMode / segments / quad）
  //   net          {nodes, lines, slackId, enabled}
  //   opts         {quadSteps}
  // 返回该时段的出清、曲线、LMP 与结算明细
  function runPeriod(participants, net, opts) {
    opts = opts || {};
    const genBlocks = expandSide(participants, 'gen', opts.quadSteps);
    const conBlocks = expandSide(participants, 'con', opts.quadSteps);

    const supplyCurve = stepCurve(genBlocks);
    const demandCurve = stepCurve(conBlocks);

    if (!genBlocks.length || !conBlocks.length) {
      const lmp = {};
      for (const n of (net && net.nodes) || []) lmp[n.id] = 0;
      return {
        ok: false,
        message: !genBlocks.length && !conBlocks.length ? '无发用电侧申报数据'
          : (!genBlocks.length ? '无发电侧申报数据' : '无用电侧申报数据'),
        qty: 0, price: 0, energy: 0, lmp, congestion: {},
        supplyCurve, demandCurve, genAward: {}, conAward: {},
        genDetail: [], conDetail: [], flows: [], mu: [],
        congested: false, redispatchCost: 0, rent: 0, infeasible: false
      };
    }

    const base = clearUnconstrained(genBlocks, conBlocks);
    const lmpRes = solveLMP(net || { nodes: [], lines: [] }, genBlocks, conBlocks, base);

    const genAward = lmpRes.finalAward || base.genAward;
    const conAward = base.conAward;

    // 主体维度明细（申报量 / 中标量 / 结算）
    const genDetail = [];
    for (const p of participants) {
      if (p.side !== 'gen' || p.enabled === false) continue;
      const st = ownerStack(genBlocks, p.id);
      const awarded = genAward[p.id] || 0;
      const px = lmpRes.lmp[p.node] !== undefined ? lmpRes.lmp[p.node] : lmpRes.energy;
      genDetail.push({
        id: p.id, name: p.name, node: p.node,
        bidQty: round(st.total, 4),
        awarded: round(awarded, 4),
        price: round(px, 4),
        income: round(awarded * px, 2),
        mode: p.bidMode || 'step'
      });
    }
    const conDetail = [];
    for (const p of participants) {
      if (p.side !== 'con' || p.enabled === false) continue;
      const st = ownerStack(conBlocks, p.id);
      const awarded = conAward[p.id] || 0;
      const px = lmpRes.lmp[p.node] !== undefined ? lmpRes.lmp[p.node] : lmpRes.energy;
      conDetail.push({
        id: p.id, name: p.name, node: p.node,
        bidQty: round(st.total, 4),
        awarded: round(awarded, 4),
        price: round(px, 4),
        payment: round(awarded * px, 2)
      });
    }

    const totalGenIncome = genDetail.reduce((s, d) => s + d.income, 0);
    const totalConPayment = conDetail.reduce((s, d) => s + d.payment, 0);

    return {
      ok: true,
      message: '',
      qty: base.qty,
      price: base.price,
      matched: base.matched,
      energy: lmpRes.energy,
      lmp: lmpRes.lmp,
      congestion: lmpRes.congestion,
      supplyCurve, demandCurve,
      genAward, conAward,
      genDetail, conDetail,
      flows: lmpRes.flows, mu: lmpRes.mu, ptdf: lmpRes.ptdf,
      congested: lmpRes.congested,
      redispatchCost: lmpRes.redispatchCost,
      rent: lmpRes.rent,
      infeasible: lmpRes.infeasible,
      totalGenIncome: round(totalGenIncome, 2),
      totalConPayment: round(totalConPayment, 2)
    };
  }

  /* ------------------------------------------- 报价合法性校验 */
  function validateBid(p) {
    const errs = [];
    if (!p) return ['数据为空'];
    if (p.side === 'gen' && p.bidMode === 'quadratic') {
      const q = p.quad || {};
      if (!Number.isFinite(parseFloat(q.qMax)) || parseFloat(q.qMax) <= 0) errs.push('二次曲线报价缺少有效的最大出力 qMax');
      if (!Number.isFinite(parseFloat(q.a)) || !Number.isFinite(parseFloat(q.b)) || !Number.isFinite(parseFloat(q.c))) {
        errs.push('二次曲线系数 a / b / c 必须为数值');
      }
      return errs;
    }
    const segs = p.segments || [];
    if (!segs.length) { errs.push('未填写任何报价段'); return errs; }
    if (segs.length > 10) errs.push('报价段数不得超过 10 段');
    // 每段 power 是"增量"而非累计出力，故不要求电力单调；只约束电价单调性
    for (let i = 0; i < segs.length; i++) {
      const pw = parseFloat(segs[i].power);
      const pr = parseFloat(segs[i].price);
      if (!Number.isFinite(pw) || pw <= 0) { errs.push(`第 ${i + 1} 段电力必须为正数`); continue; }
      if (!Number.isFinite(pr) || pr < 0) { errs.push(`第 ${i + 1} 段电价不能为负`); continue; }
      if (i > 0) {
        const cpr = parseFloat(segs[i - 1].price);
        if (p.side === 'gen' && pr < cpr) errs.push(`发电侧第 ${i + 1} 段电价需不低于前一段（单调非递减）`);
        if (p.side === 'con' && pr > cpr) errs.push(`用电侧第 ${i + 1} 段电价需不高于前一段（单调非递增）`);
      }
    }
    return errs;
  }

  return {
    EPS, num, round,
    quadraticToSegments,
    expandSide,
    stepCurve,
    clearUnconstrained,
    invertMatrix,
    computePTDF,
    nodeInjection,
    lineFlows,
    solveLMP,
    runPeriod,
    validateBid
  };
});
