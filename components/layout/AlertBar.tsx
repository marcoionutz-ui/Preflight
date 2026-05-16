import type { Alert } from "@/types";

export default function AlertBar({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <div style={{
      borderBottom: "1px solid #0d0d0d",
      padding: "4px 16px",
      background: "#060300",
      display: "flex",
      gap: 16,
      overflowX: "auto",
      alignItems: "center",
    }}>
      <span style={{ color: "#ffb347", fontSize: 8, letterSpacing: 2, flexShrink: 0 }}>⚠ ALERTS</span>
      {alerts.slice(-6).map((a) => (
        <span key={a.id} style={{ color: a.warn ? "#ff3b3b" : "#ffb347", fontSize: 10, flexShrink: 0 }}>
          [{a.sym}] {a.msg}
        </span>
      ))}
    </div>
  );
}
