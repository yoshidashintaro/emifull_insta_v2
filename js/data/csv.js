// CSV 取り込み。Meta Business Suite のエクスポート（UTF-16 / sep= 行 / 複数セクション）や
// 自作 CSV の列名ゆれを吸収する。
import { toDateKey, DAILY_FIELDS, emptyDailyRow } from '../analytics.js';

/**
 * ファイルの中身を文字列にする。Meta のエクスポートは UTF-16LE（BOM 付き）、
 * Excel で保存した日本語 CSV は Shift_JIS のことがある。
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export function decodeCSV(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  // BOM 無しの UTF-16（ASCII 文字の隣に 0x00 が並ぶ）にも備える
  const head = bytes.subarray(0, 256);
  let zeros = 0;
  for (const b of head) if (b === 0) zeros++;
  if (zeros > head.length / 3) {
    return new TextDecoder(bytes[0] === 0 ? 'utf-16be' : 'utf-16le').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/**
 * CSV / TSV を行の配列にする。
 * - 先頭の `sep=,` 行（Excel 用の区切り指定）は区切り文字として解釈して取り除く
 * - 引用符の中の改行・カンマはそのまま保持する
 * @param {string} text
 * @param {{keepEmpty?: boolean}} [opts] keepEmpty=true で空行も残す（セクション分割用）
 */
