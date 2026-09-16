import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[620px] flex-col items-center px-4 py-24 text-center sm:px-6">
      <p className="text-[13px] font-bold uppercase tracking-[0.14em] text-primary">
        404
      </p>
      <h1 className="mt-3 text-[30px] font-extrabold tracking-[-0.03em] text-ink">
        We could not find that page
      </h1>
      <p className="mt-3 text-sm text-muted">
        The link may be out of date. Your renders are safe in History.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <Link
          href="/"
          className="inline-flex h-11 items-center rounded-[12px] bg-primary-strong px-4 text-sm font-semibold text-white hover:bg-primary-dark"
        >
          Back home
        </Link>
        <Link
          href="/history"
          className="inline-flex h-11 items-center rounded-[12px] border border-border-strong bg-raised px-4 text-sm font-semibold text-ink hover:border-muted"
        >
          Open History
        </Link>
      </div>
    </div>
  );
}