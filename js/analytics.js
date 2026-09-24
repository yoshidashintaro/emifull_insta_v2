// 分析ロジック（DOM に依存しない純粋関数のみ。Node のテストからも読み込む）

export const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

/** 日次データが持つ指標。CSV 取り込み・マージ・補完はすべてこの一覧を基準にする */
export const DAILY_FIELDS = [
  'followers', 'netChange', 'follows', 'unfollows',
  'reach', 'views', 'profileVisits', 'linkClicks', 'interactions', 'engagedAccounts',
];

export const DAILY_LABELS = {
  followers: 'フォロワー数',
  netChange: '純増減',
  follows: 'フォロー',
  unfollows: 'フォロー解除',
  reach: 'リーチ',
  views: 'ビュー',
  profileVisits: 'プロフィールアクセス',
  linkClicks: 'リンククリック',
  interactions: 'コンテンツインタラクション',
  engagedAccounts: 'エンゲージメントアカウント',
};

export function emptyDailyRow(date) {
  const row = { date };
  for (const k of DAILY_FIELDS) row[k] = null;
  return row;
}
export const TYPE_LABELS = { REELS: 'リール', CAROUSEL: 'カルーセル', IMAGE: '画像' };
export const TYPE_ORDER = ['REELS', 'CAROUSEL', 'IMAGE'];
export const DAY_MS = 86_400_000;

// ---------- 日付ユーティリティ（すべてブラウザのローカル時刻基準） ----------

export function toDateKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}

/** 月曜=0 … 日曜=6 */
export function weekdayIndex(date) {
  return (date.getDay() + 6) % 7;
}

// ---------- 正規化 ----------

export function normalizeType(raw) {
  const t = String(raw ?? '').toUpperCase();
  if (/REEL|VIDEO|リール|動画/.test(t)) return 'REELS';
  if (/CAROUSEL|ALBUM|カルーセル/.test(t)) return 'CAROUSEL';
  return 'IMAGE';
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function normalizePost(p) {
  return {
    id: String(p.id ?? ''),
    timestamp: new Date(p.timestamp).toISOString(),
    type: normalizeType(p.type),
    caption: String(p.caption ?? ''),
    permalink: p.permalink || '',
    thumbnail: p.thumbnail || '',
    account: String(p.account ?? ''),
    accountName: String(p.accountName ?? ''),
    duration: num(p.duration),
    likes: num(p.likes) ?? 0,
    comments: num(p.comments) ?? 0,
    saves: num(p.saves) ?? 0,
    shares: num(p.shares) ?? 0,
    reach: num(p.reach),
    views: num(p.views),
    follows: num(p.follows),
  };
}

/**
 * 日次データを日付順に並べ、欠けている値を補完する。
 * - followers（総数）が無い日は、既知の総数と netChange（純増減）から前後に逆算
 * - netChange が無い日は、前日との followers 差分から算出
 */
export function normalizeDaily(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!r?.date) continue;
    const prev = byDate.get(r.date) || emptyDailyRow(r.date);
    const merged = { date: r.date };
    for (const k of DAILY_FIELDS) merged[k] = num(r[k]) ?? prev[k] ?? null;
    byDate.set(r.date, merged);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return days;

  // 抜けている日付を埋める（グラフの横軸を等間隔にするため）
  const filled = [];
  for (let key = days[0].date, i = 0; key <= days.at(-1).date; key = addDays(key, 1)) {
    if (days[i]?.date === key) filled.push({ ...days[i++] });
    else filled.push(emptyDailyRow(key));
  }

  // フォロー／フォロー解除しか無い日は、そこから純増減を出す
  for (const d of filled) {
    if (d.netChange === null && d.follows !== null) d.netChange = d.follows - (d.unfollows ?? 0);
  }

  // 総数を後ろ向き・前向きに補完
  for (let i = filled.length - 2; i >= 0; i--) {
    const next = filled[i + 1];
    if (filled[i].followers === null && next.followers !== null && next.netChange !== null) {
      filled[i].followers = next.followers - next.netChange;
    }
  }
  for (let i = 1; i < filled.length; i++) {
    const prev = filled[i - 1];
    if (filled[i].followers === null && prev.followers !== null && filled[i].netChange !== null) {
      filled[i].followers = prev.followers + filled[i].netChange;
    }
  }
  for (let i = 1; i < filled.length; i++) {
    const prev = filled[i - 1];
    if (filled[i].netChange === null && filled[i].followers !== null && prev.followers !== null) {
      filled[i].netChange = filled[i].followers - prev.followers;
    }
  }
  return filled;
}

