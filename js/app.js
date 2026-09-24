import {
  WEEKDAYS, TYPE_LABELS, TYPE_ORDER, METRICS,
  normalizeDaily, normalizePost, enrichPosts, periodBounds, slice, addDays,
  summarize, weeklyER, byType, topPosts, timeHeatmap, groupByKey, bestSlots,
  hashtagStats, generateInsights, parseDateKey,
  anchorFollowers, detectFollowerMode, funnel, audienceSummary, accountsOf, byAccount,
} from './analytics.js';
import * as charts from './charts.js';
import { fmtInt, fmtPct, fmtCompact } from './charts.js';
import { generateDemo } from './data/demo.js';
import { importCSV, toCSV, decodeCSV, describeImport } from './data/csv.js';
import { GraphClient, fetchFromGraph } from './data/graphApi.js';
import * as store from './storage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULTS = { days: 90, basis: 'reach', topMetric: 'er', account: '', sort: { key: 'timestamp', dir: 'desc' } };
const state = {
  dataset: store.loadDataset(),
  settings: { ...DEFAULTS, ...store.loadSettings() },
  search: '',
  tableViews: new Set(), // 「表で見る」状態のカード
  view: null, // 直近の集計結果
};

function persistSettings() {
  store.saveSettings(state.settings);
}

// ---------- ユーティリティ ----------

function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const fmtDate = (key) => key.replaceAll('-', '/');
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const firstLine = (caption) => caption.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() || '（キャプションなし）';

/** 増減表示。矢印とテキストでも方向がわかるようにする（色だけに頼らない） */
function deltaNode(value, { unit = '', suffix = '', digits = 0, goodWhenUp = true } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return el('span', { textContent: '比較データなし' });
  const up = value > 0;
  const flat = Math.abs(value) < 10 ** -digits / 2;
  const cls = flat ? '' : up === goodWhenUp ? 'up' : 'down';
  const sign = flat ? '±' : up ? '+' : '−';
  const arrow = flat ? '' : up ? '▲ ' : '▼ ';
  const abs = Math.abs(value);
  const body = digits ? abs.toFixed(digits) : Math.round(abs).toLocaleString('ja-JP');
  return el('span', {}, el('span', { className: cls, textContent: `${arrow}${sign}${body}${unit}` }), suffix ? ` ${suffix}` : '');
}

// ---------- テーマ ----------

const media = matchMedia('(prefers-color-scheme: dark)');
function resolveTheme() {
  const explicit = document.documentElement.dataset.theme;
  document.documentElement.dataset.resolvedTheme = explicit || (media.matches ? 'dark' : 'light');
}
function toggleTheme() {
  const next = document.documentElement.dataset.resolvedTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('iia.theme', next);
  } catch {}
  resolveTheme();
  render();
}

// ---------- 集計 ----------

function compute() {
  const ds = state.dataset;
  const { days, basis } = state.settings;
  // フォロワー総数の日次データが無くても、オーディエンスの現在値から推移を逆算する
  const daily = normalizeDaily(anchorFollowers(ds.daily || [], ds.audience));
  const followerMode = ds.followerMode || detectFollowerMode(daily);
  const current = ds.audience?.followersTotal ?? ds.account?.followersCount ?? daily.findLast((d) => d.followers !== null)?.followers;
  const all = enrichPosts((ds.posts || []).map(normalizePost), daily, basis, current);

  // 1つのエクスポートに複数アカウントが入っていることがあるので絞り込めるようにする
  const accounts = accountsOf(all);
  const account = accounts.some((a) => a.username === state.settings.account) ? state.settings.account : '';
  const posts = account ? all.filter((p) => p.account === account) : all;

  const { startKey, endKey } = periodBounds(daily, posts, days || null);
  const cur = slice(daily, posts, startKey, endKey);
  let prev = null;
  if (days) {
    const pEnd = addDays(startKey, -1);
    prev = slice(daily, posts, addDays(pEnd, -(days - 1)), pEnd);
  }

  const summary = summarize(cur.daily, cur.posts);
  const prevSummary = prev && (prev.posts.length || prev.daily.length) ? summarize(prev.daily, prev.posts) : null;
  const types = byType(cur.posts);
  const heatmap = timeHeatmap(cur.posts, { blockHours: 3 });
  const hours = groupByKey(cur.posts, (p) => p.hour, 24);
  const weekdays = groupByKey(cur.posts, (p) => p.weekday, 7);
  const hashtags = hashtagStats(cur.posts);
  const steps = funnel(summary);
  const audience = audienceSummary(ds.audience);
  const accountStats = byAccount(slice(daily, all, startKey, endKey).posts);
  const insights = generateInsights({
    summary, prevSummary, types, heatmap, hours, hashtags, posts: cur.posts,
    steps, audience, accounts: account ? [] : accountStats,
  });

  return {
    startKey, endKey, daily: cur.daily, posts: cur.posts, summary, prevSummary,
    types, heatmap, hours, weekdays, hashtags, insights,
    steps, audience, accounts, accountStats, account, followerMode,
  };
}

