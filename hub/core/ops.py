"""统一操作台账（ops 表）：四模块共用的审计流水。

- 写：log_op(store, module=..., action=..., status=...)
- 查：query_ops(...) 支持 module/status/target/source/since/关键词/分页
- 导出：export_ops(fmt='json'|'csv')
"""
import csv
import io
import json
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  module TEXT NOT NULL,            -- sessions | memory | skills | mcp | system
  action TEXT NOT NULL,            -- pull | update | rollback | distribute | verify | config | ...
  status TEXT NOT NULL,            -- ok | failed | skipped | conflict | info
  item_kind TEXT,                  -- skill | mcp
  item_name TEXT,
  item_version TEXT,
  source_id INTEGER,
  target_id INTEGER,
  reason TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_module_ts ON ops(module, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ops_status ON ops(status);
"""


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def ensure_schema(store):
    from hub.core import schema as _schema
    _schema.ensure(store)


def log_op(store, module, action, status="ok", item_kind=None, item_name=None,
           item_version=None, source_id=None, target_id=None, reason=None, detail=None,
           actor="local"):
    with store.lock:
        store.db.execute(
            "INSERT INTO ops(ts, module, action, status, item_kind, item_name, item_version, "
            "source_id, target_id, reason, detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (now_iso(), module, action, status, item_kind, item_name, item_version,
             source_id, target_id, reason,
             json.dumps({"actor": actor, "extra": detail}, ensure_ascii=False) if detail is not None else None))
        store.db.commit()


def query_ops(store, module=None, status=None, target_id=None, source_id=None,
              since=None, q=None, limit=100, offset=0):
    sql = "SELECT o.*, t.name AS target_name, s.name AS source_name FROM ops o " \
          "LEFT JOIN targets t ON t.id = o.target_id " \
          "LEFT JOIN sources s ON s.id = o.source_id WHERE 1=1"
    args = []
    if module and module != "all":
        sql += " AND o.module=?"
        args.append(module)
    if status and status != "all":
        sql += " AND o.status=?"
        args.append(status)
    if target_id:
        sql += " AND o.target_id=?"
        args.append(target_id)
    if source_id:
        sql += " AND o.source_id=?"
        args.append(source_id)
    if since:
        sql += " AND o.ts>=?"
        args.append(since)
    if q:
        sql += " AND (o.item_name LIKE ? OR o.action LIKE ? OR o.reason LIKE ?)"
        like = "%" + q + "%"
        args.extend([like, like, like])
    count_sql = sql.replace(
        "SELECT o.*, t.name AS target_name, s.name AS source_name", "SELECT COUNT(*)", 1)
    count_sql = count_sql.split(" ORDER BY")[0]
    with store.lock:
        total = store.db.execute(count_sql, args).fetchone()[0]
        sql += " ORDER BY o.id DESC LIMIT ? OFFSET ?"
        rows = [dict(r) for r in store.db.execute(sql, args + [limit, offset]).fetchall()]
    for r in rows:
        if r.get("detail"):
            try:
                d = json.loads(r["detail"])
                r["actor"] = d.get("actor", "local")
                if isinstance(d.get("extra"), dict):
                    r["extra"] = d["extra"]
            except Exception:
                pass
    return {"total": total, "items": rows}


def export_ops(store, fmt="json", **filters):
    data = query_ops(store, limit=100000, **{k: v for k, v in filters.items() if k in
                    ("module", "status", "target_id", "source_id", "since", "q")})
    items = data["items"]
    if fmt == "csv":
        buf = io.StringIO()
        cols = ["id", "ts", "module", "action", "status", "item_kind", "item_name",
                "item_version", "source_name", "target_name", "reason"]
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for it in items:
            w.writerow({k: it.get(k) for k in cols})
        return buf.getvalue(), "text/csv"
    return json.dumps({"total": data["total"], "items": items},
                      ensure_ascii=False, indent=2), "application/json"
