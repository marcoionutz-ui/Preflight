/**
 * app/login/page.tsx
 * Same magic-link UI as /signup, but AuthForm passes shouldCreateUser: false
 * for mode="login" — an unknown email here does not create a new account.
 * This page exists mainly for correct framing/copy and discoverability
 * ("I already have an account").
 */

import Link from "next/link";
import AuthForm from "../signup/auth-form";

export default function LoginPage() {
  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <nav style={styles.navGroup}>
          <Link href="/pricing" style={styles.navLink}>Pricing</Link>
          <Link href="/signup" style={styles.navLink}>Sign up →</Link>
        </nav>
      </header>

      <main style={styles.main}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Log in</h1>
          <p style={styles.subtitle}>
            Enter the email you signed up with — we&apos;ll send a link, no password needed.
          </p>

          <AuthForm mode="login" />

          <p style={styles.footer}>
            No account yet?{" "}
            <Link href="/signup" style={styles.inlineLink}>Start free trial →</Link>
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