// ---------- 描画 ----------

function render() {
  const hasData = !!state.dataset && ((state.dataset.posts?.length || 0) + (state.dataset.daily?.length || 0) > 0);
  $('#empty-state').hidden = hasData;
  $('#dashboard').hidden = !hasData;
  renderAccountLine();
  if (!hasData) return;

  const v = (state.view = compute());
  syncFilterControls();
  renderPeriodNote(v);
  renderWarnings(v);
  renderKPIs(v);
  renderInsights(v);
  renderFollowerCharts(v);
  renderActivity(v);
  renderEngagementCharts(v);
  renderTopPosts(v);
  renderPostsTable();
  renderTiming(v);
  renderAudience(v);
  renderHashtags(v);
  refreshTableViews();
}

function renderAccountLine() {
  const ds = state.dataset;
  const line = $('#account-line');
  if (!ds) {
    line.textContent = 'データ未接続';
    return;
  }
  const src = { demo: 'デモデータ', csv: 'CSV 取り込み', api: 'Instagram API' }[ds.source] || '';
  // CSV 取り込みではアカウント名が投稿データ側にしか無いので、そちらから拾う
  const names = ds.account?.username ? [ds.account.username] : accountsOf(ds.posts || []).map((a) => a.username);
  const name = names.length ? names.slice(0, 2).map((u) => `@${u}`).join(' / ') + (names.length > 2 ? ` ほか${names.length - 2}件` : '') : '';
  line.textContent = [name, src, ds.fetchedAt ? `更新 ${fmtDateTime(ds.fetchedAt)}` : ''].filter(Boolean).join(' ・ ');
}

function syncFilterControls() {
  $$('#range button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.days) === state.settings.days)));
  $('#er-basis').value = state.settings.basis;

  // アカウントが複数あるときだけ絞り込みを出す
  const { accounts, account } = state.view;
  const wrap = $('#account-filter-wrap');
  wrap.hidden = accounts.length < 2;
  if (wrap.hidden) return;
  const select = $('#account-filter');
  const signature = accounts.map((a) => a.username).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      el('option', { value: '', textContent: `すべて（${accounts.length}アカウント）` }),
      ...accounts.map((a) => el('option', { value: a.username, textContent: `@${a.username}（${a.n}投稿）` })),
    );
  }
  select.value = account;
}

function renderPeriodNote(v) {
  const n = Math.round((parseDateKey(v.endKey) - parseDateKey(v.startKey)) / 86400000) + 1;
  $('#period-note').textContent = `${fmtDate(v.startKey)} 〜 ${fmtDate(v.endKey)}（${n}日間）${v.prevSummary ? ' ・ 比較は直前の同じ日数' : ''}`;
}

function renderWarnings(v) {
  const msgs = [...(state.dataset.warnings || [])];
  if (state.settings.basis === 'reach' && v.posts.length && v.posts.every((p) => p.reach === null)) {
    msgs.push('投稿のリーチが無いため ER を計算できません。「ER の計算基準」をフォロワー基準に切り替えてください。');
  }
  if (!v.daily.some((d) => d.followers !== null)) {
    msgs.push('フォロワー数の日次データがありません。日次データの CSV を追加するか API 連携してください。');
  } else if (v.followerMode === 'gains' && state.dataset.audience?.followersTotal) {
    msgs.push(
      `フォロワー数の推移は、現在のフォロワー数（${fmtInt(state.dataset.audience.followersTotal)}人）から日々のフォロー数をさかのぼって計算した推定値です。` +
        'フォロー解除数が CSV に含まれないため、過去の値は実際よりやや少なめに出ます。',
    );
  }
  if (v.account) {
    msgs.push(`投稿の分析を @${v.account} に絞り込んでいます。アカウント全体の日次指標（リーチ・プロフィールアクセスなど）は絞り込みの対象外です。`);
  }
  const box = $('#warnings');
  box.hidden = !msgs.length;
  box.replaceChildren(el('ul', {}, ...msgs.map((m) => el('li', { textContent: m }))));
}

