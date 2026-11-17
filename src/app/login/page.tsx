import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AuthPanel from "@/components/AuthPanel";
import ThemeToggle from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/dashboard");

  const params = await searchParams;
  // Only allow same-site relative redirects.
  const nextPath = params.next?.startsWith("/") ? params.next : "/dashboard";

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col items-center px-5 py-10">
      <header className="mb-8 flex w-full max-w-md items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-lg font-bold text-[#06170f]">
            Q
          </span>
          <span className="text-lg font-semibold tracking-tight">Quorum</span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/" className="text-sm text-muted hover:text-ink">
            Back to home
          </Link>
        </div>
      </header>

      <AuthPanel nextPath={nextPath} />
    </main>
  );
}
