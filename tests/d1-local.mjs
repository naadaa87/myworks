// Cloudflare D1과 같은 모양의 작은 SQLite 어댑터 (로컬 시험용)
import { DatabaseSync } from "node:sqlite";
/* 실제 D1의 한도 — 로컬 SQLite에는 없어서 여기서 흉내 냅니다 (developers.cloudflare.com/d1/platform/limits)
   · SQL 함수 하나에 인수 32개까지 · 한 문장에 바인딩 값 100개까지 · 문장 길이 100KB까지 · LIKE 패턴 50바이트까지 */
const D1_FN = new Set(["json_object", "json_array", "json_insert", "json_set", "json_replace", "json_patch", "coalesce", "printf", "format", "max", "min", "ifnull", "iif", "instr", "replace", "substr", "char", "concat", "concat_ws"]);
export function d1Limits(sql, args) {
  if (sql.length > 100000) throw new Error("D1 limit: SQL statement too long");
  if (args && args.length > 100) throw new Error("D1 limit: too many SQL variables");
  if (args && /\b(LIKE|GLOB)\b/i.test(sql)) for (const a of args) if (typeof a === "string" && /^%|%$/.test(a) && Buffer.byteLength(a) > 50) throw new Error("D1 limit: LIKE or GLOB pattern too complex");
  const stack = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") { i++; while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) { if (sql[i] === "'" ) i++; i++; } continue; }
    if (ch === "(") { const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(sql.slice(Math.max(0, i - 40), i)); const fn = m ? m[1].toLowerCase() : ""; stack.push({ fn: D1_FN.has(fn) ? fn : "", n: 1, empty: true }); continue; }
    if (ch === ")") { const f = stack.pop(); if (f && f.fn && !f.empty && f.n > 32) throw new Error(`D1 limit: too many arguments on function ${f.fn} (${f.n})`); continue; }
    const top = stack[stack.length - 1];
    if (top) { if (ch === ",") top.n++; else if (!/\s/.test(ch)) top.empty = false; }
  }
}
export function makeD1(file = ":memory:") {
  const raw = new DatabaseSync(file);
  let qn = 0;
  const conv = v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a.map(conv)); }
    _st() { qn++; d1Limits(this.sql, this.args); return raw.prepare(this.sql); }
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