export function parseCSV(text, { keepEmpty = false } = {}) {
  text = text.replace(/^﻿/, '');
  let sep = null;
  const sepLine = text.match(/^sep=(.)\r?\n/i);
  if (sepLine) {
    sep = sepLine[1];
    text = text.slice(sepLine[0].length);
  }
  if (sep === null) {
    const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
    sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushRow = () => {
    row.push(field);
    if (keepEmpty || row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else field += c;
  }
  if (row.length || field !== '') pushRow();
  return rows;
}

/** 空行区切りでセクションに分ける。Meta の「オーディエンス」エクスポートは1ファイルに複数の表が入る */
export function splitSections(rows) {
  const sections = [];
  let current = [];
  for (const r of rows) {
    if (r.every((f) => f.trim() === '')) {
      if (current.length) sections.push(current);
      current = [];
    } else current.push(r);
  }
  if (current.length) sections.push(current);
  return sections;
}

// 列名 → 内部キー。小文字化・空白除去して完全一致で比較する
const ALIASES = {
  id: ['id', '投稿id', 'postid', 'mediaid', 'メディアid'],
  timestamp: ['timestamp', '公開日時', '投稿日時', 'publishtime', 'publishedtime', '日時', 'datetime', 'posted', '投稿日'],
  type: ['type', 'posttype', 'mediatype', '投稿タイプ', 'タイプ', '種類', 'mediaproducttype'],
  caption: ['caption', 'description', '説明', 'キャプション', '本文', 'title', 'タイトル'],
  permalink: ['permalink', 'url', 'パーマリンク', 'link', 'リンク'],
  account: ['accountusername', 'username', 'アカウントユーザーネーム', 'ユーザーネーム'],
  accountName: ['accountname', 'アカウント名', 'アカウントの名前', '表示名'],
  duration: ['durationsec', 'duration', '長さ', '再生時間', '動画の長さ'],
  likes: ['likes', 'likecount', 'いいね', 'いいね！', 'いいね数'],
  comments: ['comments', 'commentscount', 'コメント', 'コメント数'],
  saves: ['saves', 'saved', '保存', '保存数'],
  shares: ['shares', 'シェア', 'シェア数'],
  reach: ['reach', 'リーチ', 'リーチ数', 'accountsreached', 'リーチしたアカウント数'],
  views: ['views', 'plays', 'impressions', '閲覧数', '再生数', 'ビュー', 'ビュー数', 'インプレッション', 'インプレッション数'],
  date: ['date', '日付', 'day', '日'],
  followers: ['followers', 'followerscount', 'フォロワー', 'フォロワー数', 'フォロワー総数', 'totalfollowers'],
  netChange: ['netchange', 'net', '純増', '純増数', '増減', 'フォロワー増減', 'netfollowers'],
  follows: ['follows', 'followercount', 'newfollowers', 'フォロー', '新規フォロワー', 'フォロー数'],
  unfollows: ['unfollows', 'フォロー解除', 'フォロー解除数'],
  profileVisits: ['profilevisits', 'プロフィールのアクセス', 'プロフィールへのアクセス', 'プロフィールアクセス', 'プロフィールの表示回数'],
  linkClicks: ['linkclicks', 'websiteclicks', 'リンクのクリック', 'リンククリック', 'リンククリック数', 'ウェブサイトのクリック'],
  interactions: ['contentinteractions', 'interactions', 'コンテンツのインタラクション', 'インタラクション', '反応数'],
  engagedAccounts: ['accountsengaged', 'エンゲージメントしたアカウント数', 'エンゲージメントしたアカウント'],
};

/**
 * 「Reach」「Instagram profile visits」のように、表題（またはファイル名）だけで指標が決まる
 * Meta の1指標エクスポート用の対応表。
 */
const SECTION_METRICS = {
  reach: ['reach', 'リーチ', 'accountsreached', 'リーチしたアカウント数', 'instagramreach'],
  views: ['views', 'ビュー', 'ビュー数', '表示回数', '閲覧数', 'impressions', 'インプレッション', 'instagramviews'],
  follows: ['instagramfollows', 'follows', 'フォロー', 'フォロー数', 'instagramのフォロー', '新規フォロワー', 'netfollows'],
  unfollows: ['instagramunfollows', 'unfollows', 'フォロー解除', 'フォロー解除数'],
  followers: ['instagramfollowers', 'followers', 'フォロワー', 'フォロワー数', 'totalfollowers', 'フォロワーの推移'],
  profileVisits: [
    'instagramprofilevisits', 'profilevisits', 'visits', 'プロフィールのアクセス',
    'プロフィールへのアクセス', 'プロフィールアクセス', 'プロフィールビュー',
    'instagramのプロフィールのアクセス', 'instagramのプロフィールへのアクセス',
  ],
  linkClicks: [
    'instagramlinkclicks', 'linkclicks', 'リンクのクリック', 'リンククリック',
    'リンククリック数', 'ウェブサイトのクリック', 'instagramのリンクのクリック',
  ],
  interactions: [
    'contentinteractions', 'interactions', 'コンテンツのインタラクション',
    'インタラクション', 'エンゲージメント', 'コンテンツへのインタラクション',
  ],
  engagedAccounts: ['accountsengaged', 'エンゲージメントしたアカウント数', 'エンゲージメントしたアカウント'],
};

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s"'（）()・_-]/g, '');

function matchMetric(label) {
  const n = norm(label);
  if (!n) return null;
  for (const [key, list] of Object.entries(SECTION_METRICS)) {
    if (list.some((a) => norm(a) === n)) return key;
  }
  return null;
}

function mapHeader(header) {
  const map = {};
  header.forEach((h, idx) => {
    const n = norm(h);
    for (const [key, list] of Object.entries(ALIASES)) {
      if (map[key] === undefined && list.some((a) => norm(a) === n)) map[key] = idx;
    }
  });
  return map;
}

const toNumber = (v) => {
  if (v === undefined) return null;
  const s = String(v).replace(/[,\s%％]/g, '');
  if (s === '' || s === '-' || s === '–') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function parseDateTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m;
  // 2026年9月15日 18:30
  if ((m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:(\d{1,2}):(\d{2}))?/))) {
    return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  // 2026/09/15 18:30 ・ 2026-09-15T18:30:00（タイムゾーン表記なし＝ローカル時刻）
  if ((m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?(?::\d{2})?$/))) {
    return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  // 09/15/2026 18:30（Meta Business Suite の英語エクスポート形式）
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/))) {
    return new Date(+m[3], m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0));
  }
  // ISO 8601（+0000 のようなコロン無しオフセットにも対応）
  const d = new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- セクションごとの読み取り ----------