function renderKPIs({ summary: s, prevSummary: p }) {
  $('#kpi-followers').textContent = fmtInt(s.followers);
  $('#kpi-followers-delta').replaceChildren(
    s.followerChange === null
      ? el('span', { textContent: '増減データなし' })
      : deltaNode(s.followerChange, { unit: '人', suffix: `（${s.followerChangePct >= 0 ? '+' : ''}${(s.followerChangePct ?? 0).toFixed(1)}%）この期間` }),
  );

  $('#kpi-er').textContent = fmtPct(s.avgER);
  $('#kpi-er-delta').replaceChildren(
    p?.avgER ? deltaNode(s.avgER - p.avgER, { unit: 'pt', digits: 2, suffix: '前期間比' }) : el('span', { textContent: `中央値 ${fmtPct(s.medianER)}` }),
  );

  $('#kpi-posts').textContent = fmtInt(s.postCount);
  $('#kpi-posts-delta').replaceChildren(p ? deltaNode(s.postCount - p.postCount, { unit: '件', suffix: '前期間比' }) : el('span', { textContent: '' }));

  const pct = (a, b) => (a !== null && b ? ((a - b) / b) * 100 : null);
  $('#kpi-reach').textContent = fmtCompact(s.avgReach);
  $('#kpi-reach-delta').replaceChildren(
    p ? deltaNode(pct(s.avgReach, p.avgReach), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: '' }),
  );
  $('#kpi-inter').textContent = fmtCompact(s.avgInteractions);
  $('#kpi-inter-delta').replaceChildren(
    p ? deltaNode(pct(s.avgInteractions, p.avgInteractions), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: `合計 ${fmtInt(s.totalInteractions)}` }),
  );

  // 日次データにあるときだけ出す（API 連携では取れないことがある）
  const optional = (card, valueId, deltaId, value, prevValue, sub) => {
    $(card).hidden = value === null;
    if (value === null) return;
    $(valueId).textContent = fmtCompact(value);
    $(deltaId).replaceChildren(
      prevValue ? deltaNode(pct(value, prevValue), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: sub }),
    );
  };
  optional('#kpi-visits-card', '#kpi-visits', '#kpi-visits-delta', s.totals.profileVisits, p?.totals?.profileVisits, `1日平均 ${fmtInt(s.avgVisits)}`);
  optional('#kpi-clicks-card', '#kpi-clicks', '#kpi-clicks-delta', s.totals.linkClicks, p?.totals?.linkClicks, `1日平均 ${fmtInt(s.avgClicks)}`);

  const shown = $$('.kpis .kpi').filter((c) => !c.hidden).length;
  $('.kpis').classList.toggle('dense', shown > 6);
}

function renderInsights({ insights }) {
  const icons = { good: '✓', warn: '!', info: 'i' };
  const levels = { good: '好調', warn: '要注意', info: '参考' };
  const list = $('#insights');
  if (!insights.length) {
    list.replaceChildren(el('li', { className: 'info' }, el('span', { className: 'ic', textContent: 'i' }), el('strong', { textContent: 'データが少ないため分析できません' }), el('span', { className: 'tx', textContent: '期間を広げてください。' })));
    return;
  }
  list.replaceChildren(
    ...insights.map((i) =>
      el(
        'li',
        { className: i.level },
        el('span', { className: 'ic', textContent: icons[i.level], ariaHidden: 'true' }),
        el('strong', {}, i.title, el('span', { className: 'lv', textContent: levels[i.level] })),
        el('span', { className: 'tx', textContent: i.text }),
      ),
    ),
  );
}

/** データが無いグラフにはメッセージを出す */
function setEmpty(canvasId, empty, msg = 'この期間のデータがありません') {
  const wrap = document.getElementById(canvasId).parentElement;
  let note = wrap.querySelector('.empty-note');
  if (empty) {
    charts.getChart(canvasId)?.destroy();
    if (!note) {
      note = el('p', { className: 'empty-note sub' });
      note.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;margin:0';
      wrap.append(note);
    }
    note.textContent = msg;
  } else note?.remove();
  return empty;
}

function renderFollowerCharts(v) {
  const mode = v.followerMode;
  $('#net-title').textContent = mode === 'gains' ? '日次の新規フォロー数' : '日次の純増減（フォロー − フォロー解除）';
  $('#followers-sub').textContent = mode === 'gains' ? '日次（新規フォロー数からの推定値）' : '日次の総フォロワー数';

  if (!setEmpty('c-followers', !v.daily.some((d) => d.followers !== null))) charts.followerLine('c-followers', v.daily);
  if (!setEmpty('c-net', !v.daily.some((d) => d.netChange !== null)))
    charts.netChangeBars('c-net', v.daily, mode === 'gains' ? '新規フォロー' : '純増減');
}

