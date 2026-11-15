import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { inviteUrl } from "@/lib/discussions";
import DashboardClient, { type DiscussionCard } from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getSession();
  if (!user) redirect("/login?next=/dashboard");

  const rows = await prisma.discussion.findMany({
    where:
      user.role === "HOST"
        ? { hostId: user.id }
        : { participants: { some: { userId: user.id, removed: false } } },
    orderBy: [{ status: "asc" }, { scheduledAt: "desc" }],
    include: {
      host: { select: { name: true } },
      _count: {
        select: {
          participants: true,
          segments: { where: { status: "FINAL" } },
          evaluations: true,
        },
      },
    },
  });

  const discussions: DiscussionCard[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    topic: row.topic,
    status: row.status,
    mode: row.mode,
    joinCode: row.joinCode,
    inviteUrl: inviteUrl(row.joinCode),
    scheduledAt: row.scheduledAt.toISOString(),
    durationMin: row.durationMin,
    participantCount: row._count.participants,
    segmentCount: row._count.segments,
    evaluationCount: row._count.evaluations,
    hostName: row.host.name,
    isHost: row.hostId === user.id,
  }));

  return <DashboardClient user={user} discussions={discussions} />;
}
