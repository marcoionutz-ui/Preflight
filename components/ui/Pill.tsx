interface PillProps {
  label: string;
  color?: string;
  small?: boolean;
  onClick?: () => void;
}

export default function Pill({ label, color = "#39ff14", small, onClick }: PillProps) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-block",
        padding: small ? "1px 6px" : "2px 10px",
        borderRadius: 3,
        border: `1px solid ${color}`,
        color,
        background: color + "15",
        fontSize: small ? 9 : 11,
        fontFamily: "monospace",
        fontWeight: "bold",
        letterSpacing: 1,
        cursor: onClick ? "pointer" : "default",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
