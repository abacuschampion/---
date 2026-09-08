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
  // 将连续报价曲线 P = a·Q² + b·Q + c 在 Q ∈ [0, qMax] 上均分为 steps 段，
  // 每段段价取中点函数值。等价于把"曲线报价"折成"阶梯报价"，从而能并入同一撮合流程。
  // 注意：段电力是"增量"，撮合时按增量累加 —— 与"累计出力 + 当前段价"的阶梯曲线等价。
  function quadraticToSegments(coef, qMax, steps) {
    const a = num(coef && coef.a), b = num(coef && coef.b), c = num(coef && coef.c);
    const q = Math.max(0, num(qMax));
    const n = Math.max(1, Math.floor(num(steps, 120)));   // 至少 1 段，默认 120 段
    if (q <= 0 || n <= 0) return [];
    const dq = q / n;
    const segs = [];
    for (let i = 1; i <= n; i++) {
      const qMid = (i - 0.5) * dq;
      let price = a * qMid * qMid + b * qMid + c;
      if (price < 0) price = 0;   // 价格不允许为负，避免无意义负报价
      segs.push({ power: dq, price: price });
    }
    return segs;
  }

  /* ------------------------------------------- 报价展开为供给/需求增量段 */
  // 把任意主体的报价展开为统一的"增量段"结构 {owner, name, node, power, price}
  // side: 'gen' 供给 / 'con' 需求
  // 对阶梯报价直接复用 segments；对二次曲线报价则按 quadSteps 离散。
  function expandSide(participants, side, quadSteps) {
    const blocks = [];
    for (const p of participants || []) {
      if (p.side !== side || p.enabled === false) continue;   // 停用主体不参与出清
      let segs;
      if (side === 'gen' && p.bidMode === 'quadratic') {
        // 二次曲线报价仅发电侧支持（用电侧按申报量 = 阶梯段电量更直观）
        segs = quadraticToSegments(p.quad, num(p.quad && p.quad.qMax), quadSteps || (p.quad && p.quad.steps) || 120);
      } else {
        segs = p.segments || [];
      }
      for (const s of segs) {
        const power = num(s.power);
        if (power <= EPS) continue;   // 0 容量段不参与撮合
        blocks.push({
          owner: p.id,
          name: p.name,
          node: p.node,            // 所属节点，用于 LMP 计算时的节点注入
          power: power,
          price: Math.max(0, num(s.price))   // 价格不允许为负
        });
      }
    }
    if (side === 'gen') {
      // 经济调度序：低价优先（同价按主体 id 稳定排序，避免跨平台 sort 不稳定）
      blocks.sort((x, y) => (x.price - y.price) || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
    } else {
      // 需求侧：高价优先（愿意付更多的先成交）
      blocks.sort((x, y) => (y.price - x.price) || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
    }
    return blocks;
  }

  /* ------------------------------------------- 由有序增量段生成阶梯曲线点 */
  // 返回 [[q, price], ...]，相邻两点之间形成"先垂直、再水平"的阶梯折线
  // 用途：ECharts 用 step: 'end' 画阶梯曲线时直接喂这组点即可。
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
  // pay-as-clear 撮合算法：
  //   genBlocks 按价格升序、conBlocks 按价格降序；
  //   双指针逐段撮合："最低未成交供给价 ≤ 最高未成交需求价" 即成交，
  //   成交量取两者剩余量的较小值，末次成交的供给段报价即 SMP。
  //   一旦供给价 > 需求价，边际条件破坏，撮合停止 —— 此时的累计成交量即出清电量。
  //
  // 注：本实现采用"逐段撮合"而非"沿累计电量扫描阶梯曲线找交点"。
  //   后者在边际段部分成交时会多算电量（例：Qt 版示例数据正确解为 470 MW / 260 元，
  //   断点扫描法会给出 520 MW，多出 50 MW 无人愿意按该价购买）。
  function clearUnconstrained(genBlocks, conBlocks) {
    const supply = genBlocks.map(b => ({ ...b }));   // 拷贝，避免破坏调用方原数组的 power
    const demand = conBlocks.map(b => ({ ...b }));

    const genAward = {};   // ownerId -> 中标 MW
    const conAward = {};
    let qty = 0, price = 0, matched = false;

    let i = 0, j = 0;
    while (i < supply.length && j < demand.length) {
      // 边际条件破坏检测：留 EPS 容差避免浮点误差误判
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
  // r×c 零矩阵
  function zeros(r, c) {
    const a = [];
    for (let i = 0; i < r; i++) a.push(new Array(c).fill(0));
    return a;
  }

  // 高斯-约当消元求逆；矩阵奇异返回 null（网络不连通 / 节点电纳矩阵不满秩）
  // 算法：构造增广矩阵 [A | I]，通过初等行变换把左侧化为单位阵，右侧即为 A⁻¹
  function invertMatrix(A) {
    const n = A.length;
    if (n === 0) return [];
    const M = A.map((row, i) => {
      const r = row.slice();
      for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);   // 增广为单位阵
      return r;
    });
    for (let c = 0; c < n; c++) {
      // 列主元选取：选绝对值最大者以减小数值误差
      let piv = c;
      for (let r = c + 1; r < n; r++) {
        if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      }
      if (Math.abs(M[piv][c]) < 1e-12) return null;   // 奇异，矩阵无逆
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const d = M[c][c];
      // 当前行归一
      for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      // 消其他行
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (!f) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map(r => r.slice(n));   // 取右半部分即逆矩阵
  }

  /* ------------------------------------------- 直流潮流 PTDF */
  // 节点功率传输分布因子（Power Transfer Distribution Factor）：
  //   PTDF[l][n] = 节点 n 单位注入在线路 l 上引起的潮流比例（线性近似，直流潮流假设）。
  // 算法：
  //   1. 由线路电抗 1/x 构造降阶节点电纳矩阵 B′（去掉平衡节点行/列）；
  //   2. 求逆得 X = B′⁻¹（节点电抗矩阵，元素含义为两节点间的等效电抗）；
  //   3. PTDF[l][n] = (X[from][n] − X[to][n]) / x_l，对平衡节点行/列填零。
  //
  // 返回 {ptdf: number[lineIdx][nodeIdx], nodeIndex: {id: idx}, ids}
  // 或 null（节点数 < 2 / 矩阵奇异 —— 即网络不连通或缺少平衡节点）
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
  // 输入：
  //   net         {nodes, lines, slackId, enabled}
  //   genBlocks   经济调度序供给段（含 node）
  //   conBlocks   需求段（含 node）
  //   base        无约束出清结果 {qty, price, genAward, conAward}
  // 返回 {lmp, energy, congestion, flows, mu, congested,
  //       redispatchCost, rent, infeasible, ptdf, finalAward}
  //
  // 算法：迭代找越限最严重的线路，挑"单位潮流缓解成本"最小的机组对做再调度，
  //       直到所有线路 |f| ≤ cap 或无可行解（再调度也无法缓解）。
  function solveLMP(net, genBlocks, conBlocks, base) {
    const nodes = net.nodes || [];
    const energy = base.price;

    // 无网络或关闭阻塞 → 全网统一价，所有节点 LMP = energy
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
    const genAward = { ...base.genAward };   // 复制一份再调度，避免污染基态
    const conAward = base.conAward;

    // 各机组按经济调度序的"容量栈"，便于后续求边际价 / 增量价
    const stacks = {};
    for (const b of genBlocks) {
      if (stacks[b.owner]) continue;
      const st = ownerStack(genBlocks, b.owner);
      st.node = b.node;
      stacks[b.owner] = st;
    }

    const mu = (net.lines || []).map(() => 0);
    const muSign = (net.lines || []).map(() => 0);   // 各线路约束 binding 方向 s
    let redispatchCost = 0;
    let congested = false;
    let infeasible = false;
    const TOL = 1e-6;

    for (let iter = 0; iter < 60; iter++) {   // 最多 60 次迭代，避免极端情况下死循环
      const inj = nodeInjection(nodes, genBlocks, conBlocks, genAward, conAward);
      const flows = lineFlows(net, ptdf, inj);

      // 找越限最严重的线路（容忍 TOL，避免浮点噪声触发再调度）
      let worst = -1, worstOver = 0;
      (net.lines || []).forEach((l, li) => {
        const cap = num(l.cap);
        const over = Math.abs(flows[li]) - cap;
        if (over > worstOver && over > TOL) { worstOver = over; worst = li; }
      });
      if (worst < 0) break;   // 全部线路已回落到限值内，出清完成
      congested = true;

      const l = net.lines[worst];
      const s = flows[worst] >= 0 ? 1 : -1;      // 越限方向
      const row = ptdf[worst] || [];

      // 灵敏度 σ_g = s · PTDF[line][node(g)]：
      //   表示该机组增减单位出力在线路上的潮流变化方向与幅度
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
          const pd = marginalPrice(st, awarded);   // 下调一档的成本 = 边际段价
          if (pd !== null) downs.push({ owner: ownerId, sig, price: pd, room: awarded });
        }
        const pu = incrementalPrice(st, awarded);  // 上调一档的成本 = 下一段价
        if (pu !== null) ups.push({ owner: ownerId, sig, price: pu, room: st.total - awarded });
      }

      // 选"单位潮流缓解成本"最小的机组对 —— 等价于对阻塞约束做一次单纯形换基
      let best = null;
      for (const d of downs) {
        for (const u of ups) {
          if (u.owner === d.owner) continue;       // 同一机组不能既上又下
          const sens = d.sig - u.sig;              // 每 MW 再调度可缓解的越限量
          if (sens <= TOL) continue;
          const ratio = (u.price - d.price) / sens;   // 单位缓解成本 → 影子价格候选
          if (!best || ratio < best.ratio) best = { d, u, sens, ratio };
        }
      }
      if (!best) { infeasible = true; break; }      // 找不到可缓解越限的机组对

      // 实际再调度量 = min(下调空间, 上调空间, 解除越限所需量)
      const dP = Math.min(best.d.room, best.u.room, worstOver / best.sens);
      if (dP <= TOL) { infeasible = true; break; }

      genAward[best.d.owner] -= dP;
      genAward[best.u.owner] += dP;
      redispatchCost += (best.u.price - best.d.price) * dP;
      mu[worst] = Math.max(0, best.ratio);          // 该约束的影子价格 = 单位缓解成本
      muSign[worst] = s;
    }

    // 注入 → 最终潮流（再调度后）
    const injFinal = nodeInjection(nodes, genBlocks, conBlocks, genAward, conAward);
    const flows = lineFlows(net, ptdf, injFinal);

    // ---- 能量分量 λ ----
    // 再调度后，仍处"部分出力"（既不空载也未满发）的机组满足 KKT 驻点条件：
    //     c_g − λ + Σ_l μ_l · s_l · PTDF[l][node_g] = 0
    // 由此反解 λ：λ = c_g + Σ_l μ_l · s_l · PTDF[l][node_g]
    // 取所有"内部解"机组的 λ 平均作为系统能量分量；无内部解时退化为无约束系统边际电价。
    const lambdaCandidates = [];
    for (const ownerId in stacks) {
      const st = stacks[ownerId];
      const a = genAward[ownerId] || 0;
      if (a <= TOL || a >= st.total - TOL) continue;   // 仅取严格内部解（既非空载也非满发）
      const c = marginalPrice(st, a);
      if (c === null) continue;
      let adj = 0;
      (net.lines || []).forEach((l, li) => {
        if (mu[li] <= 0) return;   // 未 binding 的约束对 λ 无影响
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
    //     LMP_n = λ − Σ_l μ_l · s_l · PTDF[l][n]
    // 送端（低价电源外送受阻）阻塞分量为负（电价被压低）、
    // 受端（负荷中心需就地调用高价机组）阻塞分量为正（电价被抬高）。
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

    // 阻塞盈余 = Σ 用电支出 − Σ 发电收入（按 LMP 结算，理论上 ≥ 0）
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
  // 输入：
  //   participants  全部市场主体（含 side / node / bidMode / segments / quad）
  //   net           {nodes, lines, slackId, enabled}
  //   opts          {quadSteps}
  // 返回该时段的出清、阶梯曲线、LMP、主体维度结算明细
  //
  // 流程：展开报价 → 阶梯曲线 → 无约束出清 → 阻塞再调度/LMP → 主体维度结算
  function runPeriod(participants, net, opts) {
    opts = opts || {};
    const genBlocks = expandSide(participants, 'gen', opts.quadSteps);
    const conBlocks = expandSide(participants, 'con', opts.quadSteps);

    // 阶梯曲线数据，供"供需曲线"页直接画 ECharts step: 'end'
    const supplyCurve = stepCurve(genBlocks);
    const demandCurve = stepCurve(conBlocks);

    // 边界条件：缺少发/用电侧申报时直接返回错误结果，避免下游调用崩溃
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

    // 主体维度明细：申报量 / 中标量 / 结算电价（按所在节点 LMP）/ 收支
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
  // 校验报价是否满足：电力正、电价非负、电价单调性（发电非递减 / 用电非递增）、
  // 段数不超过 10 段、二次曲线必须给出 a/b/c/qMax。
  // 返回错误信息数组（空数组代表通过）。
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
