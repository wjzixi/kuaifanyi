// ============ JSON 持久化缓存（轻量，零依赖，按类别分库存放） ============
// 三类缓存：translate（翻译+查词）/ explain（解释）/ tts（语音合成）
// 每类独立目录 + 独立 index.json：文本类只存索引，tts 类索引与 mp3 同目录
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

function isCacheIndex(obj: unknown): obj is CacheIndex {
  return typeof obj === "object" && obj !== null
    && "version" in obj && (obj as Record<string, unknown>).version === 1
    && "entries" in obj && typeof (obj as Record<string, unknown>).entries === "object";
}

/** 缓存类别：翻译（含查词）/ 解释 / 语音合成 */
export type CacheCategory = "translate" | "explain" | "tts";

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
        const parsed: unknown = JSON.parse(raw);
        if (isCacheIndex(parsed)) {
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
    this.dirty = true;
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
    this.dirty = true;
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

  /** 按类型清除；不传类型清空整个分类库 */
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

  /** 分类统计：条目数 + 音频总字节数（文本类 bytes 为 0） */
  stats(): { count: number; bytes: number } {
    let count = 0, bytes = 0;
    for (const e of Object.values(this.index.entries)) {
      count++;
      bytes += e.audio_size || 0;
    }
    return { count, bytes };
  }

  /** 立即保存并清理 */
  close(): void {
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
  }
}

// ============ 分类库管理（三库单例） ============
let _stores: Partial<Record<CacheCategory, CacheStore>> = {};

/** 初始化三类缓存库（onload 调用一次） */
export function initCacheStores(indexPaths: Record<CacheCategory, string>): void {
  closeCacheStores();
  _stores = {
    translate: new CacheStore(indexPaths.translate),
    explain: new CacheStore(indexPaths.explain),
    tts: new CacheStore(indexPaths.tts),
  };
}

/** 取某类缓存库 */
export function getStore(cat: CacheCategory): CacheStore | null {
  return _stores[cat] ?? null;
}

/** 关闭全部缓存库（onunload 调用） */
export function closeCacheStores(): void {
  for (const cat of Object.keys(_stores) as CacheCategory[]) {
    _stores[cat]?.close();
  }
  _stores = {};
}

/**
 * 旧版混合索引（cache-index.json）迁移到三类分库：
 * - translate/dict → translate 库；explain → explain 库；tts → tts 库
 * - tts 条目要求音频文件真实存在才迁（僵尸条目直接丢弃）
 * - 音频文件与目标目录不同则移动（rename 失败回退 copy+delete）
 * - 迁移完成删除旧索引；旧目录空了则一并移除
 * 返回迁移条数
 */
export function migrateLegacyIndex(legacyPath: string, ttsDir: string): number {
  if (!legacyPath || !fs.existsSync(legacyPath)) return 0;
  try {
    const raw = fs.readFileSync(legacyPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isCacheIndex(parsed)) return 0;
    let n = 0;
    for (const e of Object.values(parsed.entries)) {
      if (e.type === "tts") {
        if (!e.audio_path || !fs.existsSync(e.audio_path)) continue; // 僵尸条目
        let newPath = e.audio_path;
        if (path.dirname(e.audio_path) !== ttsDir) {
          const target = path.join(ttsDir, path.basename(e.audio_path));
          try {
            fs.mkdirSync(ttsDir, { recursive: true });
            fs.renameSync(e.audio_path, target);
            newPath = target;
          } catch {
            try { fs.copyFileSync(e.audio_path, target); fs.unlinkSync(e.audio_path); newPath = target; }
            catch { continue; }
          }
        }
        getStore("tts")?.setAudio(e.key_hash, e.source_text, e.voice, newPath, e.audio_size, e.provider);
        n++;
      } else if (e.type === "explain") {
        getStore("explain")?.setText(e.key_hash, "explain", e.source_text, e.result_text, e.provider, e.model);
        n++;
      } else {
        // translate / dict 统一归翻译类
        getStore("translate")?.setText(e.key_hash, e.type === "dict" ? "dict" : "translate",
          e.source_text, e.result_text, e.provider, e.model);
        n++;
      }
    }
    // 清理旧索引与空目录
    try { fs.unlinkSync(legacyPath); } catch { /* Expected */ }
    try {
      const oldDir = path.dirname(legacyPath);
      if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
    } catch { /* Expected */ }
    return n;
  } catch { return 0; }
}
