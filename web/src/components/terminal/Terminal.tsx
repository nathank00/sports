"use client";

import { useState } from "react";
import TerminalDashboard from "./TerminalDashboard";
import TerminalManual from "./TerminalManual";
import TerminalSettings from "./TerminalSettings";

type Tab = "dashboard" | "manual" | "settings";

const tabs: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "manual", label: "Manual" },
  { id: "settings", label: "Settings" },
];

export default function Terminal() {
  const [activeTab, setActiveTab] = useState<Tab>("manual");

  return (
    <div>
      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 rounded-lg border border-neutral-800 bg-neutral-900/40 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-neutral-800 text-white"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "dashboard" && (
        <TerminalDashboard onNavigate={setActiveTab} />
      )}
      {activeTab === "manual" && <TerminalManual />}
      {activeTab === "settings" && <TerminalSettings />}
    </div>
  );
}
