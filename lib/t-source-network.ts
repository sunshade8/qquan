/** On Node, pin a checked DNS address so a public document cannot rebind to a private service. */
export function ctPublicAddress(address: string) {
  if (address.includes(":"))
    return (
      /^[23][a-f0-9]{3}:/i.test(address) && !/^2001:(?:0:|db8:)/i.test(address)
    );
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return false;
  const [a, b] = octets;
  return (
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0)
  );
}
export async function fetchCTSource(url: URL) {
  if (!process.env.VERCEL && process.env.QQUAN_RUNTIME !== "node")
    return fetch(url, {
      redirect: "manual",
      headers: { accept: "text/html,text/plain,application/xhtml+xml" },
      signal: AbortSignal.timeout(15000),
    });
  const [{ lookup }, { request }, { Readable }] = await Promise.all([
    import("node:dns/promises"),
    import("node:https"),
    import("node:stream"),
  ]);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !ctPublicAddress(a.address)))
    throw new Error("공개 자료 비공개 네트워크 주소 차단");
  const address = addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(15000),
        headers: { accept: "text/html,text/plain,application/xhtml+xml" },
        lookup: ((
          _host: unknown,
          _options: { all?: boolean },
          callback: (error: null, result: unknown, family?: number) => void,
        ) => {
          if (_options.all)
            callback(null, [
              { address: address.address, family: address.family },
            ]);
          else callback(null, address.address, address.family);
        }) as never,
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(",") : value);
        resolve(
          new Response(
            [204, 205, 304].includes(res.statusCode ?? 0)
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            {
              status: res.statusCode ?? 502,
              headers,
            },
          ),
        );
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error("자료 읽기 시간 초과")));
    req.on("error", reject);
    req.end();
  });
}
