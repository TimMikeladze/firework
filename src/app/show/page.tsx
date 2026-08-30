import type { Metadata } from "next";
import PulseShow from "@/components/PulseShow";

export const metadata: Metadata = {
  title: "Pulse Show",
  description:
    "A rhythm game where hitting the beat launches fireworks over a night skyline.",
};

export default function Show() {
  return <PulseShow />;
}
