// ============ JSON 持久化缓存（轻量，零依赖） ============
import fs from "fs";
import path from "path";

export interface CacheEntry {
  key_hash: string;
  provider: string;
  model: string;
  type: "translate" | "explain" | "dict" | "tts";
  source_text: string;
  voice: string;
  result_text: string;
  audio_path: string;
  audio_size: number;
  created_at: number;
  accessed_at: number;
  hit_count: number;
}

interface CacheIndex {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export class CacheStore {
  private index: CacheIndex;
  private indexPath: string;
  private dirty = false;
  private saveTimer: number | null = null;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
    this.index = this.load();
  }

  private load(): CacheIndex {
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && parsed.entries) {
          return parsed;
        }
      }
    } catch { /* 文件损坏或不存在 */ }
    return { version: 1, entries: {} };
  }

  /** 持久化到磁盘 */
  save(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index), "utf-8");
      this.dirty = false;
    } catch { /* Expected */ }
  }

  /** 延迟保存（合并多次写入，2 秒去抖） */
  private maybeSave(): void {
    this.dirty = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, 2000);
  }

  /** 查询文本缓存 */
  getText(keyHash: string): string | null {
    const entry = this.index.entries[keyHash];
    if (!entry || entry.type === "tts") return null;
    entry.accessed_at = Date.now();
    entry.hit_count++;
    this.maybeSave();
    return entry.result_text || null;
  }

  /** 查询音频缓存路径 */
  getAudio(keyHash: string): string | null {
    const entry = this.index.entries[keyHash];
    if (!entry || entry.type !== "tts") return null;
    entry.accessed_at = Date.now();
    entry.hit_count++;
    this.maybeSave();
    return entry.audio_path || null;
  }

  /** 写入文本缓存（立即持久化） */
  setText(keyHash: string, type: "translate" | "explain" | "dict",
    sourceText: string, resultText: string, provider = "", model = ""): void {
    const existing = this.index.entries[keyHash];
    this.index.entries[keyHash] = {
      key_hash: keyHash,
      provider: provider || existing?.provider || "",
      model: model || existing?.model || "",
      type,
      source_text: sourceText,
      voice: "",
      result_text: resultText,
      audio_path: "",
      audio_size: 0,
      created_at: existing?.created_at || Date.now(),
      accessed_at: Date.now(),
      hit_count: (existing?.hit_count || 0) + 1,
    };
    this.save();
  }

  /** 写入音频缓存（立即持久化） */
  setAudio(keyHash: string, sourceText: string, voice: string,
    audioPath: string, audioSize: number, provider = ""): void {
    const existing = this.index.entries[keyHash];
    this.index.entries[keyHash] = {
      key_hash: keyHash,
      provider: provider || existing?.provider || "",
      model: "",
      type: "tts",
      source_text: sourceText,
      voice,
      result_text: "",
      audio_path: audioPath,
      audio_size: audioSize,
      created_at: existing?.created_at || Date.now(),
      accessed_at: Date.now(),
      hit_count: (existing?.hit_count || 0) + 1,
    };
    this.save();
  }

  /** 删除单条 */
  delete(keyHash: string): boolean {
    if (this.index.entries[keyHash]) {
      delete this.index.entries[keyHash];
      this.maybeSave();
      return true;
    }
    return false;
  }

  /** 按类型清除 */
  clearByType(type?: string): number {
    let count = 0;
    if (type) {
      for (const key of Object.keys(this.index.entries)) {
        if (this.index.entries[key].type === type) {
          delete this.index.entries[key];
          count++;
        }
      }
    } else {
      count = Object.keys(this.index.entries).length;
      this.index.entries = {};
    }
    if (count > 0) this.maybeSave();
    return count;
  }

  /** 立即保存并清理 */
  close(): void {
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
  }
}

// ============ 全局单例 ============
let _store: CacheStore | null = null;

export function getCacheStore(): CacheStore | null {
  return _store;
}

export function initCacheStore(indexPath: string): CacheStore {
  if (_store) _store.close();
  _store = new CacheStore(indexPath);
  return _store;
}

export function closeCacheStore(): void {
  if (_store) { _store.close(); _store = null; }
}
