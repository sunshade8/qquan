export async function POST() {
  return Response.json(
    {
      error: "실제 가격 데이터 공급자와 포인트인타임 유니버스가 연결되기 전에는 백테스트를 실행하지 않습니다.",
      code: "BACKTEST_DATA_NOT_CONNECTED",
    },
    { status: 503 },
  );
}
