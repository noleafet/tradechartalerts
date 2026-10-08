import type { Metadata } from "next";
import "./globals.css";
import "./chart.css";
import "./responsive.css";
import "./tailwind.css";

export const metadata: Metadata = {
  title: "TradeChartAlert — Market alerts",
  description: "Create and monitor persistent market alerts.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="min-h-screen">{children}</body></html>;
}
