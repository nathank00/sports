"use client";

import { useEffect, useState } from "react";
import {
  importPemKey,
  storeCryptoKey,
  loadCryptoKey,
  clearCryptoKey,
  storeKeyId,
  loadKeyId,
  clearKeyId,
} from "@/lib/kalshi-crypto";
import { testConnection } from "@/lib/kalshi-api";
import {
  loadTerminalSettings,
  saveTerminalSettings,
} from "@/lib/terminal-settings";
import type { SizingMode } from "@/lib/types";

export default function TerminalSettings() {
  // Kalshi API
  const [keyId, setKeyId] = useState("");
  const [pemStatus, setPemStatus] = useState<
    "none" | "stored" | "importing" | "error"
  >("none");
  const [pemError, setPemError] = useState<string | null>(null);

  // Trading settings
  const [edgeThreshold, setEdgeThreshold] = useState(10);
  const [sizingMode, setSizingMode] = useState<SizingMode>("contracts");
  const [betAmount, setBetAmount] = useState(10);

  // Actions
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Load saved state on mount
  useEffect(() => {
    // Load Key ID from localStorage
    const savedKeyId = loadKeyId();
    if (savedKeyId) setKeyId(savedKeyId);

    // Check if CryptoKey exists in IndexedDB
    loadCryptoKey().then((key) => {
      if (key) setPemStatus("stored");
    });

    // Load trading settings
    const settings = loadTerminalSettings();
    setEdgeThreshold(settings.edgeThreshold);
    setSizingMode(settings.sizingMode);
    setBetAmount(settings.betAmount);
  }, []);

  // Save Key ID to localStorage whenever it changes
  const handleKeyIdChange = (value: string) => {
    setKeyId(value);
    if (value.trim()) {
      storeKeyId(value.trim());
    } else {
      clearKeyId();
    }
  };

  // Import PEM file via file picker
  const handlePemUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPemStatus("importing");
    setPemError(null);

    try {
      const text = await file.text();
      const cryptoKey = await importPemKey(text);
      await storeCryptoKey(cryptoKey);
      setPemStatus("stored");
    } catch (err) {
      setPemStatus("error");
      setPemError(
        err instanceof Error ? err.message : "Failed to import PEM key"
      );
    }

    // Reset the input so the same file can be re-selected
    e.target.value = "";
  };

  // Clear stored PEM key
  const handleClearPem = async () => {
    await clearCryptoKey();
    setPemStatus("none");
    setPemError(null);
  };

  // Save trading settings
  const handleSave = () => {
    saveTerminalSettings({ edgeThreshold, sizingMode, betAmount });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Test Kalshi connection
  const handleTest = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await testConnection();
      setTestResult(result);
    } catch (e) {
      setTestResult(`Error: ${e}`);
    }
    setTestLoading(false);
  };

  const isContracts = sizingMode === "contracts";

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="font-mono text-xl font-bold tracking-wider text-white">
        Settings
      </h1>

      {/* ─── Kalshi API ─── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
          Kalshi API
        </h2>

        {/* Key ID */}
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Key ID</label>
          <input
            type="text"
            value={keyId}
            onChange={(e) => handleKeyIdChange(e.target.value)}
            placeholder="Your Kalshi API Key ID"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500 placeholder:text-neutral-600"
          />
        </div>

        {/* PEM Key */}
        <div>
          <label className="block text-xs text-neutral-400 mb-1">
            Private Key (PEM)
          </label>

          {pemStatus === "stored" ? (
            <div className="flex items-center gap-3">
              <div className="flex-1 rounded-md border border-green-800/40 bg-green-900/20 px-3 py-2 text-sm text-green-400">
                PEM key stored securely in browser
              </div>
              <button
                onClick={handleClearPem}
                className="shrink-0 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-400 transition-all hover:border-red-700 hover:text-red-400"
              >
                Remove
              </button>
            </div>
          ) : (
            <div>
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                  />
                </svg>
                <span>
                  {pemStatus === "importing"
                    ? "Importing..."
                    : "Upload PEM file"}
                </span>
                <input
                  type="file"
                  accept=".pem,.txt,.key"
                  onChange={handlePemUpload}
                  className="hidden"
                />
              </label>
              <p className="mt-1 text-[11px] text-neutral-600">
                Your key is imported into the browser&apos;s crypto system and
                never sent to our server.
              </p>
            </div>
          )}

          {pemError && (
            <div className="mt-2 rounded-md border border-red-800/40 bg-red-900/20 px-3 py-2 text-sm text-red-400">
              {pemError}
            </div>
          )}
        </div>
      </section>

      {/* ─── Trading ─── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
          Trading
        </h2>

        {/* Edge threshold */}
        <div>
          <label className="block text-xs text-neutral-400 mb-1">
            Edge Threshold (%)
          </label>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={edgeThreshold}
            onChange={(e) => setEdgeThreshold(Number(e.target.value))}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
          />
        </div>

        {/* Position sizing mode */}
        <div>
          <label className="block text-xs text-neutral-400 mb-2">
            Position Sizing
          </label>
          <div className="flex rounded-md border border-neutral-700 overflow-hidden">
            <button
              onClick={() => setSizingMode("contracts")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                isContracts
                  ? "bg-neutral-700 text-white"
                  : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
              }`}
            >
              By Contracts
            </button>
            <button
              onClick={() => setSizingMode("dollars")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                !isContracts
                  ? "bg-neutral-700 text-white"
                  : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
              }`}
            >
              By Dollars
            </button>
          </div>
          <p className="mt-1 text-[11px] text-neutral-600">
            {isContracts
              ? "Buy a fixed number of contracts per bet"
              : "Spend up to this dollar amount per bet"}
          </p>
        </div>

        {/* Bet amount */}
        <div>
          <label className="block text-xs text-neutral-400 mb-1">
            {isContracts ? "Contracts per Bet" : "Dollars per Bet"}
          </label>
          <div className="relative">
            {!isContracts && (
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-500">
                $
              </span>
            )}
            <input
              type="number"
              min={1}
              max={isContracts ? 1000 : 10000}
              step={1}
              value={betAmount}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (val >= 1) setBetAmount(val);
              }}
              className={`w-full rounded-md border border-neutral-700 bg-neutral-900 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500 ${
                !isContracts ? "pl-7 pr-3" : "px-3"
              }`}
            />
          </div>
        </div>
      </section>

      {/* ─── Actions ─── */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          className="rounded-lg border border-neutral-600 bg-neutral-800 px-5 py-2 text-sm font-medium text-white transition-all hover:border-neutral-500 hover:bg-neutral-700"
        >
          {saved ? "Saved ✓" : "Save Settings"}
        </button>
        <button
          onClick={handleTest}
          disabled={testLoading}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-5 py-2 text-sm font-medium text-neutral-300 transition-all hover:border-neutral-500 hover:text-white disabled:opacity-50"
        >
          {testLoading ? "Testing..." : "Test Connection"}
        </button>
      </div>

      {testResult && (
        <div
          className={`rounded-md p-3 text-sm ${
            testResult.startsWith("Error")
              ? "bg-red-900/20 text-red-400 border border-red-800/40"
              : "bg-green-900/20 text-green-400 border border-green-800/40"
          }`}
        >
          {testResult}
        </div>
      )}
    </div>
  );
}