/**
 * フォロワー総数の日次データが無くても、オーディエンス情報の「現在のフォロワー数」を
 * 期間末に置けば、日々の増減から推移を逆算できる。
 * 総数の日次データがある場合は何もしない。
 */
export function anchorFollowers(rows, audience) {
  const total = audience?.followersTotal;
  if (!total || !rows.length || rows.some((r) => r.followers !== null && r.followers !== undefined)) return rows;
  // 増減が分かっている最後の日に置く。指標ごとにファイルの最終日がずれていても、
  // そこから確実に過去へさかのぼれる（増減が不明な日より後ろは総数を出さない）
  const hasChange = (r) => (r.netChange ?? r.follows ?? null) !== null;
  const anchorDate = rows.reduce((best, r) => (hasChange(r) && (!best || r.date > best) ? r.date : best), null);
  if (!anchorDate) return rows;
  return [...rows, { ...emptyDailyRow(anchorDate), followers: total }];
}

/**
 * フォロワー推移の表示モード。
 * 'net'   … フォロー − フォロー解除の純増減が分かる
 * 'gains' … 新規フォロー数しか無く、推移は推定値になる
 */
export function detectFollowerMode(rows) {
  if (rows.some((r) => r.unfollows !== null && r.unfollows !== undefined)) return 'net';
  if (rows.some((r) => r.followers !== null && r.followers !== undefined) && !rows.some((r) => r.follows !== null && r.follows !== undefined)) return 'net';
  return rows.some((r) => r.follows !== null && r.follows !== undefined) ? 'gains' : 'net';
}

// ---------- 指標 ----------

export function interactions(p) {
  return p.likes + p.comments + p.saves + p.shares;
}

/** その日時点のフォロワー数（日次データから最も近い過去の値） */
export function followersAt(daily, dateKey, fallback) {
  let found = null;
  for (const d of daily) {
    if (d.date > dateKey) break;
    if (d.followers !== null) found = d.followers;
  }
  return found ?? daily.find((d) => d.followers !== null)?.followers ?? fallback ?? null;
}

/**
 * エンゲージメント率（%）
 * basis = 'reach'     : (いいね+コメント+保存+シェア) ÷ リーチ
 * basis = 'followers' : (いいね+コメント+保存+シェア) ÷ 投稿時点のフォロワー数
 */
export function engagementRate(p, basis, followerCount) {
  const denom = basis === 'reach' ? p.reach : followerCount;
  if (!denom) return null;
  return (interactions(p) / denom) * 100;
}

