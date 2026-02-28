import Link from "next/link";
import ParticleMesh from "@/components/ParticleMesh";

export default function HomepagePreview() {
  return (
    <div
      className="relative -mt-8"
      style={{ width: "100vw", marginLeft: "calc(-50vw + 50%)" }}
    >
      {/* ═══════════════════════════════════════════════
          HERO
          ═══════════════════════════════════════════════ */}
      <section className="relative flex min-h-[92vh] flex-col items-center justify-center overflow-hidden px-6 text-center">
        {/* Animated particle mesh */}
        <ParticleMesh />

        <div className="relative z-10 max-w-3xl">
          <p className="mb-8 font-mono text-[11px] uppercase tracking-[0.35em] text-neutral-600">
            [ one of one ]
          </p>
          <h1 className="mb-6 text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl md:text-[80px]">
            Algorithmic
            <br /> sports betting.
          </h1>
          <p className="mx-auto mb-14 flex items-center justify-center gap-3 text-sm tracking-wide text-neutral-400 md:gap-4 md:text-base">
            <span>Quantitative Models</span>
            <span className="text-neutral-700">|</span>
            <span>Computed Edge</span>
            <span className="text-neutral-700">|</span>
            <span>Direct Execution</span>
          </p>
          <Link
            href="/signals"
            className="group inline-flex items-center gap-2.5 rounded-full bg-white px-8 py-3.5 text-sm font-medium tracking-wide text-neutral-950 transition-all hover:scale-[1.02] hover:bg-neutral-200"
          >
            View today&apos;s predictions
            <span className="text-neutral-400 transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
        </div>

        {/* Scroll hint */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
          <div className="h-8 w-px bg-gradient-to-b from-neutral-700 to-transparent" />
        </div>
      </section>

      {/* Gradient divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-neutral-800 to-transparent" />

      {/* ═══════════════════════════════════════════════
          PRODUCT TIERS — "The Platform"
          ═══════════════════════════════════════════════ */}
      <section className="mx-auto max-w-5xl px-6 py-28 md:py-36">
        <div className="mb-20 text-center">
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.35em] text-neutral-600">
            The platform
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
            From signal to execution.
          </h2>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {/* ── Signal ── */}
          <div className="group rounded-xl border border-neutral-800/80 bg-neutral-950 p-8 transition-all duration-300 hover:border-neutral-700 hover:bg-[#0d0d0d]">
            <div className="mb-8 flex items-center justify-between">
              <span className="font-mono text-xs tracking-[0.2em] text-neutral-700">
                01
              </span>
              <span className="rounded-full border border-green-500/20 bg-green-500/5 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-green-400">
                Free
              </span>
            </div>
            <h3 className="mb-3 text-lg font-semibold text-white">
              The Signal
            </h3>
            <p className="mb-8 text-sm leading-relaxed text-neutral-500">
              Daily pregame predictions powered by machine learning. Model
              probability, market price, and calculated edge — for every game,
              every day.
            </p>
            <Link
              href="/signals"
              className="group/link inline-flex items-center gap-1.5 text-sm text-neutral-400 transition-colors hover:text-white"
            >
              View predictions
              <span className="transition-transform group-hover/link:translate-x-0.5">
                →
              </span>
            </Link>
          </div>

          {/* ── Terminal ── */}
          <div className="group rounded-xl border border-neutral-800/80 bg-neutral-950 p-8 transition-all duration-300 hover:border-neutral-700 hover:bg-[#0d0d0d]">
            <div className="mb-8 flex items-center justify-between">
              <span className="font-mono text-xs tracking-[0.2em] text-neutral-700">
                02
              </span>
              <span className="rounded-full border border-neutral-700/50 bg-neutral-800/30 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-neutral-400">
                Subscription
              </span>
            </div>
            <h3 className="mb-3 text-lg font-semibold text-white">Terminal</h3>
            <p className="mb-8 text-sm leading-relaxed text-neutral-500">
              Execute against live markets. Connect your exchange keys, match
              predictions to open positions, and place orders with calculated
              sizing.
            </p>
            <Link
              href="/terminal"
              className="group/link inline-flex items-center gap-1.5 text-sm text-neutral-400 transition-colors hover:text-white"
            >
              Open terminal
              <span className="transition-transform group-hover/link:translate-x-0.5">
                →
              </span>
            </Link>
          </div>

          {/* ── Autopilot ── */}
          <div className="group relative rounded-xl border border-neutral-800/80 bg-neutral-950 p-8 transition-all duration-300 hover:border-neutral-700 hover:bg-[#0d0d0d]">
            <div className="mb-8 flex items-center justify-between">
              <span className="font-mono text-xs tracking-[0.2em] text-neutral-700">
                03
              </span>
              <span className="rounded-full border border-neutral-800/50 bg-neutral-900/40 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-neutral-700">
                Coming Soon
              </span>
            </div>
            <h3 className="mb-3 text-lg font-semibold text-white">
              Autopilot
            </h3>
            <p className="mb-8 text-sm leading-relaxed text-neutral-500">
              Autonomous arbitrage detection. Real-time market scanning with
              algorithmic execution — set the parameters and let the system
              work.
            </p>
            <span className="inline-flex items-center gap-1.5 text-sm text-neutral-700">
              Join waitlist →
            </span>
          </div>
        </div>
      </section>

      {/* Gradient divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-neutral-800 to-transparent" />

      {/* ═══════════════════════════════════════════════
          METHODOLOGY
          ═══════════════════════════════════════════════ */}
      <section>
        <div className="mx-auto max-w-xl px-6 py-28 text-center md:py-32">
          <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.35em] text-neutral-700">
            Methodology
          </p>
          <p className="text-lg leading-relaxed text-neutral-300 md:text-xl">
            Every prediction is the output of a system — not a person&apos;s
            intuition. Gradient-boosted models trained on six seasons of
            play-by-play data, validated out-of-sample, and recalibrated weekly.
          </p>
          <p className="mt-6 text-sm text-neutral-600">
            No gut feelings. No expert picks. Just math.
          </p>
        </div>
      </section>

      {/* Gradient divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-neutral-800 to-transparent" />

      {/* ═══════════════════════════════════════════════
          FINAL CTA (compact)
          ═══════════════════════════════════════════════ */}
      <section>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center md:py-28">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight text-white md:text-3xl">
            The signal is live.
          </h2>
          <p className="mb-10 text-sm text-neutral-500">
            Predictions update daily. The edge won&apos;t wait.
          </p>
          <Link
            href="/signals"
            className="group inline-flex items-center gap-2.5 rounded-full bg-white px-8 py-3.5 text-sm font-medium tracking-wide text-neutral-950 transition-all hover:scale-[1.02] hover:bg-neutral-200"
          >
            Get started
            <span className="text-neutral-400 transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════
          FOOTER
          ═══════════════════════════════════════════════ */}
      <footer className="border-t border-neutral-800/50">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8">
          <span className="font-mono text-[11px] tracking-[0.25em] text-neutral-700">
            [ ONE OF ONE ]
          </span>
          <div className="flex items-center gap-4">
            <Link
              href="/privacy"
              className="text-[11px] text-neutral-700 transition-colors hover:text-neutral-500"
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms"
              className="text-[11px] text-neutral-700 transition-colors hover:text-neutral-500"
            >
              Terms &amp; Conditions
            </Link>
            <span className="text-[11px] text-neutral-800">© 2026</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
