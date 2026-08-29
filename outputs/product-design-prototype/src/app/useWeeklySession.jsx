import { createContext, useContext, useState } from "react";

const WeeklySessionContext = createContext(null);

const noopWeeklySession = {
  weeklyView: "daily",
  setWeeklyView: () => {},
  weeklyDraft: null,
  setWeeklyDraft: () => {},
  weeklyDraftText: "",
  setWeeklyDraftText: () => {},
};

export function useWeeklySession() {
  return useContext(WeeklySessionContext) ?? noopWeeklySession;
}

export function WeeklySessionProvider({ value, children }) {
  return <WeeklySessionContext.Provider value={value}>{children}</WeeklySessionContext.Provider>;
}

export function useWeeklySessionState() {
  const [weeklyView, setWeeklyView] = useState("daily");
  const [weeklyDraft, setWeeklyDraft] = useState(null);
  const [weeklyDraftText, setWeeklyDraftText] = useState("");
  return {
    weeklyView,
    setWeeklyView,
    weeklyDraft,
    setWeeklyDraft,
    weeklyDraftText,
    setWeeklyDraftText,
  };
}
