import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — Privacy Policy",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl py-12">
      <Link
        href="/"
        className="mb-10 inline-flex items-center gap-1.5 text-xs text-neutral-600 transition-colors hover:text-neutral-400"
      >
        ← Back
      </Link>

      <h1 className="mb-2 font-mono text-2xl font-bold tracking-wider text-white">
        Privacy Policy
      </h1>
      <p className="mb-10 text-xs text-neutral-600">
        Last updated: February 28, 2026
      </p>

      <div className="space-y-8 text-sm leading-relaxed text-neutral-400">
        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            1. Introduction
          </h2>
          <p>
            ONE OF ONE (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;)
            operates the website located at oneofone-silk.vercel.app (the
            &quot;Service&quot;). This Privacy Policy explains how we collect,
            use, and protect your information when you use our Service.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            2. Information We Collect
          </h2>
          <p className="mb-3">
            We collect the following types of information:
          </p>
          <ul className="list-inside list-disc space-y-2 text-neutral-500">
            <li>
              <span className="text-neutral-400">Account information:</span>{" "}
              Email address and password when you create an account.
            </li>
            <li>
              <span className="text-neutral-400">Payment information:</span>{" "}
              Subscription and billing data processed through Stripe. We do not
              store your credit card details on our servers.
            </li>
            <li>
              <span className="text-neutral-400">Usage data:</span> Pages
              visited, features used, and general interaction patterns with the
              Service.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            3. Information We Do Not Collect
          </h2>
          <p>
            We do not collect, store, or transmit your third-party API keys or
            credentials. Exchange API keys entered in the Terminal are encrypted
            and stored exclusively in your browser&apos;s local storage
            (IndexedDB) using the Web Crypto API. These keys never leave your
            device and are never sent to our servers.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            4. How We Use Your Information
          </h2>
          <ul className="list-inside list-disc space-y-2 text-neutral-500">
            <li>To provide, maintain, and improve the Service.</li>
            <li>To process subscription payments through Stripe.</li>
            <li>To send transactional emails related to your account.</li>
            <li>
              To monitor usage patterns and improve the user experience.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            5. Third-Party Services
          </h2>
          <p className="mb-3">We use the following third-party services:</p>
          <ul className="list-inside list-disc space-y-2 text-neutral-500">
            <li>
              <span className="text-neutral-400">Supabase:</span>{" "}
              Authentication and database services.
            </li>
            <li>
              <span className="text-neutral-400">Stripe:</span> Payment
              processing. Stripe&apos;s privacy policy governs how they handle
              your payment data.
            </li>
            <li>
              <span className="text-neutral-400">Vercel:</span> Website hosting
              and deployment.
            </li>
          </ul>
          <p className="mt-3">
            We do not sell, rent, or share your personal information with third
            parties for marketing purposes.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            6. Data Security
          </h2>
          <p>
            We implement reasonable security measures to protect your
            information. Authentication sessions are managed through secure,
            HTTP-only cookies. All data in transit is encrypted via TLS.
            However, no method of electronic transmission or storage is 100%
            secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            7. Data Retention
          </h2>
          <p>
            We retain your account information for as long as your account is
            active. If you delete your account, we will remove your personal
            data within 30 days, except where retention is required by law or
            for legitimate business purposes such as fraud prevention.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            8. Your Rights
          </h2>
          <p>You have the right to:</p>
          <ul className="mt-2 list-inside list-disc space-y-2 text-neutral-500">
            <li>Access, update, or delete your account information.</li>
            <li>Cancel your subscription at any time.</li>
            <li>
              Request a copy of the personal data we hold about you.
            </li>
            <li>
              Clear locally stored API keys at any time through the Terminal
              settings.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            9. Cookies
          </h2>
          <p>
            We use essential cookies to maintain your authentication session.
            These are strictly necessary for the Service to function and cannot
            be disabled. We do not use advertising or tracking cookies.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            10. Children&apos;s Privacy
          </h2>
          <p>
            The Service is not intended for individuals under the age of 18. We
            do not knowingly collect personal information from minors. If you
            believe a minor has provided us with personal data, please contact
            us and we will delete it promptly.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            11. Changes to This Policy
          </h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify
            you of material changes by posting the updated policy on this page
            with a revised &quot;Last updated&quot; date. Your continued use of
            the Service after changes are posted constitutes acceptance of the
            revised policy.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-medium text-white">
            12. Contact
          </h2>
          <p>
            If you have questions about this Privacy Policy, please contact us
            at{" "}
            <span className="text-neutral-300">support@oneofone.com</span>.
          </p>
        </section>
      </div>
    </div>
  );
}
