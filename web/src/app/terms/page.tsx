import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — Terms & Conditions",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl py-12">
      <Link
        href="/"
        className="mb-10 inline-flex items-center gap-1.5 text-xs text-neutral-600 transition-colors hover:text-neutral-400"
      >
        ← Back
      </Link>

      <h1 className="mb-2 font-mono text-2xl font-bold tracking-wider text-white">
        Terms &amp; Conditions
      </h1>
      <p className="mb-10 text-xs text-neutral-600">
        Last updated: February 28, 2026
      </p>

      <div className="space-y-8 text-sm leading-relaxed text-neutral-400">
        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            1. Acceptance of Terms
          </h2>
          <p>
            By accessing or using the ONE OF ONE platform (the
            &quot;Service&quot;), you agree to be bound by these Terms &amp;
            Conditions. If you do not agree, do not use the Service. We reserve
            the right to modify these terms at any time, and your continued use
            constitutes acceptance of any changes.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            2. Description of Service
          </h2>
          <p>
            ONE OF ONE provides algorithmic sports prediction data, analytics
            tools, and execution interfaces. The Service includes free
            prediction signals, a paid manual execution terminal, and future
            automated trading features. The Service is intended for
            informational and analytical purposes.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            3. Eligibility
          </h2>
          <p>
            You must be at least 18 years of age (or the legal age of majority
            in your jurisdiction) to use the Service. By using the Service, you
            represent and warrant that you meet this requirement and that your
            use of the Service complies with all applicable local, state,
            national, and international laws and regulations.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            4. Account Registration
          </h2>
          <p>
            Certain features require account registration. You are responsible
            for maintaining the confidentiality of your login credentials and
            for all activity under your account. You agree to provide accurate
            information and to notify us immediately of any unauthorized use of
            your account.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            5. Subscriptions and Payments
          </h2>
          <ul className="list-inside list-disc space-y-2 text-neutral-500">
            <li>
              Paid features are billed on a recurring subscription basis through
              Stripe.
            </li>
            <li>
              Subscriptions automatically renew unless cancelled before the end
              of the current billing period.
            </li>
            <li>
              You may cancel your subscription at any time. Cancellation takes
              effect at the end of your current billing cycle.
            </li>
            <li>
              Refunds are issued at our sole discretion. We are not obligated to
              provide refunds for partial billing periods.
            </li>
            <li>
              We reserve the right to change subscription pricing with
              reasonable notice. Existing subscribers will be notified before any
              price change takes effect.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            6. No Financial Advice
          </h2>
          <p>
            The Service provides data, predictions, and analytical tools. None
            of the content on the Service constitutes financial advice,
            investment advice, or a recommendation to place any wager or trade.
            All predictions are probabilistic outputs of machine learning models
            and are not guarantees of outcomes. You are solely responsible for
            your own trading and betting decisions.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            7. Risk Acknowledgment
          </h2>
          <p>
            Sports betting and trading involve substantial risk of financial
            loss. Past model performance does not guarantee future results. You
            acknowledge that you may lose some or all of the capital you deploy
            based on information from the Service. You should only bet or trade
            with funds you can afford to lose.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            8. API Keys and Security
          </h2>
          <p>
            The Terminal feature allows you to connect third-party exchange
            accounts using your own API keys. Your keys are stored exclusively
            in your browser&apos;s local storage and are never transmitted to or
            stored on our servers. You are solely responsible for the security
            of your API keys, the permissions you grant those keys, and any
            orders placed through the Terminal.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            9. Intellectual Property
          </h2>
          <p>
            All content, models, algorithms, data, code, designs, and branding
            associated with the Service are the intellectual property of ONE OF
            ONE. You may not reproduce, distribute, reverse-engineer, or create
            derivative works from any part of the Service without prior written
            consent.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            10. Prohibited Conduct
          </h2>
          <p className="mb-2">You agree not to:</p>
          <ul className="list-inside list-disc space-y-2 text-neutral-500">
            <li>
              Use the Service for any unlawful purpose or in violation of any
              applicable law.
            </li>
            <li>
              Attempt to gain unauthorized access to the Service, other
              accounts, or any related systems.
            </li>
            <li>
              Scrape, crawl, or use automated means to extract data from the
              Service without authorization.
            </li>
            <li>
              Redistribute, resell, or publicly share prediction data or
              terminal outputs for commercial purposes.
            </li>
            <li>
              Interfere with the proper functioning of the Service or impose
              unreasonable load on our infrastructure.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            11. Limitation of Liability
          </h2>
          <p>
            To the maximum extent permitted by law, ONE OF ONE and its
            operators, affiliates, and employees shall not be liable for any
            indirect, incidental, special, consequential, or punitive damages,
            including but not limited to loss of profits, data, or capital,
            arising out of or related to your use of the Service. Our total
            liability for any claim arising from the Service shall not exceed
            the amount you paid us in subscription fees during the twelve months
            preceding the claim.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            12. Disclaimer of Warranties
          </h2>
          <p>
            The Service is provided &quot;as is&quot; and &quot;as
            available&quot; without warranties of any kind, whether express or
            implied, including but not limited to implied warranties of
            merchantability, fitness for a particular purpose, and
            non-infringement. We do not guarantee that the Service will be
            uninterrupted, error-free, or that predictions will be accurate.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            13. Termination
          </h2>
          <p>
            We reserve the right to suspend or terminate your access to the
            Service at any time, with or without cause, and with or without
            notice. Upon termination, your right to use the Service ceases
            immediately. Provisions that by their nature should survive
            termination (including liability limitations, disclaimers, and
            intellectual property rights) shall continue in effect.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            14. Governing Law
          </h2>
          <p>
            These Terms shall be governed by and construed in accordance with
            the laws of the United States. Any disputes arising from these Terms
            or the Service shall be resolved through binding arbitration in
            accordance with applicable rules, unless otherwise required by law.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            15. Severability
          </h2>
          <p>
            If any provision of these Terms is found to be unenforceable or
            invalid, that provision shall be limited or eliminated to the
            minimum extent necessary, and the remaining provisions shall remain
            in full force and effect.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            16. Contact
          </h2>
          <p>
            Questions about these Terms should be directed to{" "}
            <span className="text-neutral-300">support@oneofone.com</span>.
          </p>
        </section>
      </div>
    </div>
  );
}
