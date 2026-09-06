import { useState } from "react";
import { createRoot } from "react-dom/client";

import { TripRegionSettingsCard } from "../../src/features/travelExpense/TripRegionSettingsCard.jsx";
import "../../src/features/travelExpense/tripRegionSettingsCard.css";

function weekProfile(version) {
  return {
    weekStart: "2026-08-24",
    weekEnd: "2026-08-30",
    version,
    cities: [],
    defaultCity: null,
    dateOverrides: [],
  };
}

window.__regionSaves = [];

function Harness() {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(null);
  const [pollCount, setPollCount] = useState(0);

  // The QA driver controls the harness exactly like TravelExpensePage does:
  // opening the card, delivering the first loaded profile, and replaying the
  // 12-second workbench poll that replaces the profile object identity while
  // its persisted content stays unchanged.
  window.__openCard = () => setOpen(true);
  window.__closeCard = () => setOpen(false);
  window.__deliverProfile = (version = 3) => setProfile(weekProfile(version));
  window.__pollWorkbench = (version = 3) => {
    setProfile(weekProfile(version));
    setPollCount((value) => value + 1);
  };

  return (
    <main>
      <button type="button" data-trip-region-focus-fallback>账本</button>
      <output data-testid="poll-count">{pollCount}</output>
      <TripRegionSettingsCard
        open={open}
        profile={profile}
        pending={false}
        onClose={() => setOpen(false)}
        onSave={async (payload) => {
          window.__regionSaves.push(payload);
        }}
      />
    </main>
  );
}

createRoot(document.querySelector("#root")).render(<Harness />);
