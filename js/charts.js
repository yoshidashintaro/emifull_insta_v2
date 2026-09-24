// Chart.js の共通設定とグラフ生成。色はすべて CSS 変数（トークン）から読む。
const Chart = window.Chart;
const registry = new Map();

export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    surface: v('--surface-1'),
    text: v('--text-primary'),
    text2: v('--text-secondary'),
    muted: v('--text-muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    border: v('--border'),
    s1: v('--series-1'),
    s2: v('--series-2'),
    s3: v('--series-3'),
    neg: v('--series-neg'),
    dark: document.documentElement.dataset.resolvedTheme === 'dark',
  };
}

export function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const fmtInt = (v) => (v === null || v === undefined ? '–' : Math.round(v).toLocaleString('ja-JP'));
export const fmtPct = (v, d = 2) => (v === null || v === undefined ? '–' : `${v.toFixed(d)}%`);
export const fmtCompact = (v) =>
  v === null || v === undefined
    ? '–'
    : Math.abs(v) >= 10000
      ? `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}万`
      : Math.round(v).toLocaleString('ja-JP');

// 折れ線用：ポインタ位置の X に縦のヘアラインを引く
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.();
    if (!active?.length || chart.config.options.plugins.crosshair === false) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = tokens().axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

let configured = false;
function setup() {
  if (configured) return;
  configured = true;
  Chart.register(crosshair);
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.animation.duration = 250;
  Chart.defaults.maintainAspectRatio = false;
}

function baseOptions(t, { legend = false, crosshairOn = false } = {}) {
  return {
    responsive: true,
    interaction: { mode: crosshairOn ? 'index' : 'nearest', intersect: !crosshairOn, axis: 'x' },
    layout: { padding: { top: 4, right: 8 } },
    plugins: {
      crosshair: crosshairOn,
      legend: {
        display: legend,
        position: 'top',
        align: 'start',
        labels: { color: t.text2, usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 14 },
      },
      tooltip: {
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        titleColor: t.text2,
        titleFont: { weight: 'normal' },
        bodyColor: t.text,
        bodyFont: { weight: '600' },
        padding: 10,
        cornerRadius: 8,
        usePointStyle: true,
        boxWidth: 14,
        boxHeight: 2,
        callbacks: {
          labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
          labelColor: (ctx) => ({ borderColor: ctx.dataset.borderColor, backgroundColor: ctx.dataset.borderColor, borderWidth: 2 }),
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: t.axis },
        ticks: { color: t.muted, maxRotation: 0, autoSkipPadding: 16 },
      },
      y: {
        grid: { color: t.grid, lineWidth: 1 },
        border: { display: false },
        ticks: { color: t.muted, padding: 6, callback: (v) => fmtCompact(v) },
      },
    },
  };
}

function mount(id, config) {
  setup();
  registry.get(id)?.destroy();
  const canvas = document.getElementById(id);
  const chart = new Chart(canvas, config);
  registry.set(id, chart);
  return chart;
}

export function getChart(id) {
  return registry.get(id);
}

const shortDate = (key) => {
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
};

// ---------- 各グラフ ----------

export function followerLine(id, daily) {
  const t = tokens();
  const rows = daily.filter((d) => d.followers !== null);
  const opts = baseOptions(t, { crosshairOn: true });
  opts.scales.y.grace = '5%';
  opts.scales.y.beginAtZero = false;
  opts.plugins.tooltip.callbacks.title = (items) => rows[items[0].dataIndex].date;
  opts.plugins.tooltip.callbacks.label = (ctx) => `${fmtInt(ctx.parsed.y)}人  フォロワー数`;
  return mount(id, {
    type: 'line',
    data: {
      labels: rows.map((d) => shortDate(d.date)),
      datasets: [
        {
          label: 'フォロワー数',
          data: rows.map((d) => d.followers),
          borderColor: t.s1,
          backgroundColor: alpha(t.s1, 0.1),
          fill: 'start',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: t.surface,
          pointHoverBackgroundColor: t.s1,
          tension: 0.25,
        },
      ],
    },
    options: opts,
  });
}

