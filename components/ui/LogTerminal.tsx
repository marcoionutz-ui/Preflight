"use client";

import { useEffect, useRef } from "react";
import type { LogEntry } from "@/types";

export default function LogTerminal({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  const color = (t: LogEntry["t"]) =>
    t === "err" ? "#ff3b3b" : t === "ok" ? "#39ff14" : t === "warn" ? "#ffb347" : "#383838";

  return (
    <div
      ref={ref}
      style={{
        height: 90, overflowY: "auto",
        background: "#040404", border: "1px solid #0e0e0e",
        borderRadius: 4, padding: "6px 8px",
        fontFamily: "monospace", fontSize: 10,
      }}
    >
      {logs.map((l) => (
        <div key={l.id} style={{ color: color(l.t), marginBottom: 1 }}>
          <span style={{ color: "#1a1a1a" }}>{l.ts} </span>
          {l.msg}
        </div>
      ))}
    </div>
  );
}
