// ============ SQLite 缓存数据库（sql.js） ============
import fs from "fs";
import path from "path";

// sql.js 运行时从插件目录加载（esbuild external，已拷贝 sql-wasm.js + sql-wasm.wasm 到根目录）
const initSqlJs = require("./sql-wasm") as (config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>;

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}
interface SqlJsDatabase {
  run(sql: string, params?: any[]): void;
  exec(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }>;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}
interface SqlJsStatement {
  bind(params?: any[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, any>;
  free(): void;
}

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

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
  hit_count: number;
}

export interface CacheStats {
  total_entries: number;
  total_text_size: number;
  total_audio_size: number;
  by_type: Record<string, { count: number; size: number }>;
}

export class CacheDB {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private pluginDir: string;
  private dirty = false;

  constructor(dbPath: string, pluginDir: string) {
    this.dbPath = dbPath;
    this.pluginDir = pluginDir;
  }

  /** 打开数据库，不存在则创建 */
  async open(): Promise<void> {
    if (!SQL) {
      // 加载 sql.js WASM — 从插件目录读取 wasm 文件
      const wasmPath = path.join(this.pluginDir, "sql-wasm.wasm");
      if (fs.existsSync(wasmPath)) {
        const wasmBin = fs.readFileSync(wasmPath);
        SQL = await initSqlJs({ wasmBinary: wasmBin });
      } else {
        // 回退：使用默认加载（Node.js 环境自动查找）
        SQL = await initSqlJs();
      }
    }

    try {
      if (fs.existsSync(this.dbPath)) {
        const buf = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(buf);
      } else {
        this.db = new SQL.Database();
      }
    } catch {
      this.db = new SQL.Database();
    }

    this.migrate();
  }

  /** 建表/迁移 */
  private migrate(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL,
        provider TEXT DEFAULT '',
        model TEXT DEFAULT '',
        type TEXT NOT NULL,
        source_text TEXT DEFAULT '',
        voice TEXT DEFAULT '',
        result_text TEXT DEFAULT '',
        audio_path TEXT DEFAULT '',
        audio_size INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        hit_count INTEGER DEFAULT 0
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_key_hash ON cache_entries(key_hash)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_type ON cache_entries(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_accessed ON cache_entries(accessed_at)`);
    this.dirty = true;
    this.maybeSave();
  }

  /** 查询文本缓存（翻译/解释/词典） */
  getText(keyHash: string): string | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare(
        `SELECT result_text FROM cache_entries WHERE key_hash = ? AND type IN ('translate', 'explain', 'dict')`
      );
      stmt.bind([keyHash]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        this.touch(keyHash);
        return row.result_text as string;
      }
      stmt.free();
    } catch { /* Expected */ }
    return null;
  }

  /** 查询音频缓存路径 */
  getAudio(keyHash: string): string | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare(
        `SELECT audio_path FROM cache_entries WHERE key_hash = ? AND type = 'tts'`
      );
      stmt.bind([keyHash]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        this.touch(keyHash);
        return row.audio_path as string;
      }
      stmt.free();
    } catch { /* Expected */ }
    return null;
  }

  /** 写入文本缓存 */
  setText(keyHash: string, type: "translate" | "explain" | "dict", sourceText: string,
    resultText: string, provider = "", model = ""): void {
    if (!this.db) return;
    try {
      const now = Date.now();
      // Upsert
      const existing = this.getText(keyHash);
      if (existing) {
        this.db.run(
          `UPDATE cache_entries SET result_text = ?, accessed_at = ?, hit_count = hit_count + 1 WHERE key_hash = ?`,
          [resultText, now, keyHash]
        );
      } else {
        this.db.run(
          `INSERT INTO cache_entries (key_hash, provider, model, type, source_text, result_text, created_at, accessed_at, hit_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [keyHash, provider, model, type, sourceText, resultText, now, now]
        );
      }
      this.dirty = true;
    } catch { /* Expected */ }
  }

