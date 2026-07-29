import { useEffect, useState } from "react";

/** Subscribes to a media query, SSR-safe defaults aside. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Phone and small-tablet layout switch. Phase 1 targets a full lesson from a phone. */
export function useNarrow(): boolean {
  return useMediaQuery("(max-width: 860px)");
}

/**
 * Phone-sized: the transport cannot show its full control set below this and
 * drops to the essentials, with the rest one press away behind more-controls.
 */
export function usePhone(): boolean {
  return useMediaQuery("(max-width: 560px)");
}