export function netChangeBars(id, daily, label) {
  const t = tokens();
  const rows = daily.filter((d) => d.netChange !== null);
  const opts = baseOptions(t);
  opts.interaction = { mode: 'index', intersect: false, axis: 'x' };
  opts.plugins.tooltip.callbacks.title = (items) => rows[items[0].dataIndex].date;
  opts.plugins.tooltip.callbacks.label = (ctx) => `${ctx.parsed.y > 0 ? '+' : ''}${fmtInt(ctx.parsed.y)}人  ${label}`;
  opts.plugins.tooltip.callbacks.labelColor = (ctx) => {
    const c = ctx.parsed.y < 0 ? t.neg : t.s1;
    return { borderColor: c, backgroundColor: c, borderWidth: 2 };
  };
  return mount(id, {
    type: 'bar',
    data: {
      labels: rows.map((d) => shortDate(d.date)),
      datasets: [
        {
          label,
          data: rows.map((d) => d.netChange),
          backgroundColor: rows.map((d) => (d.netChange < 0 ? t.neg : t.s1)),
          hoverBackgroundColor: rows.map((d) => alpha(d.netChange < 0 ? t.neg : t.s1, 0.75)),
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 24,
          categoryPercentage: 0.9,
          barPercentage: 0.85,
        },
      ],
    },
    options: opts,
  });
}

/**
 * 複数指標の日次折れ線。series: [{key, label, color}]
 * 桁が大きく違う指標（ビューとリンククリックなど）は右軸に分ける。
 */
export function multiLine(id, daily, series) {
  const t = tokens();
  const palette = [t.s1, t.s2, t.s3, t.neg];
  const rows = daily.filter((d) => series.some((s) => d[s.key] !== null));
  const maxOf = (key) => Math.max(0, ...rows.map((d) => d[key] ?? 0));
  const biggest = Math.max(...series.map((s) => maxOf(s.key)));
  const opts = baseOptions(t, { legend: series.length > 1, crosshairOn: true });
  opts.scales.y.beginAtZero = true;
  let needsRight = false;

  const datasets = series.map((s, i) => {
    const color = s.color || palette[i % palette.length];
    // 最大値が全体の 1/8 未満の系列は右軸へ（小さい系列が潰れないように）
    const right = series.length > 1 && biggest > 0 && maxOf(s.key) < biggest / 8;
    if (right) needsRight = true;
    return {
      label: s.label,
      data: rows.map((d) => d[s.key]),
      yAxisID: right ? 'y1' : 'y',
      borderColor: color,
      backgroundColor: alpha(color, series.length > 1 ? 0.06 : 0.1),
      fill: series.length > 1 ? false : 'start',
      borderWidth: 2,
      borderDash: right ? [4, 3] : undefined,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: t.surface,
      pointHoverBackgroundColor: color,
      tension: 0.25,
      spanGaps: true,
    };
  });

  if (needsRight) {
    opts.scales.y1 = {
      position: 'right',
      beginAtZero: true,
      grid: { display: false },
      border: { display: false },
      ticks: { color: t.muted, padding: 6, callback: (v) => fmtCompact(v) },
    };
  }
  opts.plugins.tooltip.callbacks.title = (items) => rows[items[0].dataIndex].date;
  opts.plugins.tooltip.callbacks.label = (ctx) => `${fmtInt(ctx.parsed.y)}  ${ctx.dataset.label}`;
  return mount(id, { type: 'line', data: { labels: rows.map((d) => shortDate(d.date)), datasets }, options: opts });
}

/**
 * 系列が複数ある横棒（年齢層 × 性別など）。
 * rows: [{label, values:{key:number}}] / series: [{key,label,color}]
 */
export function groupedHBar(id, rows, series, { unit = '' } = {}) {
  const t = tokens();
  const palette = [t.s1, t.s2, t.s3, t.neg];
  const opts = baseOptions(t, { legend: true });
  opts.indexAxis = 'y';
  opts.interaction = { mode: 'index', intersect: false, axis: 'y' };
  opts.scales.x = {
    grid: { color: t.grid },
    border: { display: false },
    beginAtZero: true,
    ticks: { color: t.muted, callback: (v) => (unit === '%' ? `${v}%` : fmtCompact(v)) },
  };
  opts.scales.y = { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.text2, autoSkip: false } };
  opts.plugins.tooltip.callbacks.title = (items) => rows[items[0].dataIndex].label;
  opts.plugins.tooltip.callbacks.label = (ctx) =>
    `${unit === '%' ? fmtPct(ctx.parsed.x, 1) : fmtInt(ctx.parsed.x)}  ${ctx.dataset.label}`;
  return mount(id, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: series.map((s, i) => {
        const c = s.color || palette[i % palette.length];
        return {
          label: s.label,
          data: rows.map((r) => r.values[s.key] ?? 0),
          backgroundColor: c,
          hoverBackgroundColor: alpha(c, 0.75),
          borderColor: c,
          borderRadius: 3,
          borderSkipped: 'start',
          maxBarThickness: 14,
        };
      }),
    },
    options: opts,
  });
}