  /** 写入音频缓存 */
  setAudio(keyHash: string, sourceText: string, voice: string,
    audioPath: string, audioSize: number, provider = ""): void {
    if (!this.db) return;
    try {
      const now = Date.now();
      const existing = this.getAudio(keyHash);
      if (existing) {
        this.db.run(
          `UPDATE cache_entries SET audio_path = ?, audio_size = ?, accessed_at = ?, hit_count = hit_count + 1 WHERE key_hash = ?`,
          [audioPath, audioSize, now, keyHash]
        );
      } else {
        this.db.run(
          `INSERT INTO cache_entries (key_hash, provider, model, type, source_text, voice, audio_path, audio_size, created_at, accessed_at, hit_count)
           VALUES (?, ?, '', 'tts', ?, ?, ?, ?, ?, ?, 1)`,
          [keyHash, provider, sourceText, voice, audioPath, audioSize, now, now]
        );
      }
      this.dirty = true;
    } catch { /* Expected */ }
  }

  /** 记录访问时间 */
  private touch(keyHash: string): void {
    if (!this.db) return;
    try {
      this.db.run(
        `UPDATE cache_entries SET accessed_at = ?, hit_count = hit_count + 1 WHERE key_hash = ?`,
        [Date.now(), keyHash]
      );
      this.dirty = true;
    } catch { /* Expected */ }
  }

  /** 删除单条缓存 */
  delete(keyHash: string): boolean {
    if (!this.db) return false;
    try {
      this.db.run(`DELETE FROM cache_entries WHERE key_hash = ?`, [keyHash]);
      const changes = this.db.getRowsModified();
      this.dirty = true;
      return changes > 0;
    } catch { return false; }
  }

  /** 按类型清除缓存 */
  clearByType(type?: string): number {
    if (!this.db) return 0;
    try {
      if (type) {
        this.db.run(`DELETE FROM cache_entries WHERE type = ?`, [type]);
      } else {
        this.db.run(`DELETE FROM cache_entries`);
      }
      const changes = this.db.getRowsModified();
      this.dirty = true;
      return changes;
    } catch { return 0; }
  }

  /** 缓存统计 */
  stats(): CacheStats {
    const st: CacheStats = { total_entries: 0, total_text_size: 0, total_audio_size: 0, by_type: {} };
    if (!this.db) return st;
    try {
      const rows = this.db.exec(
        `SELECT type, COUNT(*) as cnt, SUM(LENGTH(result_text)) as text_sz, SUM(audio_size) as audio_sz
         FROM cache_entries GROUP BY type`
      );
      if (rows.length) {
        for (const row of rows[0].values) {
          const [type, cnt, textSz, audioSz] = row;
          const count = Number(cnt) || 0;
          const tSize = Number(textSz) || 0;
          const aSize = Number(audioSz) || 0;
          st.by_type[type as string] = { count, size: tSize + aSize };
          st.total_entries += count;
          st.total_text_size += tSize;
          st.total_audio_size += aSize;
        }
      }
    } catch { /* Expected */ }
    return st;
  }

  /** 持久化到磁盘 */
  save(): void {
    if (!this.db || !this.dirty) return;
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
      this.dirty = false;
    } catch { /* Expected */ }
  }

  private saveTimer: number | null = null;

  /** 延迟保存（合并多次写入） */
  private maybeSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, 2000);
  }

  /** 立即保存并关闭 */
  close(): void {
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
    if (this.db) { this.db.close(); this.db = null; }
  }
}

/** 全局单例 */
let _cacheDB: CacheDB | null = null;

export function getCacheDB(): CacheDB | null {
  return _cacheDB;
}

export async function initCacheDB(dbPath: string, pluginDir: string): Promise<CacheDB> {
  if (_cacheDB) _cacheDB.close();
  _cacheDB = new CacheDB(dbPath, pluginDir);
  await _cacheDB.open();
  return _cacheDB;
}

export function closeCacheDB(): void {
  if (_cacheDB) { _cacheDB.close(); _cacheDB = null; }
}
