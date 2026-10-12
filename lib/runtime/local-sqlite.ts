import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
export const dataDirectory = () =>
  resolve(process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"));
/** D1-compatible contract; batches are real cross-process SQLite transactions. */
export class LocalDatabase {
  private connection?: DatabaseSync;
  get db() {
    if (process.env.VERCEL)
      throw new Error(
        "연구 DB는 사용자 컴퓨터에서만 실행합니다: npm run local",
      );
    if (!this.connection) {
      const dir = join(dataDirectory(), "state");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.connection = new DatabaseSync(join(dir, "research.sqlite"));
      this.connection.exec(
        "PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
    }
    return this.connection;
  }
  prepare(sql: string) {
    return new LocalStatement(this, sql);
  }
  async batch(statements: LocalStatement[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((s) => {
        if (s.database !== this) throw new Error("다른 DB batch");
        return s.execute();
      });
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
}
class LocalStatement {
  readonly database: LocalDatabase;
  readonly sql: string;
  readonly params: (string | number | null)[];
  constructor(
    database: LocalDatabase,
    sql: string,
    params: (string | number | null)[] = [],
  ) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }
  bind(...params: (string | number | null)[]) {
    return new LocalStatement(this.database, this.sql, params);
  }
  execute() {
    const statement = this.database.db.prepare(this.sql);
    if (statement.columns().length) {
      const rows = statement.all(...this.params);
      const changes = Number(
        this.database.db.prepare("SELECT changes() AS n").get()?.n ?? 0,
      );
      return { success: true, results: rows, meta: { changes } };
    }
    const r = statement.run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(r.changes),
        last_row_id: Number(r.lastInsertRowid),
      },
    };
  }
  async all() {
    return this.execute();
  }
  async run() {
    return this.execute();
  }
  async first(column?: string) {
    const row = this.execute().results[0];
    return column ? (row?.[column] ?? null) : (row ?? null);
  }
  async raw(options?: { columnNames?: boolean }) {
    const statement = this.database.db.prepare(this.sql);
    const rows = statement.all(...this.params).map(Object.values);
    return options?.columnNames
      ? [statement.columns().map((c) => c.name), ...rows]
      : rows;
  }
}