/** アカウント全体の日次指標（リーチ・ビュー・プロフィールアクセス・リンククリック）と導線 */
function renderActivity(v) {
  const has = (key) => v.daily.some((d) => d[key] !== null);
  const reachSeries = [
    { key: 'reach', label: 'リーチ' },
    { key: 'views', label: 'ビュー' },
  ].filter((s) => has(s.key));
  const trafficSeries = [
    { key: 'profileVisits', label: 'プロフィールアクセス' },
    { key: 'linkClicks', label: 'リンククリック' },
    { key: 'interactions', label: 'コンテンツインタラクション' },
  ].filter((s) => has(s.key));

  const show = reachSeries.length || trafficSeries.length || v.steps.length;
  $('#activity-block').hidden = !show;
  if (!show) return;

  $('#reach-card').hidden = !reachSeries.length;
  if (reachSeries.length) {
    $('#reach-sub').textContent = reachSeries.map((s) => s.label).join(' と ') + 'の日次推移';
    if (!setEmpty('c-reach', false)) charts.multiLine('c-reach', v.daily, reachSeries);
  }

  $('#traffic-card').hidden = !trafficSeries.length;
  if (trafficSeries.length && !setEmpty('c-traffic', false)) charts.multiLine('c-traffic', v.daily, trafficSeries);

  $('#funnel-card').hidden = v.steps.length < 2;
  if (v.steps.length >= 2) charts.renderFunnel($('#funnel'), v.steps);
}

/** フォロワーの内訳（年齢×性別・国・都市）。期間ではなく「現在の構成」を表す */
function renderAudience(v) {
  const a = v.audience;
  const show = !!a && (a.ageGender.length || a.countries.length || a.cities.length);
  $('#audience-block').hidden = !show;
  if (!show) return;

  const lead = ['Meta の「オーディエンス」エクスポートから読み取った、現在のフォロワーの構成です（期間の切り替えには連動しません）。'];
  if (a.followersTotal) lead.unshift(`フォロワー ${fmtInt(a.followersTotal)}人。`);
  if (a.topGender && a.topAge) lead.push(`中心は ${a.topGender.label}・${a.topAge.age}歳（${fmtPct(a.topAge.value, 1)}）です。`);
  $('#audience-lead').textContent = lead.join('');

  $('#age-card').hidden = !a.ageGender.length;
  if (a.ageGender.length) {
    const rows = a.ageGender.map((r) => ({ label: `${r.age}歳`, values: r }));
    if (!setEmpty('c-age', false)) charts.groupedHBar('c-age', rows, a.series, { unit: '%' });
  }

  const pieces = [
    ['#country-card', 'c-country', a.countries, '国'],
    ['#city-card', 'c-city', a.cities, '都市'],
  ];
  for (const [card, canvas, rows, name] of pieces) {
    $(card).hidden = !rows.length;
    if (!rows.length) continue;
    const data = rows.slice(0, 10).map((r) => ({ label: r.name, value: +r.value.toFixed(2), sub: `フォロワー全体の ${fmtPct(r.value, 1)}` }));
    if (!setEmpty(canvas, false)) charts.hBar(canvas, data, { unit: '%', name: `${name}別の割合` });
  }
}

function renderEngagementCharts(v) {
  $('#er-def').textContent =
    state.settings.basis === 'reach'
      ? 'ER ＝（いいね＋コメント＋保存＋シェア）÷ リーチ × 100'
      : 'ER ＝（いいね＋コメント＋保存＋シェア）÷ 投稿時点のフォロワー数 × 100';
  const typeMeta = TYPE_ORDER.map((type) => ({ type, label: TYPE_LABELS[type] }));
  if (!setEmpty('c-er', !v.posts.some((p) => p.er !== null))) charts.erScatter('c-er', v.posts, weeklyER(v.posts), typeMeta);

  const rows = v.types
    .filter((t) => t.er !== null)
    .map((t) => ({
      label: t.label,
      value: +t.er.toFixed(3),
      sub: `${t.n}投稿 ・ 平均リーチ ${fmtInt(t.reach)} ・ 平均保存 ${t.saves.toFixed(1)}`,
    }));
  if (!setEmpty('c-type', !rows.length)) charts.hBar('c-type', rows, { unit: '%', name: '平均ER' });
}

function renderTopPosts(v) {
  const select = $('#top-metric');
  if (!select.options.length) {
    for (const [key, m] of Object.entries(METRICS)) select.append(el('option', { value: key, textContent: `${m.label}順` }));
  }
  select.value = state.settings.topMetric;
  const metric = METRICS[state.settings.topMetric];
  const top = topPosts(v.posts, state.settings.topMetric, 10);
  const rows = top.map((p) => {
    const d = new Date(p.timestamp);
    const text = firstLine(p.caption);
    return {
      label: `${d.getMonth() + 1}/${d.getDate()} ${text.length > 12 ? `${text.slice(0, 12)}…` : text}`,
      title: `${fmtDateTime(p.timestamp)} ・ ${TYPE_LABELS[p.type]}`,
      value: metric.unit === '%' ? +metric.get(p).toFixed(3) : metric.get(p),
      sub: [text.slice(0, 40), `ER ${fmtPct(p.er)} ・ リーチ ${fmtInt(p.reach)} ・ 反応 ${fmtInt(p.interactions)}`],
      permalink: p.permalink,
    };
  });
  if (!setEmpty('c-top', !rows.length))
    charts.hBar('c-top', rows, {
      unit: metric.unit,
      name: metric.label,
      onClick: (r) => r.permalink && window.open(r.permalink, '_blank', 'noopener'),
    });
}

