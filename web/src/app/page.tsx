import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
      <h1 className="mb-2 font-mono text-5xl font-bold tracking-widest text-white">
        [ ONE OF ONE ]
      </h1>
      <p className="mb-12 text-sm text-neutral-500 tracking-wide">
        AI-powered sports predictions
      </p>
      <div className="flex gap-6">
        <Link
          href="/nba"
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-10 py-5 text-lg font-semibold text-white transition-all hover:border-neutral-500 hover:bg-neutral-800"
        >
          NBA
        </Link>
        <Link
          href="/mlb"
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-10 py-5 text-lg font-semibold text-white transition-all hover:border-neutral-500 hover:bg-neutral-800"
        >
          MLB
        </Link>
      </div>
    </div>
  );
}
