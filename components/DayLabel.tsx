"use client";

import { useEffect, useState } from "react";
import { dayNumber } from "@/lib/physics";

// The lake number derives from the client's clock (UTC), so it can't be
// rendered on the server without a hydration mismatch — mount it client-side.
export function DayLabel() {
  const [day, setDay] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(
      () => setDay(dayNumber(new Date().toISOString().slice(0, 10))),
      0,
    );
    return () => clearTimeout(t);
  }, []);
  return <span className="label">{day === null ? "\u00a0" : `lake #${day}`}</span>;
}
