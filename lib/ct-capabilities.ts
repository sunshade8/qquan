import { z } from "zod";
export const ctProductSchema = z.enum([
  "spot",
  "margin-cross",
  "margin-isolated",
  "usdm",
  "coinm",
  "options",
  "stock",
]);
export type CTProduct = z.infer<typeof ctProductSchema>;
export const ctTradeSettingsSchema = z.object({
  product: ctProductSchema,
  selectionMode: z.enum(['manual','agent']).default('manual'),
  directions: z.array(z.enum(['long','short'])).min(1).max(2),
  leverageMax: z.number().int().min(1).optional(),
  marginMode: z.enum(['cash','cross','isolated','premium','portfolio','portfolio-pro']).optional(),
  positionMode: z.enum(['one-way','hedge']).optional(),
  riskPct: z.number().min(.1).max(1).default(.5),
}).strict().superRefine((s,ctx)=>{
  if(['spot','stock'].includes(s.product)&&(s.directions.some(d=>d==='short')||s.leverageMax!==undefined||s.positionMode==='hedge'||s.marginMode&&s.marginMode!=='cash'))ctx.addIssue({code:'custom',message:'현금 상품에는 숏·레버리지·Hedge를 사용할 수 없습니다'});
});
const common = {
  venue: z.enum(["binance", "toss"]),
  network: z.enum(["mainnet", "testnet"]),
  instrumentId: z.string().min(1).max(80),
  base: z.string().min(1),
  quote: z.string().min(1),
  settlement: z.string().min(1),
  collateral: z.string().min(1),
};
const direction = z.enum(["long", "short"]);
export const ctInstrumentSchema = z
  .discriminatedUnion("product", [
    z.object({
      ...common,
      product: z.literal("spot"),
      direction: z.literal("long"),
      leverage: z.literal(1),
      marginMode: z.literal("cash"),
      positionMode: z.literal("one-way"),
    }),
    z.object({
      ...common,
      product: z.literal("stock"),
      venue: z.literal("toss"),
      direction: z.literal("long"),
      leverage: z.literal(1),
      marginMode: z.literal("cash"),
      positionMode: z.literal("one-way"),
    }),
    ...(["margin-cross", "margin-isolated"] as const).map((product) =>
      z.object({
        ...common,
        product: z.literal(product),
        direction,
        leverage: z.number().min(1),
        marginMode: z.literal(
          product === "margin-cross" ? "cross" : "isolated",
        ),
        positionMode: z.literal("one-way"),
      }),
    ),
    ...(["usdm", "coinm"] as const).map((product) =>
      z.object({
        ...common,
        product: z.literal(product),
        direction,
        leverage: z.number().min(1),
        marginMode: z.enum(["cross", "isolated"]),
        positionMode: z.enum(["one-way", "hedge"]),
        contractSize: z.number().positive(),
        expiry: z.number().int().positive().nullable(),
        collateralMode: z.enum([
          "single",
          "multi-asset",
          "portfolio",
          "portfolio-pro",
        ]),
      }),
    ),
    z.object({
      ...common,
      product: z.literal("options"),
      right: z.enum(["CALL", "PUT"]),
      strike: z.number().positive(),
      expiry: z.number().int().positive(),
      multiplier: z.number().positive(),
      contractSide: z.enum(["buy", "sell"]),
      underlyingView: z.enum(["up", "down", "neutral"]),
      marginMode: z.enum(["premium", "portfolio"]),
      positionMode: z.literal("one-way"),
    }),
  ])
  .superRefine((x, c) => {
    if (x.product !== "stock" && x.venue !== "binance")
      c.addIssue({ code: "custom", message: "코인 상품은 Binance입니다" });
    if (x.product === "coinm" && x.settlement !== x.base)
      c.addIssue({ code: "custom", message: "COIN-M은 기초 코인 결제입니다" });
  });
export type CTInstrument = z.infer<typeof ctInstrumentSchema>;
export const ctInstrumentKey = (i: CTInstrument) =>
  [
    i.venue,
    i.network,
    i.product,
    i.instrumentId,
    i.settlement,
    i.collateral,
  ].join(":");
export type CTCapability = {
  product: CTProduct;
  label: string;
  exchangeSupported: boolean | "unknown";
  accountPermission: boolean | "unknown";
  dataReady: boolean | "unknown";
  engineValidated: boolean;
  liveReady: boolean;
  checkedAt: string | null;
  reason: string[];
};
/** No permission is inferred from stored API-key existence. Runtime probes merge into this registry. */
export function ctCapabilities(): CTCapability[] {
  return (
    [
      "spot",
      "margin-cross",
      "margin-isolated",
      "usdm",
      "coinm",
      "options",
      "stock",
    ] as const
  ).map((product) => ({
    product,
    label: {
      spot: "Spot",
      "margin-cross": "Cross Margin",
      "margin-isolated": "Isolated Margin",
      usdm: "USDⓈ-M",
      coinm: "COIN-M",
      options: "Options",
      stock: "미국 현금 주식",
    }[product],
    exchangeSupported: product === "stock" ? true : "unknown",
    accountPermission: "unknown",
    dataReady: product === "spot" || product === "stock" ? "unknown" : false,
    engineValidated: product === "spot" || product === "stock",
    liveReady: false,
    checkedAt: null,
    reason:
      product === "spot" || product === "stock"
        ? ["불변 snapshot·상품별 계좌·실행기 검증 필요"]
        : ["상품별 역사 자료·회계·체결 통합 검증 필요"],
  }));
}
export function assertCTCapability(
  i: CTInstrument,
  c: CTCapability,
  mode: "research" | "shadow" | "paper" | "live",
) {
  ctInstrumentSchema.parse(i);
  if (c.product !== i.product) throw new Error("capability 상품 불일치");
  if (c.dataReady !== true || !c.engineValidated)
    throw new Error(c.reason.join(" · ") || "데이터/엔진 검증 필요");
  if (mode === "live" && (c.accountPermission !== true || !c.liveReady))
    throw new Error("실계좌 권한/실전 검증 필요");
}