/**
 * セクション内でヘッダーらしい行を探す。
 * 一致した列名の数が多い行を優先し、同点なら列数の多い行（表題行は1セルなので落ちる）、
 * それも同点なら先に出てくる行を使う。
 */
function findHeader(section) {
  let headerIdx = 0;
  let best = [-1, -1];
  section.slice(0, 4).forEach((r, i) => {
    const rank = [Object.keys(mapHeader(r)).length, r.filter((f) => f.trim() !== '').length];
    if (rank[0] > best[0] || (rank[0] === best[0] && rank[1] > best[1])) {
      best = rank;
      headerIdx = i;
    }
  });
  return { headerIdx, col: mapHeader(section[headerIdx]), score: best[0] };
}

/** ヘッダーより前にある「1セルだけの行」＝表題 */
function sectionTitles(section, headerIdx) {
  return section
    .slice(0, headerIdx)
    .filter((r) => r.filter((f) => f.trim() !== '').length === 1)
    .map((r) => r.find((f) => f.trim() !== '').trim());
}

function readPosts(section, headerIdx, col) {
  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  const posts = [];
  section.slice(headerIdx + 1).forEach((r, i) => {
    const ts = parseDateTime(get(r, 'timestamp'));
    if (!ts) return;
    posts.push({
      id: get(r, 'id') || `csv_${ts.getTime()}_${i}`,
      timestamp: ts.toISOString(),
      type: get(r, 'type') || 'IMAGE',
      caption: get(r, 'caption') || '',
      permalink: get(r, 'permalink') || '',
      account: (get(r, 'account') || '').trim(),
      accountName: (get(r, 'accountName') || '').trim(),
      duration: toNumber(get(r, 'duration')),
      likes: toNumber(get(r, 'likes')),
      comments: toNumber(get(r, 'comments')),
      saves: toNumber(get(r, 'saves')),
      shares: toNumber(get(r, 'shares')),
      reach: toNumber(get(r, 'reach')),
      views: toNumber(get(r, 'views')),
      follows: toNumber(get(r, 'follows')),
    });
  });
  return posts;
}

/** 列名から指標が判別できる通常の日次データ（日付・フォロワー数・リーチ…） */
function readDaily(section, headerIdx, col) {
  const dateCol = col.date ?? col.timestamp;
  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  const daily = [];
  for (const r of section.slice(headerIdx + 1)) {
    const d = parseDateTime(r[dateCol]);
    if (!d) continue;
    const row = emptyDailyRow(toDateKey(d));
    for (const key of DAILY_FIELDS) {
      if (col[key] !== undefined) row[key] = toNumber(get(r, key));
    }
    daily.push(row);
  }
  return daily;
}

/** Meta の1指標エクスポート（表題が指標名、列は Date / Primary だけ） */
function readSingleMetric(section, headerIdx, dateCol, metric) {
  const valueCol = section[headerIdx].length > dateCol + 1 ? dateCol + 1 : dateCol;
  const daily = [];
  for (const r of section.slice(headerIdx + 1)) {
    const d = parseDateTime(r[dateCol]);
    if (!d) continue;
    const row = emptyDailyRow(toDateKey(d));
    row[metric] = toNumber(r[valueCol]);
    daily.push(row);
  }
  return daily;
}

const AUDIENCE_HEADS = {
  age: ['age', '年齢', '年齢層', 'agerange'],
  cities: ['topcities', 'city', 'cities', '都市', '上位の都市', '市区町村'],
  countries: ['topcountries', 'country', 'countries', '国', '上位の国', '国・地域', '国や地域'],
  gender: ['gender', '性別'],
};
const GENDER_KEYS = {
  women: ['women', 'female', '女性', '女'],
  men: ['men', 'male', '男性', '男'],
  other: ['other', 'unknown', 'その他', '不明'],
};
const GENDER_LABELS = { women: '女性', men: '男性', other: 'その他' };

