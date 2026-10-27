import { createRequire } from 'node:module';

import { existsSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SendRecord, CommentTarget } from './platform.ts';
export class SendArchive {
  private parent: string;
  constructor(private file: string) {
    this.parent = realpathSync(dirname(file));
  }
  private withDb<T>(fn: (db: import('node:sqlite').DatabaseSync) => T): T {
    if (
      realpathSync(dirname(this.file)) !== this.parent ||
      lstatSync(dirname(this.file)).isSymbolicLink() ||
      (existsSync(this.file) && lstatSync(this.file).isSymbolicLink())
    )
      throw Error('归档路径异常，已保留原记录。');
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(this.file);
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY,operation_id TEXT,platform TEXT,account_id TEXT,owner_id TEXT,oid TEXT,parent TEXT,status TEXT,receipt_id TEXT,created_at TEXT,payload TEXT NOT NULL);CREATE INDEX IF NOT EXISTS send_operations ON sends(operation_id);CREATE INDEX IF NOT EXISTS send_targets ON sends(platform,account_id,oid,parent);',
      );
      return fn(db);
    } finally {
      db.close();
    }
  }
  put(records: SendRecord[]) {
    if (!records.length) return;
    this.withDb((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const q = db.prepare(
          'INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,receipt_id=excluded.receipt_id,payload=excluded.payload',
        );
        for (const r of records) {
          const payload = JSON.stringify(r);
          q.run(
            r.id,
            r.operationId ?? r.id,
            r.platform,
            r.accountId,
            r.focusOwnerId ?? '',
            r.target.oid,
            r.target.parent,
            r.status,
            r.receiptId ?? '',
            r.createdAt,
            payload,
          );
          if (
            (db.prepare('SELECT payload FROM sends WHERE id=?').get(r.id) as any)?.payload !==
            payload
          )
            throw Error('归档核验失败，原记录保留。');
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    });
  }
  get(id: string) {
    return this.select('id=?', [id])[0];
  }
  operation(id: string) {
    return this.select('operation_id=?', [id]);
  }
  private select(where: string, values: string[]) {
    if (!existsSync(this.file)) return [];
    return this.withDb((db) =>
      (
        db
          .prepare('SELECT payload FROM sends WHERE ' + where + ' ORDER BY rowid')
          .all(...values) as Array<{ payload: string }>
      ).map((r) => JSON.parse(r.payload) as SendRecord),
    );
  }
  has(platform: string, account: string, oid: string, parent?: string, owner?: string) {
    if (!existsSync(this.file)) return false;
    return this.withDb((db) => {
      let sql = 'SELECT 1 FROM sends WHERE platform=? AND account_id=? AND oid=? AND status<>?';
      const args = [platform, account, oid, 'rejected'];
      if (parent !== undefined) {
        sql += ' AND parent=?';
        args.push(parent);
      }
      if (owner !== undefined) {
        sql += ' AND owner_id=?';
        args.push(owner);
      }
      return Boolean(db.prepare(sql + ' LIMIT 1').get(...args));
    });
  }
  receipt(platform: string, account: string, id: string) {
    if (!existsSync(this.file)) return false;
    return this.withDb((db) =>
      Boolean(
        db
          .prepare('SELECT 1 FROM sends WHERE platform=? AND account_id=? AND receipt_id=? LIMIT 1')
          .get(platform, account, id),
      ),
    );
  }
  page(limit: number, offset: number) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1000000
    )
      throw Error('归档分页范围无效。');
    if (!existsSync(this.file)) return [];
    return this.withDb((db) =>
      (
        db
          .prepare('SELECT payload FROM sends ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?')
          .all(limit, offset) as Array<{ payload: string }>
      ).map((r) => JSON.parse(r.payload) as SendRecord),
    );
  }
  status() {
    if (!existsSync(this.file)) return { count: 0, sent: 0, bytes: 0 };
    return this.withDb((db) => {
      const s = db
        .prepare(
          "SELECT COUNT(*) AS count,SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent FROM sends",
        )
        .get() as { count: number; sent: number };
      return { count: s.count, sent: s.sent ?? 0, bytes: statSync(this.file).size };
    });
  }
}
