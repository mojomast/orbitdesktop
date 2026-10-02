import { CATALOG_ID } from "./interactive-result-policy";
/** Actual v0.9 wire messages, also exportable from the import UI. */
export const comparisonExample = [
  {
    version: "v0.9",
    createSurface: { surfaceId: "comparison", catalogId: CATALOG_ID },
  },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "comparison",
      components: [
        {
          id: "root",
          component: "Column",
          children: [
            "heading",
            "comparison",
            "notes",
            "choice",
            "accepted",
            "summary",
          ],
        },
        { id: "heading", component: "Text", text: "Editable comparison" },
        {
          id: "comparison",
          component: "Text",
          text: "Option A: simpler, lower cost. Option B: more flexible, higher maintenance. Synthetic example — choose your recommendation.",
        },
        {
          id: "notes",
          component: "TextField",
          label: "Decision notes",
          value: { path: "/notes" },
          variant: "longText",
        },
        {
          id: "choice",
          component: "ChoicePicker",
          label: "Preferred option",
          options: [
            { label: "Option A", value: "A" },
            { label: "Option B", value: "B" },
          ],
          value: { path: "/choice" },
          variant: "mutuallyExclusive",
        },
        {
          id: "accepted",
          component: "CheckBox",
          label: "Ready for review",
          value: { path: "/ready" },
        },
        {
          id: "summary",
          component: "Button",
          child: "summaryLabel",
          action: { event: { name: "prepare_summary" } },
        },
        { id: "summaryLabel", component: "Text", text: "Prepare summary" },
      ],
    },
  },
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: "comparison",
      path: "/",
      value: {
        notes: "Compare tradeoffs before deciding.",
        choice: ["A"],
        ready: false,
      },
    },
  },
];
