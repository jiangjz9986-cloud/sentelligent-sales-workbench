import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { SolutionPage } from "../../src/features/salesWorkbench/pages.jsx";

export function mountSolutionHistoryFixture(container, solution) {
  const root = createRoot(container);
  root.render(
    createElement(SolutionPage, {
      selected: solution,
      solutionDocs: solution ? [solution] : [],
      onSelect: () => {},
    }),
  );
  return () => root.unmount();
}
