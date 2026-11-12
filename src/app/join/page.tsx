import { getSession } from "@/lib/auth";
import JoinClient from "@/components/JoinClient";

export const dynamic = "force-dynamic";

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const params = await searchParams;
  const session = await getSession();

  return (
    <JoinClient
      initialCode={(params.code ?? "").trim().toUpperCase()}
      signedIn={Boolean(session)}
    />
  );
}