/**
 * 投稿ごとのER（散布図・投稿タイプ別）＋週平均の折れ線。
 * タイプは色に加えて点の形（丸・四角・三角）でも区別する。
 */
export function erScatter(id, posts, weekly, typeMeta) {
  const t = tokens();
  const colors = { REELS: t.s1, CAROUSEL: t.s2, IMAGE: t.s3 };
  const shapes = { REELS: 'circle', CAROUSEL: 'rect', IMAGE: 'triangle' };
  const datasets = typeMeta
    .filter((m) => posts.some((p) => p.type === m.type))
    .map((m) => ({
      type: 'scatter',
      label: m.label,
      data: posts
        .filter((p) => p.type === m.type && p.er !== null)
        .map((p) => ({ x: new Date(p.timestamp).getTime(), y: p.er, post: p })),
      backgroundColor: colors[m.type],
      borderColor: t.surface,
      borderWidth: 2,
      pointStyle: shapes[m.type],
      pointRadius: 5,
      pointHoverRadius: 7,
      pointHitRadius: 12,
      order: 2,
    }));
  datasets.push({
    type: 'line',
    label: '週平均',
    data: weekly.map((w) => {
      const [y, mo, d] = w.week.split('-').map(Number);
      return { x: new Date(y, mo - 1, d + 3).getTime(), y: w.er, week: w };
    }),
    borderColor: t.text2,
    backgroundColor: t.text2,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.3,
    order: 1,
  });

  const opts = baseOptions(t, { legend: true });
  opts.interaction = { mode: 'nearest', intersect: false };
  opts.scales.x = {
    type: 'linear',
    grid: { display: false },
    border: { color: t.axis },
    ticks: {
      color: t.muted,
      maxRotation: 0,
      autoSkipPadding: 20,
      callback: (v) => {
        const d = new Date(v);
        return `${d.getMonth() + 1}/${d.getDate()}`;
      },
    },
  };
  opts.scales.y.beginAtZero = true;
  opts.scales.y.ticks.callback = (v) => `${v}%`;
  opts.plugins.legend.labels.generateLabels = (chart) =>
    chart.data.datasets.map((ds, i) => ({
      text: ds.label,
      fillStyle: ds.type === 'line' ? ds.borderColor : ds.backgroundColor,
      strokeStyle: ds.type === 'line' ? ds.borderColor : ds.backgroundColor,
      lineWidth: ds.type === 'line' ? 2 : 0,
      pointStyle: ds.type === 'line' ? 'line' : ds.pointStyle,
      fontColor: t.text2,
      hidden: !chart.isDatasetVisible(i),
      datasetIndex: i,
    }));
  opts.plugins.tooltip.callbacks.title = (items) => {
    const raw = items[0].raw;
    if (raw.week) return `${raw.week.week} の週（${raw.week.n}投稿）`;
    const d = new Date(raw.x);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  opts.plugins.tooltip.callbacks.label = (ctx) => `${fmtPct(ctx.parsed.y)}  ${ctx.dataset.label}`;
  opts.plugins.tooltip.callbacks.afterLabel = (ctx) =>
    ctx.raw.post ? ctx.raw.post.caption.split('\n')[0].slice(0, 30) : '';
  return mount(id, { data: { datasets }, options: opts });
}

/** 横棒（単一系列）。values: [{label, value, sub}] */
export function hBar(id, rows, { unit = '', name = '', color, onClick } = {}) {
  const t = tokens();
  const opts = baseOptions(t);
  opts.indexAxis = 'y';
  opts.interaction = { mode: 'nearest', intersect: false, axis: 'y' };
  opts.scales.x = {
    grid: { color: t.grid },
    border: { display: false },
    beginAtZero: true,
    ticks: { color: t.muted, callback: (v) => (unit === '%' ? `${v}%` : fmtCompact(v)) },
  };
  opts.scales.y = {
    grid: { display: false },
    border: { color: t.axis },
    ticks: { color: t.text2, autoSkip: false },
  };
  opts.plugins.tooltip.callbacks.title = (items) => rows[items[0].dataIndex].title ?? rows[items[0].dataIndex].label;
  opts.plugins.tooltip.callbacks.label = (ctx) =>
    `${unit === '%' ? fmtPct(ctx.parsed.x) : fmtInt(ctx.parsed.x)}  ${name}`;
  opts.plugins.tooltip.callbacks.afterLabel = (ctx) => rows[ctx.dataIndex].sub || '';
  if (onClick) {
    opts.onClick = (_, els) => els.length && onClick(rows[els[0].index]);
    opts.onHover = (e, els) => (e.native.target.style.cursor = els.length ? 'pointer' : 'default');
  }
  const c = color || t.s1;
  return mount(id, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        {
          label: name,
          data: rows.map((r) => r.value),
          backgroundColor: c,
          hoverBackgroundColor: alpha(c, 0.75),
          borderColor: c,
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 20,
        },
      ],
    },
    options: opts,
  });
}