const headIs = (cell, list) => list.some((a) => norm(a) === norm(cell));

/**
 * オーディエンス系セクションを読む。
 * @returns {null|{type:'total'|'ageGender'|'gender'|'cities'|'countries'}}
 */
function readAudience(section, titles) {
  const nonEmpty = section.filter((r) => r.some((f) => f.trim() !== ''));
  if (!nonEmpty.length) return null;

  // 「Instagram followers」＋1列の数値 → フォロワー総数
  const singles = nonEmpty.filter((r) => r.filter((f) => f.trim() !== '').length === 1);
  if (singles.length === nonEmpty.length) {
    const value = toNumber(nonEmpty.at(-1)[0]);
    const labels = [...titles, ...nonEmpty.slice(0, -1).map((r) => r[0])];
    if (value !== null && labels.some((t) => matchMetric(t) === 'followers')) return { type: 'total', value };
    return null;
  }

  const headerIdx = nonEmpty.findIndex((r) => r.filter((f) => f.trim() !== '').length >= 2);
  if (headerIdx < 0) return null;
  const header = nonEmpty[headerIdx];
  const body = nonEmpty.slice(headerIdx + 1).filter((r) => r[0] && r[0].trim());

  if (headIs(header[0], AUDIENCE_HEADS.age)) {
    const series = header.slice(1).map((h) => {
      const key = Object.keys(GENDER_KEYS).find((k) => headIs(h, GENDER_KEYS[k]));
      return { key: key || norm(h), label: key ? GENDER_LABELS[key] : h.trim() };
    });
    const rows = body.map((r) => {
      const row = { age: r[0].trim() };
      series.forEach((s, i) => (row[s.key] = toNumber(r[i + 1])));
      return row;
    });
    return rows.length ? { type: 'ageGender', series, rows } : null;
  }
  if (headIs(header[0], AUDIENCE_HEADS.gender)) {
    const rows = body.map((r) => ({ name: r[0].trim(), value: toNumber(r[1]) })).filter((r) => r.value !== null);
    return rows.length ? { type: 'gender', rows } : null;
  }
  for (const type of ['cities', 'countries']) {
    if (headIs(header[0], AUDIENCE_HEADS[type])) {
      const rows = body.map((r) => ({ name: r[0].trim(), value: toNumber(r[1]) })).filter((r) => r.value !== null);
      return rows.length ? { type, rows } : null;
    }
  }
  return null;
}

// ---------- 入口 ----------

/**
 * CSV テキストを解析する。1ファイルに投稿・日次・オーディエンスが混在していてもよい。
 * @param {string} text
 * @param {{fileName?: string}} [opts] 表題から指標を判別できないとき、ファイル名を手掛かりにする
 * @returns {{posts:object[], daily:object[], audience:object|null, notes:string[], kinds:string[]}}
 */
