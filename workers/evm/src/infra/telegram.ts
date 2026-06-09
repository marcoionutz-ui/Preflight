/**
 * infra/telegram.ts
 * Trimite notificări Telegram. No-op dacă env vars lipsesc.
 */

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN  ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID    ?? "";

export async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       msg,
        parse_mode: "HTML",
      }),
    });
  } catch { /* silent */ }
}
