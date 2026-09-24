// Instagram Graph API クライアント（ブラウザから直接呼び出す。トークンは外部サーバーへ送らない）
import { addDays, toDateKey } from '../analytics.js';

export const HOSTS = {
  instagram: 'https://graph.instagram.com', // Instagram ログインで発行したトークン
  facebook: 'https://graph.facebook.com', // Facebook ログイン（ビジネスアカウント連携）で発行したトークン
};

export class GraphClient {
  constructor({ token, host = 'instagram', version = 'v23.0', userId = 'me' }) {
    if (!token) throw new Error('アクセストークンを入力してください');
    this.token = token.trim();
    this.base = `${HOSTS[host] || HOSTS.instagram}/${version}`;
    this.host = host;
    this.userId = (userId || 'me').trim();
  }

  async get(path, params = {}) {
    const url = path.startsWith('http') ? new URL(path) : new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', this.token);
    let res;
    try {
      res = await fetch(url, { referrerPolicy: 'no-referrer' });
    } catch {
      throw new Error('Graph API に接続できませんでした（ネットワークを確認してください）');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const e = body.error || {};
      const err = new Error(e.message || `HTTP ${res.status}`);
      err.code = e.code;
      throw err;
    }
    return body;
  }

  /** Facebook ログインの場合：ページに紐づく Instagram ビジネスアカウントを探す */
  async findInstagramAccounts() {
    const res = await this.get('me/accounts', { fields: 'name,instagram_business_account{id,username}' });
    return (res.data || [])
      .filter((p) => p.instagram_business_account)
      .map((p) => ({ page: p.name, id: p.instagram_business_account.id, username: p.instagram_business_account.username }));
  }

  async profile() {
    return this.get(this.userId, { fields: 'username,followers_count,media_count' });
  }

  async media(limit) {
    const fields =
      'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url';
    const out = [];
    let page = await this.get(`${this.userId}/media`, { fields, limit: Math.min(limit, 100) });
    while (true) {
      out.push(...(page.data || []));
      if (out.length >= limit || !page.paging?.next) break;
      page = await this.get(page.paging.next);
    }
    return out.slice(0, limit);
  }

  /** 投稿タイプによって使えない指標があるため、失敗したら指標を減らして再試行する */
  async mediaInsights(id) {
    const attempts = [
      'reach,saved,shares,views,total_interactions',
      'reach,saved,shares,views',
      'reach,saved,shares',
      'reach,saved',
      'reach',
    ];
    for (const metric of attempts) {
      try {
        const res = await this.get(`${id}/insights`, { metric });
        return Object.fromEntries((res.data || []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? null]));
      } catch (e) {
        if (e.code === 190 || e.code === 4 || e.code === 17 || e.code === 32) throw e; // トークン無効・レート制限は即中断
      }
    }
    return {};
  }

  /** 日次の時系列指標（reach など）。API の仕様上 1 リクエスト 30 日まで */
  async dailySeries(metric, sinceKey, untilKey) {
    const since = Math.floor(new Date(`${sinceKey}T00:00:00`).getTime() / 1000);
    const until = Math.floor(new Date(`${addDays(untilKey, 1)}T00:00:00`).getTime() / 1000);
    const res = await this.get(`${this.userId}/insights`, { metric, period: 'day', since, until });
    const values = res.data?.[0]?.values || [];
    // end_time は集計日の翌日 0 時（太平洋時間）を指すため 1 日戻す
    return values.map((v) => ({ date: addDays(toDateKey(new Date(v.end_time)), -1), value: v.value }));
  }

  /** 1 日分のフォロー数・フォロー解除数 */
  async followsAndUnfollows(dateKey) {
    const since = Math.floor(new Date(`${dateKey}T00:00:00`).getTime() / 1000);
    const until = since + 86400;
    const res = await this.get(`${this.userId}/insights`, {
      metric: 'follows_and_unfollows',
      period: 'day',
      metric_type: 'total_value',
      breakdown: 'follow_type',
      since,
      until,
    });
    const results = res.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    const pick = (t) => results.find((r) => r.dimension_values?.[0] === t)?.value ?? 0;
    return { follows: pick('FOLLOWER'), unfollows: pick('NON_FOLLOWER') };
  }
}