/** 縦棒（単一系列）。highlight に含まれるインデックスだけ強調色、その他は淡色 */
export function vBar(id, rows, { unit = '', name = '', highlight = [] } = {}) {
  const t = tokens();
  const opts = baseOptions(t);
  opts.interaction = { mode: 'index', intersect: false, axis: 'x' };
  opts.scales.y.beginAtZero = true;
  if (unit === '%') opts.scales.y.ticks.callback = (v) => `${v}%`;
  opts.scales.x.ticks.autoSkip = false;
  opts.plugins.tooltip.callbacks.title = (items) => rows[items[0].dataIndex].title ?? rows[items[0].dataIndex].label;
  opts.plugins.tooltip.callbacks.label = (ctx) =>
    ctx.parsed.y === null ? '投稿なし' : `${unit === '%' ? fmtPct(ctx.parsed.y) : fmtInt(ctx.parsed.y)}  ${name}`;
  opts.plugins.tooltip.callbacks.afterLabel = (ctx) => rows[ctx.dataIndex].sub || '';
  const colorOf = (i) => (highlight.length === 0 || highlight.includes(i) ? t.s1 : alpha(t.s1, 0.35));
  return mount(id, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        {
          label: name,
          data: rows.map((r) => r.value),
          backgroundColor: rows.map((_, i) => colorOf(i)),
          hoverBackgroundColor: rows.map(() => t.s1),
          borderColor: t.s1,
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 24,
        },
      ],
    },
    options: opts,
  });
}

// ---------- ヒートマップ（HTML グリッド） ----------

const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

function rampColor(tNorm, dark) {
  const ramp = dark ? [...RAMP].reverse().slice(0, 11) : RAMP;
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(tNorm * (ramp.length - 1))));
  return ramp[i];
}

function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.35 ? '#0b0b0b' : '#ffffff';
}

/**
 * @param container 描画先
 * @param heatmap   analytics.timeHeatmap の結果
 * @param best      強調ラベルを付けるセル（bestSlots）
 * @param tooltipEl 共有ツールチップ要素
 */