/** 分析用に各投稿へ er / interactions / 日付キー等を付与 */
export function enrichPosts(posts, daily, basis, currentFollowers) {
  return posts
    .map((p) => {
      const d = new Date(p.timestamp);
      const dateKey = toDateKey(d);
      const fAt = followersAt(daily, dateKey, currentFollowers);
      return {
        ...p,
        dateKey,
        hour: d.getHours(),
        weekday: weekdayIndex(d),
        interactions: interactions(p),
        followersAt: fAt,
        er: engagementRate(p, basis, fAt),
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const erValues = (posts) => posts.map((p) => p.er).filter((v) => v !== null);

// ---------- 期間 ----------

/** 期間 [startKey, endKey] に含まれる日次データと投稿を返す。days=null で全期間 */
export function periodBounds(daily, posts, days) {
  const lastDaily = daily.at(-1)?.date;
  const lastPost = posts.length ? toDateKey(posts.at(-1).timestamp) : null;
  const endKey = [lastDaily, lastPost].filter(Boolean).sort().at(-1) || toDateKey(new Date());
  if (!days) {
    const firstDaily = daily[0]?.date;
    const firstPost = posts.length ? toDateKey(posts[0].timestamp) : null;
    const startKey = [firstDaily, firstPost].filter(Boolean).sort()[0] || endKey;
    return { startKey, endKey };
  }
  return { startKey: addDays(endKey, -(days - 1)), endKey };
}

export function slice(daily, posts, startKey, endKey) {
  return {
    daily: daily.filter((d) => d.date >= startKey && d.date <= endKey),
    posts: posts.filter((p) => p.dateKey >= startKey && p.dateKey <= endKey),
  };
}

// ---------- 集計 ----------

/** 日次のある指標の合計。値が1つも無ければ null（「0件」と「データなし」を区別する） */
export function dailyTotal(daily, key) {
  const vs = daily.map((d) => d[key]).filter((v) => v !== null && v !== undefined);
  return vs.length ? vs.reduce((s, v) => s + v, 0) : null;
}

export function summarize(daily, posts) {
  const withF = daily.filter((d) => d.followers !== null);
  const first = withF[0]?.followers ?? null;
  const last = withF.at(-1)?.followers ?? null;
  const change = first !== null && last !== null ? last - first : null;
  const ers = erValues(posts);
  const reaches = posts.map((p) => p.reach).filter((v) => v !== null);
  const netDays = daily.filter((d) => d.netChange !== null);
  const totals = {};
  for (const k of DAILY_FIELDS) {
    if (k !== 'followers') totals[k] = dailyTotal(daily, k);
  }
  return {
    followers: last,
    followerChange: change,
    followerChangePct: change !== null && first ? (change / first) * 100 : null,
    avgER: mean(ers),
    medianER: median(ers),
    postCount: posts.length,
    avgReach: mean(reaches),
    avgInteractions: mean(posts.map((p) => p.interactions)),
    totalInteractions: posts.reduce((s, p) => s + p.interactions, 0),
    lossDays: netDays.filter((d) => d.netChange < 0).length,
    days: daily.length,
    totals,
    // アカウント全体の日次指標（投稿単位ではなくアカウント単位の数字）
    totalReach: totals.reach,
    totalViews: totals.views,
    totalVisits: totals.profileVisits,
    totalClicks: totals.linkClicks,
    totalFollows: totals.follows,
    avgVisits: totals.profileVisits === null ? null : totals.profileVisits / Math.max(1, daily.filter((d) => d.profileVisits !== null).length),
    avgClicks: totals.linkClicks === null ? null : totals.linkClicks / Math.max(1, daily.filter((d) => d.linkClicks !== null).length),
  };
}

/**
 * 「見られてから行動するまで」の導線。
 * リンククリックとフォローはどちらもプロフィールから分かれるので、
 * 直前の段ではなく「本来の出発点」に対する通過率を出す。
 * データが無い段階は落とし、その場合はさかのぼって出発点を探す。
 */
const FUNNEL_STEPS = [
  { key: 'reach', label: 'リーチ', parent: null },
  { key: 'profileVisits', label: 'プロフィールアクセス', parent: 'reach' },
  { key: 'linkClicks', label: 'リンククリック', parent: 'profileVisits' },
  { key: 'follows', label: 'フォロー', parent: 'profileVisits' },
];

export function funnel(summary) {
  const value = (key) => summary.totals?.[key] ?? null;
  const present = FUNNEL_STEPS.filter((s) => value(s.key) !== null);
  const byKey = new Map(FUNNEL_STEPS.map((s) => [s.key, s]));
  const has = new Set(present.map((s) => s.key));

  /** 値のある最も近い祖先を探す（プロフィールアクセスが無ければリーチを使う） */
  const ancestor = (step) => {
    let p = step.parent;
    while (p && !has.has(p)) p = byKey.get(p)?.parent ?? null;
    return p;
  };

  return present.map((s) => {
    const from = ancestor(s);
    const base = from ? value(from) : null;
    return {
      key: s.key,
      label: s.label,
      value: value(s.key),
      from: from ? byKey.get(from).label : null,
      rate: base ? (value(s.key) / base) * 100 : null,
    };
  });
}

/**
 * Meta のエクスポートは国名が英語のことがあるので、日本語表示に寄せる。
 * 一覧にない国はそのまま出す。
 */
const COUNTRY_JA = {
  japan: '日本', taiwan: '台湾', china: '中国', 'south korea': '韓国', korea: '韓国',
  'hong kong': '香港', macau: 'マカオ', 'united states': 'アメリカ合衆国', usa: 'アメリカ合衆国',
  canada: 'カナダ', australia: 'オーストラリア', 'new zealand': 'ニュージーランド',
  singapore: 'シンガポール', thailand: 'タイ', vietnam: 'ベトナム', philippines: 'フィリピン',
  malaysia: 'マレーシア', indonesia: 'インドネシア', india: 'インド', pakistan: 'パキスタン',
  'united kingdom': 'イギリス', france: 'フランス', germany: 'ドイツ', italy: 'イタリア',
  spain: 'スペイン', brazil: 'ブラジル', mexico: 'メキシコ',
};

export function localizeCountry(name) {
  return COUNTRY_JA[String(name).trim().toLowerCase()] || name;
}

/** オーディエンス（年齢×性別・国・都市）を画面表示向けにまとめる */
export function audienceSummary(audience) {
  if (!audience) return null;
  const ageGender = audience.ageGender || [];
  const series = audience.ageSeries || [
    { key: 'women', label: '女性' },
    { key: 'men', label: '男性' },
  ];
  const sumOf = (key) => ageGender.reduce((s, r) => s + (r[key] ?? 0), 0);
  const genderTotals = audience.genders?.length
    ? audience.genders.map((g) => ({ key: g.name, label: g.name, value: g.value }))
    : series.map((s) => ({ ...s, value: sumOf(s.key) })).filter((s) => s.value > 0);
  const ageTotals = ageGender
    .map((r) => ({ age: r.age, value: series.reduce((s, x) => s + (r[x.key] ?? 0), 0) }))
    .sort((a, b) => b.value - a.value);
  return {
    followersTotal: audience.followersTotal ?? null,
    series,
    ageGender,
    ageTotals,
    genderTotals,
    topAge: ageTotals[0] || null,
    topGender: [...genderTotals].sort((a, b) => b.value - a.value)[0] || null,
    countries: (audience.countries || []).map((c) => ({ ...c, name: localizeCountry(c.name) })),
    cities: (audience.cities || []).map((c) => ({
      ...c,
      // 「Osaka, Japan」のように末尾が国名なので、そこだけ日本語にする
      name: c.name.replace(/,\s*([^,]+)$/, (m, country) => `, ${localizeCountry(country)}`),
    })),
  };
}

/** 週ごとの平均ER（週の開始＝月曜） */
export function weeklyER(posts) {
  const groups = new Map();
  for (const p of posts) {
    if (p.er === null) continue;
    const monday = addDays(p.dateKey, -p.weekday);
    if (!groups.has(monday)) groups.set(monday, []);
    groups.get(monday).push(p.er);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, ers]) => ({ week, er: mean(ers), n: ers.length }));
}

export function byType(posts) {
  return TYPE_ORDER.map((type) => {
    const list = posts.filter((p) => p.type === type);
    const reaches = list.map((p) => p.reach).filter((v) => v !== null);
    return {
      type,
      label: TYPE_LABELS[type],
      n: list.length,
      er: mean(erValues(list)),
      reach: mean(reaches),
      interactions: mean(list.map((p) => p.interactions)),
      saves: mean(list.map((p) => p.saves)),
    };
  }).filter((t) => t.n > 0);
}

export const METRICS = {
  er: { label: 'エンゲージメント率', unit: '%', get: (p) => p.er },
  interactions: { label: '反応数合計', unit: '', get: (p) => p.interactions },
  reach: { label: 'リーチ', unit: '', get: (p) => p.reach },
  likes: { label: 'いいね', unit: '', get: (p) => p.likes },
  comments: { label: 'コメント', unit: '', get: (p) => p.comments },
  saves: { label: '保存', unit: '', get: (p) => p.saves },
  shares: { label: 'シェア', unit: '', get: (p) => p.shares },
  views: { label: 'ビュー', unit: '', get: (p) => p.views },
  follows: { label: 'この投稿からのフォロー', unit: '', get: (p) => p.follows },
};

/** 投稿データに含まれるアカウント一覧（1つのエクスポートに複数アカウントが入ることがある） */
export function accountsOf(posts) {
  const map = new Map();
  for (const p of posts) {
    const key = p.account || '';
    if (!key) continue;
    const prev = map.get(key) || { username: key, name: p.accountName || '', n: 0 };
    prev.n++;
    if (!prev.name && p.accountName) prev.name = p.accountName;
    map.set(key, prev);
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

/** アカウント別の成績（複数アカウントを比べるため） */
export function byAccount(posts) {
  return accountsOf(posts).map((a) => {
    const list = posts.filter((p) => p.account === a.username);
    return {
      ...a,
      er: mean(erValues(list)),
      reach: mean(list.map((p) => p.reach).filter((v) => v !== null)),
      views: mean(list.map((p) => p.views).filter((v) => v !== null)),
      interactions: mean(list.map((p) => p.interactions)),
      follows: list.reduce((s, p) => s + (p.follows ?? 0), 0),
    };
  });
}

export function topPosts(posts, metricKey, n = 10) {
  const get = METRICS[metricKey].get;
  return posts
    .filter((p) => get(p) !== null)
    .sort((a, b) => get(b) - get(a))
    .slice(0, n);
}

/**
 * 曜日 × 時間帯 のヒートマップ。
 * 投稿数が少ないセルの偶然の高値に引っ張られないよう、全体平均へ縮小した score（ベイズ平均）も返す。
 */
export function timeHeatmap(posts, { blockHours = 3, metric = 'er', prior = 2 } = {}) {
  const get = METRICS[metric].get;
  const values = posts.map(get).filter((v) => v !== null);
  const overall = mean(values) ?? 0;
  const blocks = 24 / blockHours;
  const cells = [];
  for (let w = 0; w < 7; w++) {
    for (let b = 0; b < blocks; b++) {
      const vs = posts
        .filter((p) => p.weekday === w && Math.floor(p.hour / blockHours) === b)
        .map(get)
        .filter((v) => v !== null);
      const sum = vs.reduce((s, v) => s + v, 0);
      cells.push({
        weekday: w,
        block: b,
        startHour: b * blockHours,
        endHour: (b + 1) * blockHours,
        n: vs.length,
        mean: vs.length ? sum / vs.length : null,
        score: vs.length ? (sum + prior * overall) / (vs.length + prior) : null,
      });
    }
  }
  return { cells, blocks, blockHours, overall };
}

export function groupByKey(posts, keyFn, size, metric = 'er') {
  const get = METRICS[metric].get;
  return Array.from({ length: size }, (_, k) => {
    const vs = posts.filter((p) => keyFn(p) === k).map(get).filter((v) => v !== null);
    return { key: k, n: vs.length, mean: mean(vs) };
  });
}

export function bestSlots(heatmap, { minPosts = 2, top = 3 } = {}) {
  return heatmap.cells
    .filter((c) => c.n >= minPosts)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

export function extractHashtags(caption) {
  return [...new Set((caption.match(/#[^\s#＃]+/g) || []).map((t) => t.toLowerCase()))];
}

export function hashtagStats(posts, { minCount = 2 } = {}) {
  const map = new Map();
  for (const p of posts) {
    for (const tag of extractHashtags(p.caption)) {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(p);
    }
  }
  const overall = mean(erValues(posts));
  return [...map.entries()]
    .filter(([, list]) => list.length >= minCount)
    .map(([tag, list]) => {
      const er = mean(erValues(list));
      return {
        tag,
        n: list.length,
        er,
        reach: mean(list.map((p) => p.reach).filter((v) => v !== null)),
        lift: er !== null && overall ? (er / overall - 1) * 100 : null,
      };
    })
    .sort((a, b) => (b.er ?? -1) - (a.er ?? -1));
}

// ---------- 自動インサイト ----------

const fmtPct = (v, d = 2) => `${v.toFixed(d)}%`;
const slotLabel = (c) => `${WEEKDAYS[c.weekday]}曜 ${c.startHour}〜${c.endHour}時`;

/**
 * 集計結果から文章のインサイトを生成する。
 * level: good（好調）/ warn（要注意）/ info（参考）
 */
export function generateInsights({ summary, prevSummary, types, heatmap, hours, hashtags, posts, steps = [], audience = null, accounts = [] }) {
  const out = [];

  if (summary.followerChange !== null) {
    const perDay = summary.days > 1 ? summary.followerChange / (summary.days - 1) : 0;
    if (summary.followerChange >= 0) {
      out.push({
        level: 'good',
        title: 'フォロワーは増加傾向',
        text: `期間中 +${summary.followerChange.toLocaleString()}人（1日あたり ${perDay.toFixed(1)}人）。${
          summary.lossDays ? `純減の日が ${summary.lossDays}日ありました。` : '純減の日はありません。'
        }`,
      });
    } else {
      out.push({
        level: 'warn',
        title: 'フォロワーが減少しています',
        text: `期間中 ${summary.followerChange.toLocaleString()}人。純減の日が ${summary.lossDays}日あります。減少した日の直前の投稿内容を確認しましょう。`,
      });
    }
  }

  if (summary.avgER !== null && prevSummary?.avgER) {
    const diff = ((summary.avgER - prevSummary.avgER) / prevSummary.avgER) * 100;
    if (Math.abs(diff) >= 5) {
      out.push({
        level: diff > 0 ? 'good' : 'warn',
        title: `エンゲージメント率が前期間比 ${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`,
        text: `平均 ${fmtPct(summary.avgER)}（前期間 ${fmtPct(prevSummary.avgER)}）。`,
      });
    }
  }

  const rankedTypes = types.filter((t) => t.n >= 2 && t.er !== null).sort((a, b) => b.er - a.er);
  if (rankedTypes.length >= 2) {
    const [best, ...rest] = rankedTypes;
    const worst = rest.at(-1);
    out.push({
      level: 'info',
      title: `${best.label}の反応が最も高い`,
      text: `${best.label}の平均ER ${fmtPct(best.er)} は${worst.label}（${fmtPct(worst.er)}）の ${(best.er / worst.er).toFixed(1)}倍。${best.label}の比率を増やす余地があります。`,
    });
  }

  const slots = bestSlots(heatmap);
  if (slots.length) {
    out.push({
      level: 'good',
      title: `おすすめ投稿枠: ${slotLabel(slots[0])}`,
      text: `この枠の平均ER ${fmtPct(slots[0].mean)}（${slots[0].n}投稿、全体平均 ${fmtPct(heatmap.overall)}）。${
        slots.length > 1 ? `次点は ${slots.slice(1).map(slotLabel).join('、')}。` : ''
      }`,
    });
  } else if (posts.length) {
    out.push({
      level: 'info',
      title: '投稿時間の判断にはデータ不足',
      text: '同じ曜日・時間帯に2件以上の投稿がまだありません。期間を広げるか、時間帯を変えて投稿を試してください。',
    });
  }

  const validHours = hours.filter((h) => h.n >= 2 && h.mean !== null);
  if (validHours.length >= 3) {
    const worst = [...validHours].sort((a, b) => a.mean - b.mean)[0];
    out.push({
      level: 'info',
      title: `${worst.key}時台の投稿は反応が弱め`,
      text: `平均ER ${fmtPct(worst.mean)}（${worst.n}投稿）。この時間帯の投稿は別の枠へ移すことを検討しましょう。`,
    });
  }

  const goodTags = hashtags.filter((h) => h.lift !== null && h.lift >= 15 && h.n >= 3).slice(0, 3);
  if (goodTags.length) {
    out.push({
      level: 'info',
      title: '反応の良いハッシュタグ',
      text: goodTags.map((h) => `${h.tag}（平均比 +${h.lift.toFixed(0)}%）`).join('、'),
    });
  }

  if (summary.postCount && summary.days >= 14) {
    const perWeek = (summary.postCount / summary.days) * 7;
    if (perWeek < 3) {
      out.push({
        level: 'warn',
        title: `投稿頻度が週 ${perWeek.toFixed(1)}回`,
        text: '週3回以上の継続投稿がリーチ維持の目安です。',
      });
    }
  }

  // 導線（リーチ → プロフィールアクセス → リンククリック → フォロー）
  const step = (key) => steps.find((s) => s.key === key && s.rate !== null);
  const n = (v) => Number(v).toLocaleString('ja-JP');

  const visit = step('profileVisits');
  if (visit) {
    const weak = visit.rate < 1;
    out.push({
      level: weak ? 'warn' : 'good',
      title: `${visit.from}からプロフィールへの遷移率 ${fmtPct(visit.rate)}`,
      text: weak
        ? `${n(visit.value)}件のプロフィールアクセスは、${visit.from}に対して ${fmtPct(visit.rate)} にとどまっています。投稿の1枚目とキャプション冒頭で「誰向けの何か」を明示すると改善しやすい段階です。`
        : `${visit.from}した人のうち ${fmtPct(visit.rate)}（${n(visit.value)}件）がプロフィールまで来ています。この流れを保てる投稿を増やしましょう。`,
    });
  }
  const click = step('linkClicks');
  if (click) {
    out.push({
      level: click.rate >= 50 ? 'good' : 'info',
      title: `リンククリックは${click.from}の ${fmtPct(click.rate, 1)}`,
      text:
        click.rate > 100
          ? `リンククリック ${n(click.value)}回は${click.from}を上回っています（1人が複数回押す、プロフィール以外からも押されるため）。予約導線としてはよく機能しています。`
          : `${click.from}のうち ${fmtPct(click.rate, 1)} がリンクをクリックしています（合計 ${n(click.value)}回）。予約導線の入口として最も太い数字です。`,
    });
  }
  const follow = step('follows');
  if (follow) {
    out.push({
      level: 'info',
      title: `新規フォローは ${n(follow.value)}件（${follow.from}の ${fmtPct(follow.rate, 1)}）`,
      text: 'フォロー転換を上げるには、ハイライトと固定投稿で「初めての方向け」の情報を整理するのが定石です。',
    });
  }

  // オーディエンス
  if (audience?.topAge && audience?.topGender) {
    out.push({
      level: 'info',
      title: `中心層は ${audience.topGender.label}・${audience.topAge.age}歳`,
      text: `フォロワーの ${fmtPct(audience.topAge.value, 1)} が ${audience.topAge.age}歳。${audience.topGender.label}が全体の ${fmtPct(audience.topGender.value, 1)} を占めます。訴求と価格帯をこの層に合わせているか確認しましょう。`,
    });
  }
  if (audience?.countries?.length >= 2) {
    const [first, second] = audience.countries;
    if (second.value >= 5) {
      out.push({
        level: 'info',
        title: `フォロワーの ${fmtPct(second.value, 1)} が${second.name}`,
        text: `最多は${first.name}（${fmtPct(first.value, 1)}）ですが、${second.name}が無視できない比率です。来院できない層が含まれている可能性があるため、リーチ数だけで判断しないようにしましょう。`,
      });
    }
  }

  // 複数アカウント
  const ranked = accounts.filter((a) => a.n >= 3 && a.er !== null).sort((x, y) => y.er - x.er);
  if (ranked.length >= 2) {
    const [top, bottom] = [ranked[0], ranked.at(-1)];
    out.push({
      level: 'info',
      title: `@${top.username} の方が反応が高い`,
      text: `平均ER ${fmtPct(top.er)}（${top.n}投稿）に対し @${bottom.username} は ${fmtPct(bottom.er)}（${bottom.n}投稿）。上位アカウントの構成や見せ方を横展開できないか検討しましょう。`,
    });
  }

  return out;
}
