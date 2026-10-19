import type { Metadata } from "next";
import PredictionsView from "./predictions-view";

export const metadata: Metadata = { title: "Prediction results" };

export default function PredictionsPage() {
  return <PredictionsView />;
}
