import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { logout } from "@/app/actions";
import type { CurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { countToCheck } from "@/lib/documents/service";
import { NavLinks } from "./nav-links";

const tabFallback = "rounded-md px-3 py-1.5 text-sm text-white/90 hover:bg-white/10";

function NavFallback({ waiting, isAdmin }: { waiting: number; isAdmin: boolean }) {
  return (
    <>
      <Link prefetch={false} href="/neutralise" className={tabFallback}>
        Neutralise
      </Link>
      <Link prefetch={false} href="/?status=To%20check" className={tabFallback}>
        To check
        {waiting > 0 && (
          <span className="ml-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-xs font-bold text-tmc" aria-label={`${waiting} waiting`}>
            {waiting}
          </span>
        )}
      </Link>
      <Link prefetch={false} href="/labels/new" className={tabFallback}>
        Labels
      </Link>
      <Link prefetch={false} href="/" className={tabFallback}>
        Library
      </Link>
      {isAdmin && (
        <Link prefetch={false} href="/settings/users" className={tabFallback}>
          Settings
        </Link>
      )}
    </>
  );
}

// Five tabs, in the order of the work (Willem 22/10): Jobs is part of Neutralise, Upload is a
// button in the Library.
export async function AppHeader({ user, wide = false }: { user: CurrentUser; wide?: boolean }) {
  const waiting = await countToCheck(await getDb());
  const container = wide ? "max-w-[1800px]" : "max-w-7xl";
  return (
    <header className="border-b border-white/10 bg-tmc text-white shadow-sm">
      <div className={`mx-auto flex ${container} flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6`}>
        <Link prefetch={false} href="/" className="flex items-center gap-3">
          <span className="rounded-md bg-white p-1 shadow-xs">
            <Image src="/tmc-logo.png" alt="Transmare Chemie" width={295} height={280} className="h-8 w-auto" />
          </span>
          <div className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight sm:text-base">Document Center</span>
            <span className="hidden text-[11px] text-white/70 sm:block">Transmare Chemie</span>
          </div>
        </Link>
        {/* no prefetch: the pages that refresh themselves would load every menu page each time */}
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          <Suspense fallback={<NavFallback waiting={waiting} isAdmin={user.role === "admin"} />}>
            <NavLinks waiting={waiting} isAdmin={user.role === "admin"} />
          </Suspense>
          <span className="mx-1 hidden h-4 w-px bg-white/20 sm:inline-block" aria-hidden />
          <Link prefetch={false} href="/account/password" className={`hidden sm:inline ${tabFallback}`} title="Change password">
            {user.name}
          </Link>
          <form action={logout}>
            <button
              type="submit"
              className="rounded-md border border-white/30 px-3 py-1.5 text-sm text-white/95 transition-colors hover:bg-white/10"
            >
              Log out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}

export function PageShell({
  user,
  wide = false,
  children,
}: {
  user: CurrentUser;
  /** Full-width workstation container (Check and Document side-by-side views). */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const container = wide ? "max-w-[1800px]" : "max-w-7xl";
  return (
    <>
      <AppHeader user={user} wide={wide} />
      <main className={`mx-auto w-full ${container} flex-1 px-4 py-5 sm:px-6`}>{children}</main>
    </>
  );
}
