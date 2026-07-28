import { useEffect, useState } from "react";

const QUERY = "(max-width: 860px)";

/** Phone and small-tablet layout switch. Phase 1 targets a full lesson from a phone. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
