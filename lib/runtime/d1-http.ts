/** D1 REST adapter for Node; SQL stays parameterized and batch is one request. */
type Query = { sql: string; params: unknown[] };
type Result = {
  success: boolean;
  results: Record<string, unknown>[];
  meta: { changes: number; [key: string]: unknown };
};
export class D1HttpDatabase {
  constructor(privateSettings: () => Record<string, string | undefined>) {
    this.settings = privateSettings;
  }
  private settings: () => Record<string, string | undefined>;
  async query(queries: Query[]): Promise<Result[]> {
    const settings = this.settings(),
      account = settings.CLOUDFLARE_ACCOUNT_ID,
      id = settings.CLOUDFLARE_D1_DATABASE_ID,
      token = settings.CLOUDFLARE_D1_API_TOKEN;
    if (!account || !id || !token)
      throw new Error(
        "Vercel D1 연결 미설정: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_D1_API_TOKEN 필요",
      );
    if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9-]{36}$/i.test(id))
      throw new Error("D1 연결 식별자 형식 오류");
    // Never retry a mutation after an ambiguous network response.
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ batch: queries }),
        signal: AbortSignal.timeout(30000),
      },
    );
    const body = (await response.json()) as {
      success: boolean;
      result?: Result[];
      errors?: Array<{ code: number; message: string }>;
    };
    if (
      !response.ok ||
      !body.success ||
      body.result?.length !== queries.length ||
      body.result.some((r) => !r.success)
    )
      throw new Error(
        `D1 API 실패 (${response.status}) · ${body.errors?.map((e) => e.code).join(",") ?? "결과 불일치"}`,
      );
    return body.result;
  }
  prepare(sql: string) {
    return new D1HttpStatement(this, sql);
  }
  batch(statements: D1HttpStatement[]) {
    if (statements.some((s) => s.database !== this))
      throw new Error("다른 DB batch 거부");
    return this.query(
      statements.map((s) => ({ sql: s.sql, params: s.params })),
    );
  }
  async exec(sql: string) {
    const results = await this.query([{ sql, params: [] }]);
    return {
      count: results.length,
      duration: results.reduce(
        (sum, r) => sum + Number(r.meta.duration ?? 0),
        0,
      ),
    };
  }
}
export class D1HttpStatement {
  constructor(database: D1HttpDatabase, sql: string, params: unknown[] = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }
  readonly database: D1HttpDatabase;
  readonly sql: string;
  readonly params: unknown[];
  bind(...params: unknown[]) {
    if (
      params.some(
        (p) =>
          p !== null &&
          typeof p !== "string" &&
          (typeof p !== "number" || !Number.isFinite(p)),
      )
    )
      throw new Error("D1 지원하지 않는 파라미터");
    return new D1HttpStatement(this.database, this.sql, params);
  }
  async all() {
    return (
      await this.database.query([{ sql: this.sql, params: this.params }])
    )[0];
  }
  run() {
    return this.all();
  }
  async first(column?: string) {
    const row = (await this.all()).results[0];
    return column ? (row?.[column] ?? null) : (row ?? null);
  }
  async raw(options?: { columnNames?: boolean }) {
    const rows = (await this.all()).results;
    return options?.columnNames && rows.length
      ? [Object.keys(rows[0]), ...rows.map(Object.values)]
      : rows.map(Object.values);
  }
}
