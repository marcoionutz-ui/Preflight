"use client";

/**
 * app/signup/auth-form.tsx
 * Shared magic-link form for /signup and /login — same underlying call
 * (supabase.auth.signInWithOtp), but they diverge on shouldCreateUser:
 * signup can create a new account, login can only sign in an existing one
 * (unknown email on /login does not silently create an account).
 */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Props {
  mode: "signup" | "login";
}

export default function AuthForm({ mode }: Props) {
  const [email, setEmail]   = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [sentTo, setSentTo]     = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg("");

    const normalizedEmail = email.trim().toLowerCase();

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo:  `${window.location.origin}/auth/callback`,
        shouldCreateUser: mode === "signup",
      },
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }
    setSentTo(normalizedEmail);
    setStatus("sent");
  }

  if (status === "sent") {
    return (
      <div style={styles.sentBox}>
        <div style={styles.sentTitle}>Check your email</div>
        <p style={styles.sentText}>
          We sent a sign-in link to <strong style={styles.sentEmail}>{sentTo}</strong>.
          Click it to {mode === "signup" ? "create your account" : "sign in"} — no password needed.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <label style={styles.label} htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        required
        autoFocus
        placeholder="you@example.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
        style={styles.input}
      />

      {status === "error" && (
        <div style={styles.errorBox}>{errorMsg || "Something went wrong. Try again."}</div>
      )}

      <button type="submit" disabled={status === "loading"} style={styles.button}>
        {status === "loading"
          ? "Sending..."
          : mode === "signup" ? "Start free trial →" : "Send sign-in link →"}
      </button>

      <p style={styles.hint}>
        We&apos;ll email you a magic link — no password to remember or leak.
      </p>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: {
    display:       "flex",
    flexDirection: "column" as const,
    gap:           "10px",
  },
  label: {
    color:      "#aaa",
    fontSize:   "12px",
    fontFamily: "'Courier New', Courier, monospace",
  },
  input: {
    background:   "#0d0d0d",
    border:       "1px solid #222",
    borderRadius: "8px",
    color:        "#fff",
    fontSize:     "14px",
    padding:      "12px 14px",
    outline:      "none",
    width:        "100%",
    boxSizing:    "border-box" as const,
    fontFamily:   "'Courier New', Courier, monospace",
  },
  button: {
    background:    "#00ff88",
    border:        "none",
    borderRadius:  "8px",
    color:         "#000",
    cursor:        "pointer",
    fontSize:      "13px",
    fontWeight:    700,
    padding:       "13px",
    width:         "100%",
    marginTop:     "4px",
    letterSpacing: "0.02em",
  },
  hint: {
    color:      "#555",
    fontSize:   "11px",
    lineHeight: "1.5",
    margin:     "4px 0 0",
  },
  errorBox: {
    background:   "#240a0a",
    border:       "1px solid #3a0f0f",
    borderRadius: "6px",
    color:        "#ff5c5c",
    fontSize:     "12px",
    padding:      "8px 12px",
  },
  sentBox: {
    background:   "#0d2016",
    border:       "1px solid #0a3020",
    borderRadius: "8px",
    padding:      "18px",
  },
  sentTitle: {
    color:        "#00ff88",
    fontSize:     "14px",
    fontWeight:   700,
    marginBottom: "8px",
  },
  sentText: {
    color:      "#bbb",
    fontSize:   "12.5px",
    lineHeight: "1.6",
    margin:     0,
  },
  sentEmail: {
    color: "#fff",
  },
};