async function pool(items, size, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/**
 * アカウント情報・投稿・日次データをまとめて取得し、アプリ共通のデータ形式で返す。
 * 取得できなかった項目は warnings に理由を残し、取得できた範囲で分析を続ける。
 */
export async function fetchFromGraph(opts, onStatus = () => {}) {
  const client = new GraphClient(opts);
  const warnings = [];

  onStatus('アカウント情報を取得中…');
  const profile = await client.profile();

  onStatus('投稿一覧を取得中…');
  const media = await client.media(opts.postLimit || 50);

  const insights = await pool(
    media,
    4,
    (m) => client.mediaInsights(m.id),
    (d, n) => onStatus(`投稿ごとのインサイトを取得中… ${d}/${n}`),
  );

  const posts = media.map((m, i) => {
    const ins = insights[i] || {};
    const type = m.media_product_type === 'REELS' ? 'REELS' : m.media_type === 'CAROUSEL_ALBUM' ? 'CAROUSEL' : m.media_type;
    return {
      id: m.id,
      timestamp: new Date(m.timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString(),
      type,
      caption: m.caption || '',
      permalink: m.permalink || '',
      thumbnail: m.thumbnail_url || (m.media_type === 'VIDEO' ? '' : m.media_url) || '',
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      saves: ins.saved ?? 0,
      shares: ins.shares ?? 0,
      reach: ins.reach ?? null,
      views: ins.views ?? null,
    };
  });
  if (insights.every((x) => !x || x.reach === undefined)) {
    warnings.push('投稿ごとのリーチを取得できませんでした（instagram_manage_insights / instagram_business_manage_insights 権限を確認）。');
  }

  // ---- 日次データ（直近 30 日） ----
  const todayKey = toDateKey(new Date());
  const days = Array.from({ length: 30 }, (_, i) => addDays(todayKey, i - 29));
  const daily = new Map(days.map((d) => [d, { date: d, followers: null, netChange: null, reach: null }]));
  daily.get(todayKey).followers = profile.followers_count;

  onStatus('フォロワー増減を取得中…');
  let followerMode = 'net';
  try {
    await client.followsAndUnfollows(days[0]);
    await pool(
      days,
      4,
      async (d) => {
        const { follows, unfollows } = await client.followsAndUnfollows(d);
        daily.get(d).netChange = follows - unfollows;
      },
      (d, n) => onStatus(`フォロワー増減を取得中… ${d}/${n}`),
    );
  } catch {
    // follows_and_unfollows が使えないアカウントでは新規フォロー数（follower_count）で代替
    try {
      const gains = await client.dailySeries('follower_count', days[0], todayKey);
      for (const g of gains) if (daily.has(g.date)) daily.get(g.date).netChange = g.value;
      followerMode = 'gains';
      warnings.push('フォロー解除数を取得できないため、フォロワー推移は「新規フォロー数」から推定しています（実際より多めに出ます）。');
    } catch (e) {
      followerMode = 'none';
      warnings.push(`フォロワー増減を取得できませんでした: ${e.message}（フォロワー100人以上が必要です）`);
    }
  }

  onStatus('リーチの推移を取得中…');
  try {
    const reach = await client.dailySeries('reach', days[0], todayKey);
    for (const r of reach) if (daily.has(r.date)) daily.get(r.date).reach = r.value;
  } catch (e) {
    warnings.push(`日次リーチを取得できませんでした: ${e.message}`);
  }

  return {
    dataset: {
      source: 'api',
      account: { username: profile.username, followersCount: profile.followers_count, mediaCount: profile.media_count },
      daily: [...daily.values()],
      posts,
      followerMode,
      fetchedAt: new Date().toISOString(),
    },
    warnings,
  };
}
