import type { Tab } from "../lib/types";

interface HeaderProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  useDemoApi: boolean;
}

const tabs: { key: Tab; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "manual", label: "Manual" },
  { key: "auto", label: "Auto" },
  { key: "settings", label: "Settings" },
];

export default function Header({ activeTab, onTabChange, useDemoApi }: HeaderProps) {
  return (
    <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="flex items-center justify-between px-6 py-3">
        <span className="font-mono text-sm tracking-widest text-neutral-100">
          [ EDGEMASTER ]
        </span>
        <div className="flex items-center gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium uppercase tracking-wider rounded transition-colors ${
                activeTab === tab.key
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span
          className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded ${
            useDemoApi
              ? "bg-amber-900/40 text-amber-400"
              : "bg-red-900/40 text-red-400"
          }`}
        >
          {useDemoApi ? "Demo" : "Live"}
        </span>
      </div>
    </header>
  );
}