export function renderHeatmap(container, heatmap, best, weekdays, tooltipEl) {
  const t = tokens();
  container.replaceChildren();
  const values = heatmap.cells.filter((c) => c.n > 0).map((c) => c.score);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const bestSet = new Set(best.map((c) => `${c.weekday}-${c.block}`));

  container.style.setProperty('--cols', heatmap.blocks);
  const corner = document.createElement('div');
  corner.className = 'hm-corner';
  container.append(corner);
  for (let b = 0; b < heatmap.blocks; b++) {
    const h = document.createElement('div');
    h.className = 'hm-colhead';
    h.textContent = `${b * heatmap.blockHours}時`;
    container.append(h);
  }
  for (let w = 0; w < 7; w++) {
    const rh = document.createElement('div');
    rh.className = 'hm-rowhead';
    rh.textContent = weekdays[w];
    container.append(rh);
    for (let b = 0; b < heatmap.blocks; b++) {
      const c = heatmap.cells[w * heatmap.blocks + b];
      const cell = document.createElement('div');
      cell.className = 'hm-cell';
      cell.tabIndex = 0;
      const desc =
        c.n > 0
          ? `${weekdays[w]}曜 ${c.startHour}〜${c.endHour}時：平均ER ${fmtPct(c.mean)}（${c.n}投稿）`
          : `${weekdays[w]}曜 ${c.startHour}〜${c.endHour}時：投稿なし`;
      cell.setAttribute('aria-label', desc);
      if (c.n > 0) {
        const norm = hi === lo ? 0.5 : (c.score - lo) / (hi - lo);
        const bg = rampColor(norm, t.dark);
        cell.style.background = bg;
        if (bestSet.has(`${w}-${b}`)) {
          cell.classList.add('is-best');
          const label = document.createElement('span');
          label.textContent = fmtPct(c.mean, 1);
          label.style.color = inkFor(bg);
          cell.append(label);
        }
      } else {
        cell.classList.add('is-empty');
      }
      const show = () => {
        tooltipEl.replaceChildren();
        const v = document.createElement('strong');
        v.textContent = c.n > 0 ? `平均ER ${fmtPct(c.mean)}` : '投稿なし';
        const s = document.createElement('div');
        s.textContent = `${weekdays[w]}曜 ${c.startHour}:00〜${c.endHour}:00${c.n > 0 ? ` ・ ${c.n}投稿` : ''}`;
        tooltipEl.append(v, s);
        const r = cell.getBoundingClientRect();
        tooltipEl.hidden = false;
        const tw = tooltipEl.offsetWidth;
        tooltipEl.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2))}px`;
        tooltipEl.style.top = `${r.top - tooltipEl.offsetHeight - 8}px`;
      };
      const hide = () => (tooltipEl.hidden = true);
      cell.addEventListener('pointerenter', show);
      cell.addEventListener('pointerleave', hide);
      cell.addEventListener('focus', show);
      cell.addEventListener('blur', hide);
      container.append(cell);
    }
  }
}

// ---------- 導線（ファネル・HTML） ----------

/**
 * リーチ → プロフィールアクセス → リンククリック → フォロー の通過率を帯で表す。
 * 段の長さは最初の段に対する割合。色だけでなく数値でも通過率が分かるようにする。
 */
export function renderFunnel(container, steps) {
  container.replaceChildren();
  if (!steps.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'この期間のデータがありません';
    container.append(p);
    return;
  }
  const top = steps[0].value || 1;
  steps.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'fn-row';

    const head = document.createElement('div');
    head.className = 'fn-head';
    const name = document.createElement('span');
    name.className = 'fn-name';
    name.textContent = s.label;
    const val = document.createElement('span');
    val.className = 'fn-val';
    val.textContent = fmtInt(s.value);
    head.append(name, val);

    const track = document.createElement('div');
    track.className = 'fn-track';
    const bar = document.createElement('i');
    bar.style.width = `${Math.max(1.5, (s.value / top) * 100)}%`;
    bar.style.opacity = String(1 - i * 0.18);
    track.append(bar);

    row.append(head, track);
    if (s.rate !== null) {
      const rate = document.createElement('p');
      rate.className = 'fn-rate';
      const pct = fmtPct(s.rate, s.rate < 10 ? 2 : 1);
      // 100% を超えることがある（1人が複数回クリックする、別の導線から来るなど）
      rate.textContent = s.rate > 100 ? `${s.from} の ${pct} に相当` : `${s.from} から ${pct} が次に進みました`;
      row.append(rate);
    }
    container.append(row);
  });
}

/** グラフのデータを表に変換（「表で見る」ボタン用） */
export function chartTable(chart) {
  const ds = chart.data.datasets;
  const isXY = ds.some((d) => d.data[0] && typeof d.data[0] === 'object');
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = table.createTHead().insertRow();
  const tbody = table.createTBody();
  const th = (txt) => {
    const el = document.createElement('th');
    el.textContent = txt;
    thead.append(el);
  };
  if (isXY) {
    ['系列', '日時', '値'].forEach(th);
    for (const d of ds) {
      for (const p of d.data) {
        const r = tbody.insertRow();
        const dt = new Date(p.x);
        r.insertCell().textContent = d.label;
        r.insertCell().textContent = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}${p.week ? '（週）' : ` ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`}`;
        r.insertCell().textContent = p.y === null ? '–' : p.y.toFixed(2);
      }
    }
  } else {
    th('');
    ds.forEach((d) => th(d.label));
    chart.data.labels.forEach((label, i) => {
      const r = tbody.insertRow();
      r.insertCell().textContent = label;
      ds.forEach((d) => {
        const v = d.data[i];
        r.insertCell().textContent = v === null || v === undefined ? '–' : Number.isInteger(v) ? v.toLocaleString('ja-JP') : v.toFixed(2);
      });
    });
  }
  return table;
}
