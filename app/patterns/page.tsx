import type { Metadata } from "next";
import PatternsView from "./patterns-view";

export const metadata: Metadata = { title: "bit · Candlestick patterns" };

export default function PatternsPage() {
  return <PatternsView />;
}