export function importCSV(text, { fileName = '' } = {}) {
  const rows = parseCSV(text, { keepEmpty: true });
  if (!rows.some((r) => r.some((f) => f.trim() !== ''))) throw new Error('データ行がありません');

  const fileHint = matchMetric(String(fileName).replace(/\.[a-z0-9]+$/i, ''));
  const out = { posts: [], daily: [], audience: null, notes: [], kinds: [] };
  const addAudience = (patch) => (out.audience = { ...(out.audience || {}), ...patch });
  const unknownMetric = []; // 日付列はあるが指標名が分からなかったセクション
  const unknownShape = []; // そもそも形が分からなかったセクション

  for (const section of splitSections(rows)) {
    const { headerIdx, col, score } = findHeader(section);
    const titles = sectionTitles(section, headerIdx);

    // 1) 投稿データ（リーチは日次にもあるので判定には使わない）
    const hasEngagement = ['likes', 'comments', 'saves'].some((k) => col[k] !== undefined);
    if (col.timestamp !== undefined && hasEngagement) {
      const posts = readPosts(section, headerIdx, col);
      if (posts.length) {
        out.posts.push(...posts);
        out.kinds.push('posts');
        continue;
      }
    }

    const dateCol = col.date ?? col.timestamp;

    // 2) 列名で指標が分かる日次データ
    const metricCols = DAILY_FIELDS.filter((k) => col[k] !== undefined);
    if (dateCol !== undefined && metricCols.length) {
      const daily = readDaily(section, headerIdx, col);
      if (daily.length) {
        out.daily.push(...daily);
        out.kinds.push('daily');
        continue;
      }
    }

    // 3) 表題（またはファイル名）で指標が決まる1指標エクスポート
    if (dateCol !== undefined && score <= 1) {
      const metric = titles.map(matchMetric).find(Boolean) || fileHint;
      if (metric) {
        const daily = readSingleMetric(section, headerIdx, dateCol, metric);
        if (daily.length) {
          out.daily.push(...daily);
          out.kinds.push(metric);
          continue;
        }
      } else {
        unknownMetric.push(titles[0] || '（表題なし）');
        continue;
      }
    }

    // 4) オーディエンス（フォロワー総数・年齢×性別・上位の都市／国）
    const aud = readAudience(section, titles);
    if (aud) {
      if (aud.type === 'total') addAudience({ followersTotal: aud.value });
      else if (aud.type === 'ageGender') addAudience({ ageGender: aud.rows, ageSeries: aud.series });
      else if (aud.type === 'gender') addAudience({ genders: aud.rows });
      else addAudience({ [aud.type]: aud.rows });
      out.kinds.push(`audience:${aud.type}`);
      continue;
    }

    if (titles.length || section.length > 1) unknownShape.push(titles[0] || '（表題なし）');
  }

  if (!out.posts.length && !out.daily.length && !out.audience) {
    throw new Error(
      unknownMetric.length
        ? `指標を判別できませんでした（${unknownMetric.slice(0, 3).join('・')}）。Meta のエクスポートはファイル名（Reach.csv など）でも判別するため、名前を変えずに読み込んでください。`
        : '列名を判別できませんでした。投稿データは「投稿日時・いいね・コメント…」、日次データは「日付・フォロワー数」の列が必要です（サンプルCSVを参照）。',
    );
  }
  const skipped = [...unknownMetric, ...unknownShape];
  if (skipped.length) out.notes.push(`未対応のセクションを飛ばしました: ${skipped.slice(0, 3).join('・')}`);
  return out;
}

/** 取り込み結果を日本語1行で説明する（画面の状態表示用） */
const KIND_LABELS = {
  posts: '投稿',
  daily: '日次',
  reach: 'リーチ',
  views: 'ビュー',
  follows: 'フォロー',
  unfollows: 'フォロー解除',
  followers: 'フォロワー数',
  profileVisits: 'プロフィールアクセス',
  linkClicks: 'リンククリック',
  interactions: 'コンテンツインタラクション',
  engagedAccounts: 'エンゲージメントアカウント',
  'audience:total': 'フォロワー総数',
  'audience:ageGender': '年齢×性別',
  'audience:gender': '性別',
  'audience:cities': '都市',
  'audience:countries': '国',
};

export function describeImport(result) {
  const labels = [...new Set(result.kinds)].map((k) => KIND_LABELS[k] || k);
  const counts = [];
  if (result.posts.length) counts.push(`投稿 ${result.posts.length}件`);
  if (result.daily.length) counts.push(`日次 ${new Set(result.daily.map((d) => d.date)).size}日分`);
  const detail = labels.filter((l) => l !== '投稿' && l !== '日次');
  return [counts.join(' / '), detail.length ? `（${detail.join('・')}）` : ''].filter(Boolean).join('');
}

export function toCSV(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(c.get(r))).join(','));
  return '﻿' + lines.join('\r\n');
}
