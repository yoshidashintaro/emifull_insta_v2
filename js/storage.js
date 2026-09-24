// localStorage への保存（すべてこのブラウザ内のみ。例外が出ても動作は継続する）
import { DAILY_FIELDS, emptyDailyRow } from './analytics.js';

const KEY_DATA = 'iia.dataset.v1';
const KEY_SETTINGS = 'iia.settings.v1';

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadDataset = () => read(KEY_DATA);
export const saveDataset = (ds) => write(KEY_DATA, ds);
export const clearDataset = () => write(KEY_DATA, null);

export const loadSettings = () => read(KEY_SETTINGS) || {};
export const saveSettings = (s) => write(KEY_SETTINGS, s);

/**
 * 日次データを日付単位でマージ（新しい方の非 null 値を優先）。
 * 指標ごとに別ファイルで届く Meta のエクスポートを1本の時系列にまとめるためにも使う。
 */
export function mergeDaily(oldRows = [], newRows = []) {
  const map = new Map(oldRows.map((r) => [r.date, { ...emptyDailyRow(r.date), ...r }]));
  for (const r of newRows) {
    const prev = map.get(r.date) || emptyDailyRow(r.date);
    const merged = { date: r.date };
    for (const k of DAILY_FIELDS) merged[k] = r[k] ?? prev[k] ?? null;
    map.set(r.date, merged);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** オーディエンス情報のマージ（新しい方を優先、欠けている項目は残す） */
export function mergeAudience(oldAud, newAud) {
  if (!newAud) return oldAud || null;
  if (!oldAud) return newAud;
  return { ...oldAud, ...newAud };
}

/** 投稿を ID 単位でマージ（新しい取得結果で上書き） */
export function mergePosts(oldPosts = [], newPosts = []) {
  const map = new Map(oldPosts.map((p) => [p.id, p]));
  for (const p of newPosts) map.set(p.id, p);
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
