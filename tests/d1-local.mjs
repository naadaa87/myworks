// Cloudflare D1과 같은 모양의 작은 SQLite 어댑터 (로컬 시험용)
import { DatabaseSync } from "node:sqlite";
export function makeD1(file = ":memory:") {
  const raw = new DatabaseSync(file);
  let qn = 0;
  const conv = v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a.map(conv)); }
    _st() { qn++; return raw.prepare(this.sql); }
    async first(col) { const r = this._st().get(...this.args); if (!r) return null; const o = { ...r }; return col ? o[col] : o; }
    async all() { return { results: this._st().all(...this.args).map(r => ({ ...r })), success: true }; }
    async run() { const r = this._st().run(...this.args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
    _exec() { const st = this._st(); if (/^\s*(SELECT|PRAGMA|WITH)/i.test(this.sql) || /RETURNING/i.test(this.sql)) return { results: st.all(...this.args).map(r => ({ ...r })), success: true }; const r = st.run(...this.args); return { results: [], success: true, meta: { changes: Number(r.changes) } }; }
  }
  return {
    raw, get queries() { return qn; }, resetCount() { qn = 0; },
    prepare: sql => new Stmt(sql),
    async batch(list) { raw.exec("BEGIN"); try { const out = list.map(s => s._exec()); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
    async exec(sql) { const parts = sql.split("\n").map(s => s.trim()).filter(Boolean); for (const s of parts) { qn++; raw.exec(s); } return { count: parts.length }; }
  };
}
