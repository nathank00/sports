import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "[ EDGEMASTER ] — How To",
};

export default function HowToPage() {
  return (
    <div className="mx-auto max-w-2xl font-mono text-neutral-300">
      <Link
        href="/"
        className="mb-8 inline-block text-xs text-neutral-600 transition-colors hover:text-neutral-400"
      >
        &larr; Back
      </Link>

      <h1 className="mb-2 text-2xl font-bold tracking-wider text-white">
        How To
      </h1>
      <p className="mb-10 text-sm text-neutral-500">
        Setup guides for the Terminal and Autopilot.
      </p>

      {/* ── Terminal ─────────────────────────────────────────────── */}
      <section id="terminal" className="mb-14">
        <h2 className="mb-4 text-lg font-bold tracking-wider text-white border-b border-neutral-800 pb-2">
          Terminal Setup
        </h2>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          1. Generate Kalshi API Keys
        </h3>
        <ol className="list-decimal list-inside space-y-1.5 text-sm text-neutral-400 ml-2">
          <li>
            Log in to{" "}
            <span className="text-neutral-300">kalshi.com</span> and go to{" "}
            <span className="text-neutral-300">Settings &rarr; API Keys</span>.
          </li>
          <li>
            Click <span className="text-neutral-300">Generate New Key</span>.
            Kalshi will provide a <span className="text-neutral-300">Key ID</span>{" "}
            and a <span className="text-neutral-300">PEM private key file</span>{" "}
            download.
          </li>
          <li>
            Save the PEM file somewhere safe. You will upload it in the next step.
            Kalshi will not show it again.
          </li>
        </ol>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          2. Connect in Terminal Settings
        </h3>
        <ol className="list-decimal list-inside space-y-1.5 text-sm text-neutral-400 ml-2">
          <li>
            Open the <span className="text-neutral-300">Terminal</span> page and
            switch to the <span className="text-neutral-300">Settings</span> tab.
          </li>
          <li>
            Paste your <span className="text-neutral-300">Key ID</span> into the
            Key ID field.
          </li>
          <li>
            Click <span className="text-neutral-300">Upload PEM file</span> and
            select the private key file you downloaded from Kalshi.
          </li>
          <li>
            Click <span className="text-neutral-300">Test Connection</span> to
            verify. You should see your Kalshi balance displayed.
          </li>
        </ol>
        <p className="mt-3 text-xs text-neutral-600">
          Your private key is imported into the browser&apos;s native Web Crypto API and
          stored in IndexedDB. It never leaves your device or touches our servers. All
          Kalshi requests are signed client-side.
        </p>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          3. Configure Trading Settings
        </h3>
        <div className="space-y-3 text-sm text-neutral-400 ml-2">
          <div>
            <span className="text-neutral-200">Edge Threshold (%)</span> — The
            minimum edge required before the system recommends a trade. Edge is the
            difference between the model&apos;s win probability and the Kalshi market
            price, minus fees. Higher values mean fewer but higher-confidence trades.
          </div>
          <div>
            <span className="text-neutral-200">Position Sizing</span> — Choose
            between <span className="text-neutral-300">By Contracts</span> (buy a
            fixed number of contracts each trade) or{" "}
            <span className="text-neutral-300">By Dollars</span> (spend up to a
            fixed dollar amount, with the contract count calculated from the ask
            price).
          </div>
          <div>
            <span className="text-neutral-200">Bet Amount</span> — The number of
            contracts or dollar amount per trade, depending on your sizing mode.
          </div>
        </div>
      </section>

      {/* ── Autopilot ────────────────────────────────────────────── */}
      <section id="autopilot" className="mb-14">
        <h2 className="mb-4 text-lg font-bold tracking-wider text-white border-b border-neutral-800 pb-2">
          Autopilot Setup
        </h2>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          1. Connect Kalshi API Keys
        </h3>
        <p className="text-sm text-neutral-400 ml-2">
          Autopilot uses the same Kalshi keys as the Terminal. If you&apos;ve already
          set up your keys in Terminal Settings, you&apos;re good to go. If not,
          follow the{" "}
          <a href="#terminal" className="text-neutral-300 underline underline-offset-2">
            Terminal Setup
          </a>{" "}
          steps above first.
        </p>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          2. Auto-Execute Toggle
        </h3>
        <p className="text-sm text-neutral-400 ml-2">
          The main toggle at the top of the Autopilot page controls whether trades
          are placed automatically. When{" "}
          <span className="text-neutral-300">OFF</span>, you&apos;ll see live signals
          and model predictions but no orders will be fired. When{" "}
          <span className="text-neutral-300">ON</span>, the system will
          automatically place buy and sell orders on Kalshi when conditions are met.
          NBA and MLB have independent toggles.
        </p>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          3. Configure Execution Settings
        </h3>
        <div className="space-y-3 text-sm text-neutral-400 ml-2">
          <div>
            <span className="text-neutral-200">Min Edge (%)</span> — The minimum
            edge required to trigger a buy. The model must see at least this much
            edge over the Kalshi price (after fees) before placing an order.
          </div>
          <div>
            <span className="text-neutral-200">Bet Amount ($)</span> — How much to
            spend per trade. The system calculates the number of contracts based on
            the current ask price.
          </div>
          <div>
            <span className="text-neutral-200">Max Contracts / Bet</span> — Upper
            limit on contracts per order, regardless of bet amount. Prevents
            oversized positions in low-priced markets.
          </div>
          <div>
            <span className="text-neutral-200">Sizing Mode</span> — Same as
            Terminal: choose between a fixed dollar amount or a fixed contract count
            per trade.
          </div>
          <div>
            <span className="text-neutral-200">Take Profit (c/contract)</span> — When
            the current bid rises this many cents above your entry price, the system
            automatically sells to lock in profit. For example, 8c means if you
            bought at 50c and the bid hits 58c, it sells.
          </div>
          <div>
            <span className="text-neutral-200">Stop Loss (c/contract)</span> — When
            the current bid drops this many cents below your entry price, the system
            automatically sells to cut losses. For example, 5c means if you bought
            at 50c and the bid drops to 45c, it sells.
          </div>
        </div>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-200">
          4. How It Works
        </h3>
        <div className="space-y-2 text-sm text-neutral-400 ml-2">
          <p>
            The backend polls live game data every 3 seconds and runs a win
            probability model on each state change (score, quarter/inning, etc.). It
            compares the model&apos;s probability to Kalshi market prices and writes a
            trading signal when edge is detected.
          </p>
          <p>
            Your browser subscribes to these signals in real time. When auto-execute
            is on and a signal exceeds your edge threshold, the system places a buy
            order on Kalshi with a 30-second expiration. It then monitors your
            position every 5 seconds for take-profit and stop-loss exits.
          </p>
          <p>
            Built-in safety filters prevent trading during blowouts, in the final
            moments of a game, when bid-ask spreads are too wide, and on heavy
            underdog sides (unless edge is especially large).
          </p>
        </div>
      </section>
    </div>
  );
}
