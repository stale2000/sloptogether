import { WorkerPairing } from "@/components/worker-pairing";

export default async function WorkerPairingPage({ searchParams }: { searchParams: Promise<{ pair?: string | string[] }> }) {
  const values=await searchParams;
  const pairId=Array.isArray(values.pair)?values.pair[0]??"":values.pair??"";
  return <WorkerPairing pairingId={pairId}/>;
}
