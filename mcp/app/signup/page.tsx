/**
 * app/signup/page.tsx
 * Static shell, same dark/mono aesthetic as the rest of the site. Actual
 * auth logic lives in the shared client component (./auth-form.tsx),
 * reused by /login too.
 */

import Link from "next/link";
import AuthForm from "./auth-form";

export default function SignupPage() {
  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <nav style={styles.navGroup}>
          <Link href="/pricing" style={styles.navLink}>Pricing</Link>
          <Link href="/login" style={styles.navLink}>Log in →</Link>
        </nav>
      </header>

      <main style={styles.main}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Start your free trial</h1>
          <p style={styles.subtitle}>
            1,000 credits/month, <code style={styles.inlineCode}>read:basic</code> access to 6 core tools. No credit card, no password.
          </p>

          <AuthForm mode="signup" />

          <p style={styles.footer}>
            Already have an account?{" "}
            <Link href="/login" style={styles.inlineLink}>Log in →</Link>
          </p>
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight:  "100vh",
    background: "#030303",
    color:      "#e0e0e0",
    fontFamily: "'Courier New', Courier, monospace",
  },
  topbar: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "16px 24px",
    borderBottom:   "1px solid #161616",
  },
  brand: {
    color:          "#00ff88",
    fontSize:       "13px",
    fontWeight:     700,
    letterSpacing:  "0.08em",
    textDecoration: "none",
  },
  navGroup: {
    display: "flex",
    gap:     "18px",
  },
  navLink: {
    color:          "#888",
    fontSize:       "12px",
    textDecoration: "none",
  },
  main: {
    display:        "flex",
    justifyContent: "center",
    padding:        "80px 20px",
  },
  card: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "12px",
    padding:      "32px",
    width:        "100%",
    maxWidth:     "380px",
  },
  inlineCode: {
    background:   "#111",
    border:       "1px solid #222",
    borderRadius: "4px",
    color:        "#7fe3a3",
    fontSize:     "11.5px",
    padding:      "1px 5px",
  },
  h1: {
    color:    "#fff",
    fontSize: "19px",
    margin:   "0 0 8px",
  },
  subtitle: {
    color:      "#888",
    fontSize:   "12.5px",
    lineHeight: "1.6",
    margin:     "0 0 22px",
  },
  footer: {
    color:      "#666",
    fontSize:   "12px",
    textAlign:  "center" as const,
    marginTop:  "20px",
    marginBottom: 0,
  },
  inlineLink: {
    color:          "#00ff88",
    textDecoration: "none",
  },
};
