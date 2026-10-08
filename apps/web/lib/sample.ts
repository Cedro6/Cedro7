/**
 * Sample figures for Home panels whose modules are not built yet (sales orders,
 * the assistant's briefing). Every panel that uses this file is labelled
 * "Sample data" on screen. Delete each entry when its module ships.
 */
export const sampleSales = {
  total: "$32,500",
  change: "+16%",
  note: "$28,100 by Tuesday last week",
  peak: "$17,100 Tue",
  path: "M30,170 C60,170 60,134.5 90,134.5 C120,134.5 120,120 150,120 C180,120 180,151 210,151 C240,151 240,101 270,101 C300,101 300,144 330,144 C360,144 360,104 390,104 C420,104 420,130 450,130 C480,130 480,70 510,70 C540,70 540,158 570,158 C600,158 600,92 630,92 C660,92 660,51 690,51",
  labels: ["Sep 21", "Sep 28", "Oct 5"],
};

export const sampleBriefing = [
  { tone: "bad", title: "Pipe cement runs out in 4 days", detail: "Purchase order for 96 units drafted", action: "Review" },
  { tone: "warn", title: "Kim & Sons quiet for 41 days", detail: "Check-in email drafted for Luis", action: "Review" },
  { tone: "warn", title: "2 orders ready, unshipped 3 days", detail: "SO-000471 · SO-000476", action: "Open" },
  { tone: "info", title: "Ridgeline Fasteners 2 days late", detail: "40 of 120 boxes outstanding", action: "Remind" },
] as const;
