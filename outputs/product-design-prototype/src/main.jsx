import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles/global.css";
import "./features/travelExpense/travelExpense.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
