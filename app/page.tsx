import { QuantWorkspace } from "./quant-workspace";

export default async function Home({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const query=await searchParams;
  return <QuantWorkspace initialView={query?.ctTab?"invest":"market"} />;
}
