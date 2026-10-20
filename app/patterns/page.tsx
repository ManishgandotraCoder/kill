import type { Metadata } from "next";
import PatternGuide from "./pattern-guide";

export const metadata: Metadata = {
  title: "Pattern guide · darkMode",
  description: "Every candlestick pattern the detector finds: how it looks, how it is detected, and what BTC did afterwards",
};

export default function PatternsPage() {
  return <PatternGuide />;
}
