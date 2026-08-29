import { createContext, useContext, useState } from "react";

const QuickRecordSessionContext = createContext(null);

const noopQuickRecordSession = {
  recordMode: "voice",
  setRecordMode: () => {},
  recordText: "",
  setRecordText: () => {},
  analysisVisible: false,
  setAnalysisVisible: () => {},
  syncStatus: "",
  setSyncStatus: () => {},
};

export function useQuickRecordSession() {
  return useContext(QuickRecordSessionContext) ?? noopQuickRecordSession;
}

export function QuickRecordSessionProvider({ value, children }) {
  return <QuickRecordSessionContext.Provider value={value}>{children}</QuickRecordSessionContext.Provider>;
}

export function useQuickRecordSessionState() {
  const [recordMode, setRecordMode] = useState("voice");
  const [recordText, setRecordText] = useState("");
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [syncStatus, setSyncStatus] = useState("尚未写入任何业务档案");
  return {
    recordMode,
    setRecordMode,
    recordText,
    setRecordText,
    analysisVisible,
    setAnalysisVisible,
    syncStatus,
    setSyncStatus,
  };
}