function filteredPosts() {
  const q = state.search.trim().toLowerCase();
  const hit = (p) => `${p.caption} ${p.account} ${p.accountName}`.toLowerCase().includes(q);
  const list = q ? state.view.posts.filter(hit) : [...state.view.posts];
  const { key, dir } = state.settings.sort;
  const val = (p) => (key === 'type' ? TYPE_LABELS[p.type] : p[key]);
  list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return dir === 'asc' ? c : -c;
  });
  return list;
}

function renderPostsTable() {
  const list = filteredPosts();
  const maxER = Math.max(0, ...list.map((p) => p.er ?? 0));
  const multiAccount = !state.view.account && state.view.accounts.length > 1;
  // データに無い列は見出しごと隠す
  const hasCol = { views: list.some((p) => p.views !== null), follows: list.some((p) => p.follows !== null) };
  for (const [key, on] of Object.entries(hasCol)) {
    $$(`#posts-table .col-${key}`).forEach((th) => (th.hidden = !on));
  }
  $('#posts-count').textContent = `${list.length}件${state.search ? `（「${state.search}」で絞り込み）` : ''}`;
  $$('#posts-table th[data-sort]').forEach((th) => {
    th.setAttribute('aria-sort', th.dataset.sort === state.settings.sort.key ? (state.settings.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const tbody = $('#posts-table tbody');
  const frag = document.createDocumentFragment();
  for (const p of list.slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = fmtDateTime(p.timestamp);
    tr.insertCell().append(el('span', { className: 'type-tag' }, el('i', { className: p.type }), TYPE_LABELS[p.type]));

    const thumb = p.thumbnail
      ? el('img', { className: 'thumb', src: p.thumbnail, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
      : el('span', { className: 'thumb', textContent: TYPE_LABELS[p.type].slice(0, 2) });
    if (p.thumbnail) thumb.addEventListener('error', () => thumb.replaceWith(el('span', { className: 'thumb', textContent: TYPE_LABELS[p.type].slice(0, 2) })));
    const cap = el('span', { className: 'cap', textContent: p.caption.replace(/\s+/g, ' ').slice(0, 120) || '（キャプションなし）' });
    const content = p.permalink ? el('a', { href: p.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap;
    const body = el('div', { className: 'post-body' }, content);
    // 複数アカウントを一度に見ているときは、どちらの投稿か分かるようにする
    if (multiAccount && p.account) body.prepend(el('span', { className: 'acct-tag', textContent: `@${p.account}` }));
    tr.insertCell().append(el('div', { className: 'post-cell' }, thumb, body));

    for (const k of ['views', 'reach', 'likes', 'comments', 'saves', 'shares', 'follows', 'interactions']) {
      const td = tr.insertCell();
      td.className = `num${k in hasCol ? ` col-${k}` : ''}`;
      td.hidden = k in hasCol && !hasCol[k];
      td.textContent = fmtInt(p[k]);
    }
    const erTd = tr.insertCell();
    erTd.className = 'num';
    if (p.er !== null) {
      const bar = el('span', { className: 'er-bar' });
      bar.style.width = `${Math.max(2, (p.er / maxER) * 48)}px`;
      erTd.append(bar, fmtPct(p.er));
    } else erTd.textContent = '–';
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

function renderTiming(v) {
  const best = bestSlots(v.heatmap, { top: 3 });
  const cont = $('#heatmap');
  if (v.posts.some((p) => p.er !== null)) charts.renderHeatmap(cont, v.heatmap, best, WEEKDAYS, $('#tooltip'));
  else cont.replaceChildren(el('p', { className: 'sub', textContent: 'この期間の投稿データがありません' }));

  const list = $('#best-slots');
  const slots = bestSlots(v.heatmap, { top: 5 });
  if (!slots.length) {
    list.replaceChildren(el('li', { className: 'none', textContent: '同じ曜日・時間帯に2件以上の投稿がまだありません。期間を広げてください。' }));
  } else {
    list.replaceChildren(
      ...slots.map((c, i) =>
        el(
          'li',
          {},
          el('span', { className: 'rank', textContent: String(i + 1) }),
          el('div', {}, el('div', { className: 'when', textContent: `${WEEKDAYS[c.weekday]}曜 ${c.startHour}:00〜${c.endHour}:00` }), el('div', { className: 'meta', textContent: `${c.n}投稿 ・ 全体平均比 ${c.mean >= v.heatmap.overall ? '+' : '−'}${Math.abs((c.mean / v.heatmap.overall - 1) * 100).toFixed(0)}%` })),
          el('span', { className: 'val', textContent: fmtPct(c.mean) }),
        ),
      ),
    );
  }

  const topIdx = (rows, n) =>
    rows
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => r.n >= 2 && r.mean !== null)
      .sort((a, b) => b.r.mean - a.r.mean)
      .slice(0, n)
      .map(({ i }) => i);

  const hourRows = v.hours.map((h) => ({ label: `${h.key}`, title: `${h.key}:00〜${h.key}:59`, value: h.mean === null ? null : +h.mean.toFixed(3), sub: h.n ? `${h.n}投稿` : '' }));
  if (!setEmpty('c-hour', !v.hours.some((h) => h.n))) charts.vBar('c-hour', hourRows, { unit: '%', name: '平均ER', highlight: topIdx(v.hours, 3) });

  const wdRows = v.weekdays.map((w) => ({ label: WEEKDAYS[w.key], title: `${WEEKDAYS[w.key]}曜日`, value: w.mean === null ? null : +w.mean.toFixed(3), sub: w.n ? `${w.n}投稿` : '' }));
  if (!setEmpty('c-weekday', !v.weekdays.some((w) => w.n))) charts.vBar('c-weekday', wdRows, { unit: '%', name: '平均ER', highlight: topIdx(v.weekdays, 2) });
}

function renderHashtags(v) {
  const tbody = $('#hashtag-table tbody');
  if (!v.hashtags.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 5, textContent: '2回以上使われたハッシュタグがありません' })));
    return;
  }
  tbody.replaceChildren(
    ...v.hashtags.slice(0, 40).map((h) => {
      const tr = document.createElement('tr');
      tr.insertCell().textContent = h.tag;
      const cells = [fmtInt(h.n), fmtPct(h.er), null, fmtInt(h.reach)];
      cells.forEach((c, i) => {
        const td = tr.insertCell();
        td.className = 'num';
        if (i === 2) {
          if (h.lift === null) td.textContent = '–';
          else {
            td.className = `num ${h.lift >= 0 ? 'lift-up' : 'lift-down'}`;
            td.textContent = `${h.lift >= 0 ? '▲ +' : '▼ −'}${Math.abs(h.lift).toFixed(0)}%`;
          }
        } else td.textContent = c;
      });
      return tr;
    }),
  );
}

// ---------- 「表で見る」切り替え ----------

function setupTableToggles() {
  for (const card of $$('.card[data-chart], .card[data-heatmap]')) {
    const header = card.querySelector('header');
    let actions = header.querySelector('.card-actions');
    if (!actions) {
      actions = el('div', { className: 'card-actions' });
      // 既存のコントロール（指標選択など）もアクション領域へまとめる
      [...header.children].slice(1).forEach((c) => actions.append(c));
      header.append(actions);
    }
    const btn = el('button', { type: 'button', className: 'btn ghost view-toggle', textContent: '表で見る' });
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const key = card.dataset.chart || 'heatmap';
      if (state.tableViews.has(key)) state.tableViews.delete(key);
      else state.tableViews.add(key);
      refreshTableViews();
    });
    actions.append(btn);
  }
}

function heatmapTable() {
  const t = el('table', { className: 'data-table' });
  const head = t.createTHead().insertRow();
  ['曜日', '時間帯', '投稿数', '平均ER', '補正スコア'].forEach((h) => head.append(el('th', { textContent: h })));
  const body = t.createTBody();
  for (const c of state.view.heatmap.cells) {
    if (!c.n) continue;
    const r = body.insertRow();
    [WEEKDAYS[c.weekday], `${c.startHour}〜${c.endHour}時`, c.n, fmtPct(c.mean), fmtPct(c.score)].forEach((v) => (r.insertCell().textContent = v));
  }
  return t;
}

function refreshTableViews() {
  for (const card of $$('.card[data-chart], .card[data-heatmap]')) {
    const key = card.dataset.chart || 'heatmap';
    const on = state.tableViews.has(key);
    const btn = card.querySelector('.view-toggle');
    btn.textContent = on ? 'グラフで見る' : '表で見る';
    btn.setAttribute('aria-pressed', String(on));
    const visual = key === 'heatmap' ? [$('#heatmap'), card.querySelector('.scale')] : [card.querySelector('.chart')];
    visual.forEach((n) => (n.hidden = on));
    card.querySelector('.chart-table')?.remove();
    if (!on) continue;
    let table;
    if (key === 'heatmap') table = heatmapTable();
    else {
      const chart = charts.getChart(key);
      table = chart ? charts.chartTable(chart) : el('p', { className: 'sub', textContent: 'データがありません' });
    }
    card.append(el('div', { className: 'chart-table' }, table));
  }
}

// ---------- データ読み込み ----------

function setDataset(ds, message) {
  state.dataset = ds;
  if (!store.saveDataset(ds)) toast('ブラウザの保存容量が不足しているため、データは再読み込みで消えます');
  render();
  if (message) toast(message);
}

/**
 * 複数ファイルをまとめて取り込む。1ファイルが読めなくても残りは取り込み、最後にまとめて報告する。
 * Meta のエクスポートは指標ごとにファイルが分かれているため、日次データは日付単位でマージする。
 */
async function handleCSVFiles(files) {
  const status = $('#csv-status');
  status.className = 'status';
  const merge = $('#csv-merge').checked && state.dataset && state.dataset.source !== 'demo';
  let posts = merge ? state.dataset.posts || [] : [];
  let daily = merge ? state.dataset.daily || [] : [];
  let audience = merge ? state.dataset.audience || null : null;
  const done = [];
  const failed = [];
  const notes = [];

  for (const f of files) {
    try {
      const res = importCSV(decodeCSV(await f.arrayBuffer()), { fileName: f.name });
      if (res.posts.length) posts = store.mergePosts(posts, res.posts);
      if (res.daily.length) daily = store.mergeDaily(daily, res.daily);
      if (res.audience) audience = store.mergeAudience(audience, res.audience);
      notes.push(...res.notes);
      done.push(`${f.name}: ${describeImport(res)}`);
    } catch (e) {
      failed.push(`${f.name}: ${e.message}`);
    }
  }

  if (!done.length) {
    status.className = 'status error';
    status.textContent = `読み込みに失敗しました。${failed.join(' / ')}`;
    return;
  }

  const normalized = normalizeDaily(anchorFollowers(daily, audience));
  const lastF = audience?.followersTotal ?? normalized.findLast((d) => d.followers !== null)?.followers ?? null;
  setDataset(
    {
      source: merge && state.dataset.source !== 'demo' ? state.dataset.source : 'csv',
      account: { ...(merge ? state.dataset.account : {}), username: merge ? state.dataset.account?.username : '', followersCount: lastF },
      daily,
      posts,
      audience,
      followerMode: detectFollowerMode(normalized),
      fetchedAt: new Date().toISOString(),
    },
    failed.length ? `${done.length}件を取り込み、${failed.length}件は読めませんでした` : '取り込みが完了しました',
  );
  if (failed.length) status.className = 'status warn';
  status.replaceChildren(
    el('span', { textContent: done.join(' / ') }),
    ...[...new Set(notes)].map((n) => el('span', { className: 'note', textContent: n })),
    ...failed.map((f) => el('span', { className: 'note error', textContent: `読めませんでした → ${f}` })),
  );
}

async function handleAPISubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const f = Object.fromEntries(new FormData(form));
  const status = $('#api-status');
  const submit = form.querySelector('[type=submit]');
  status.className = 'status';
  submit.disabled = true;
  const opts = {
    token: f.token,
    host: f.host,
    userId: f.userId || 'me',
    version: f.version || 'v23.0',
    postLimit: Math.max(5, Math.min(500, Number(f.postLimit) || 50)),
  };
  state.settings.api = { host: opts.host, userId: opts.userId, version: opts.version, postLimit: opts.postLimit, token: f.remember ? opts.token : undefined, remember: !!f.remember };
  persistSettings();
  try {
    const { dataset, warnings } = await fetchFromGraph(opts, (msg) => (status.textContent = msg));
    // 同じアカウントなら過去の取得分とマージして履歴を積み上げる（API は日次データを30日分しか返さないため）
    const prev = state.dataset;
    if (prev?.source === 'api' && prev.account?.username === dataset.account.username) {
      dataset.daily = store.mergeDaily(prev.daily, dataset.daily);
      dataset.posts = store.mergePosts(prev.posts, dataset.posts);
    }
    dataset.warnings = warnings;
    setDataset(dataset, `@${dataset.account.username} のデータを取得しました`);
    status.textContent = `完了：投稿 ${dataset.posts.length}件 ・ 日次 ${dataset.daily.length}日分`;
    $('#data-dialog').close();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `取得に失敗しました: ${err.message}`;
  } finally {
    submit.disabled = false;
  }
}

async function handleFindIG() {
  const form = $('#api-form');
  const status = $('#api-status');
  status.className = 'status';
  try {
    if (form.host.value !== 'facebook') {
      form.userId.value = 'me';
      status.textContent = 'Instagram ログインでは「me」で自分のアカウントを指定できます。';
      return;
    }
    status.textContent = 'ビジネスアカウントを検索中…';
    const client = new GraphClient({ token: form.token.value, host: 'facebook', version: form.version.value || 'v23.0' });
    const accounts = await client.findInstagramAccounts();
    if (!accounts.length) throw new Error('Facebook ページに接続された Instagram ビジネスアカウントが見つかりません');
    form.userId.value = accounts[0].id;
    status.textContent = accounts.map((a) => `@${a.username}（${a.page}）: ${a.id}`).join(' / ');
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
}

// ---------- ダイアログ ----------

function openDialog(tab = 'api') {
  const dlg = $('#data-dialog');
  selectTab(tab);
  const api = state.settings.api || {};
  const form = $('#api-form');
  form.host.value = api.host || 'instagram';
  form.userId.value = api.userId || '';
  form.version.value = api.version || 'v23.0';
  form.postLimit.value = api.postLimit || 50;
  form.remember.checked = !!api.remember;
  if (api.token) form.token.value = api.token;
  dlg.showModal();
}

function selectTab(name) {
  $$('#data-dialog [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('#data-dialog .tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ---------- イベント ----------

function bindEvents() {
  $('#theme-toggle').addEventListener('click', toggleTheme);
  media.addEventListener('change', () => {
    resolveTheme();
    render();
  });
  $('#open-data').addEventListener('click', () => openDialog(state.dataset?.source === 'csv' ? 'csv' : 'api'));
  $$('[data-open-tab]').forEach((b) => b.addEventListener('click', () => openDialog(b.dataset.openTab)));
  $$('#data-dialog [role=tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  const loadDemo = () => {
    setDataset(generateDemo(), 'デモデータを読み込みました');
    $('#data-dialog').close();
  };
  $('#empty-demo').addEventListener('click', loadDemo);
  $('#load-demo').addEventListener('click', loadDemo);

  $('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    state.settings.days = Number(b.dataset.days);
    persistSettings();
    render();
  });
  $('#er-basis').addEventListener('change', (e) => {
    state.settings.basis = e.target.value;
    persistSettings();
    render();
  });
  $('#account-filter').addEventListener('change', (e) => {
    state.settings.account = e.target.value;
    persistSettings();
    render();
  });
  $('#top-metric').addEventListener('change', (e) => {
    state.settings.topMetric = e.target.value;
    persistSettings();
    renderTopPosts(state.view);
    refreshTableViews();
  });

  $('#post-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderPostsTable();
  });
  $$('#posts-table th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const s = state.settings.sort;
      state.settings.sort = s.key === th.dataset.sort ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: th.dataset.sort, dir: 'desc' };
      persistSettings();
      renderPostsTable();
    }),
  );
  $('#export-posts').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (p) => fmtDateTime(p.timestamp) },
      { label: 'アカウント', get: (p) => p.account },
      { label: 'タイプ', get: (p) => TYPE_LABELS[p.type] },
      { label: 'キャプション', get: (p) => p.caption },
      { label: 'ビュー', get: (p) => p.views },
      { label: 'リーチ', get: (p) => p.reach },
      { label: 'いいね', get: (p) => p.likes },
      { label: 'コメント', get: (p) => p.comments },
      { label: '保存', get: (p) => p.saves },
      { label: 'シェア', get: (p) => p.shares },
      { label: 'この投稿からのフォロー', get: (p) => p.follows },
      { label: '反応数合計', get: (p) => p.interactions },
      { label: 'エンゲージメント率(%)', get: (p) => (p.er === null ? '' : p.er.toFixed(2)) },
      { label: 'URL', get: (p) => p.permalink },
    ];
    download(`instagram_posts_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(filteredPosts(), cols), 'text/csv');
  });

  $('#api-form').addEventListener('submit', handleAPISubmit);
  $('#find-ig').addEventListener('click', handleFindIG);

  const input = $('#csv-input');
  input.addEventListener('change', () => input.files.length && handleCSVFiles([...input.files]).finally(() => (input.value = '')));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) handleCSVFiles([...e.dataTransfer.files]);
  });

  $('#export-json').addEventListener('click', () => {
    if (!state.dataset) return toast('バックアップするデータがありません');
    download(`instagram_insights_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.dataset), 'application/json');
  });
  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const ds = JSON.parse(await file.text());
      if (!Array.isArray(ds.posts) || !Array.isArray(ds.daily)) throw new Error('形式が正しくありません');
      setDataset(ds, 'バックアップから復元しました');
      $('#data-dialog').close();
    } catch (err) {
      toast(`復元に失敗しました: ${err.message}`);
    }
    e.target.value = '';
  });
  $('#clear-data').addEventListener('click', () => {
    if (!confirm('保存されているデータとアクセストークンを削除します。よろしいですか？')) return;
    store.clearDataset();
    delete state.settings.api;
    persistSettings();
    $('#api-form').reset();
    state.dataset = null;
    $('#data-dialog').close();
    render();
    toast('削除しました');
  });
}

resolveTheme();
setupTableToggles();
bindEvents();
// ?demo を付けて開くとデモデータを読み込む（動作確認用）
if (new URLSearchParams(location.search).has('demo')) state.dataset = generateDemo();
render();
