"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const baseTab = "rounded-md px-3 py-1.5 text-sm transition-colors";
const activeTab = "bg-white/20 font-semibold text-white shadow-xs";
const idleTab = "text-white/90 hover:bg-white/10 hover:text-white";

export function NavLinks({ waiting, isAdmin }: { waiting: number; isAdmin: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const status = searchParams.get("status");

  const isNeutralise = pathname.startsWith("/neutralise") || pathname.startsWith("/jobs") || pathname.startsWith("/api-jobs");
  const isToCheck = (pathname === "/" && status === "To check") || /^\/documents\/[^/]+\/check/.test(pathname);
  const isLabels = pathname.startsWith("/labels");
  const isSettings = pathname.startsWith("/settings");
  const isLibrary =
    (pathname === "/" && status !== "To check") ||
    pathname.startsWith("/upload") ||
    pathname.startsWith("/dossiers") ||
    (pathname.startsWith("/documents/") && !isToCheck);

  return (
    <>
      <Link prefetch={false} href="/neutralise" className={`${baseTab} ${isNeutralise ? activeTab : idleTab}`}>
        Neutralise
      </Link>
      <Link prefetch={false} href="/?status=To%20check" className={`${baseTab} ${isToCheck ? activeTab : idleTab}`}>
        To check
        {waiting > 0 && (
          <span
            className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-amber-400 px-1.5 py-0.5 text-xs font-bold text-tmc"
            aria-label={`${waiting} waiting`}
          >
            {waiting}
          </span>
        )}
      </Link>
      <Link prefetch={false} href="/labels/new" className={`${baseTab} ${isLabels ? activeTab : idleTab}`}>
        Labels
      </Link>
      <Link prefetch={false} href="/" className={`${baseTab} ${isLibrary ? activeTab : idleTab}`}>
        Library
      </Link>
      {isAdmin && (
        <Link prefetch={false} href="/settings/users" className={`${baseTab} ${isSettings ? activeTab : idleTab}`}>
          Settings
        </Link>
      )}
    </>
  );
}
