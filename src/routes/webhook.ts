import { Hono } from "hono";
import crypto from "node:crypto";
import type {
  ElevenLabsWebhookEnvelope,
  ElevenLabsTranscriptEntry,
  TranscriptEntry,
} from "../types/index.js";
import { getDb } from "../db/index.js";
import { analyzeTranscript } from "../services/transcript.js";
import { sendNotification } from "../services/notification.js";

const webhook = new Hono();

/** Verify ElevenLabs HMAC webhook signature (format: t=<timestamp>,v0=<hex_hmac>) */
function verifySignature(
  rawBody: string,
  sigHeader: string,
  secret: string
): boolean {
  const parts = sigHeader.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signature = parts.find((p) => p.startsWith("v0="));

  if (!timestamp || !signature) return false;

  // Reject timestamps older than 30 minutes
  const reqTimestamp = Number(timestamp) * 1000;
  if (reqTimestamp < Date.now() - 30 * 60 * 1000) return false;

  const message = `${timestamp}.${rawBody}`;
  const expected =
    "v0=" + crypto.createHmac("sha256", secret).update(message).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/** Normalize ElevenLabs transcript entries (handles both legacy and current format) */
function normalizeTranscript(
  entries: ElevenLabsTranscriptEntry[]
): TranscriptEntry[] {
  return entries.map((entry) => ({
    role: (entry.role ?? entry.speaker ?? "user") as "agent" | "user",
    message: entry.message ?? entry.text ?? "",
    timestamp: entry.time_in_call_secs ?? entry.start,
  }));
}

/** POST /webhook/call-complete - receives data from ElevenLabs after each call */
webhook.post("/call-complete", async (c) => {
  const secret = process.env.WEBHOOK_SECRET;
  let envelope: ElevenLabsWebhookEnvelope;

  // Read raw body once (needed for signature verification)
  const rawBody = await c.req.text();

  if (secret) {
    const sigHeader = c.req.header("elevenlabs-signature") ?? "";
    if (!verifySignature(rawBody, sigHeader, secret)) {
      console.warn("Webhook signature verification failed");
      return c.json({ status: "error", reason: "invalid_signature" }, 401);
    }
    envelope = JSON.parse(rawBody) as ElevenLabsWebhookEnvelope;
  } else {
    console.warn(
      "WEBHOOK_SECRET not set — accepting unverified webhook (dev mode)"
    );
    envelope = JSON.parse(rawBody) as ElevenLabsWebhookEnvelope;
  }

  const data = envelope.data;

  if (!data) {
    return c.json({ status: "error", reason: "missing_data" }, 400);
  }

  // Extract conversation ID (current format: data.id, legacy: data.conversation_id)
  const conversationId = data.id ?? data.conversation_id ?? "unknown";

  // Skip failed calls
  if (data.status === "failed") {
    console.warn(`Call ${conversationId} failed, skipping.`);
    return c.json({ status: "skipped", reason: "call_failed" });
  }

  // Extract duration (current: data.duration, legacy: data.metadata.call_duration_secs)
  const duration = Math.round(
    data.duration ?? data.metadata?.call_duration_secs ?? 0
  );

  // Normalize transcript from whichever format ElevenLabs sends
  const transcript = normalizeTranscript(data.transcript ?? []);

  // Use ElevenLabs' AI-generated summary if available, otherwise analyze ourselves
  const elevenLabsSummary = data.analysis?.transcript_summary;
  const analysis = analyzeTranscript(transcript, elevenLabsSummary);

  const callerNumber =
    data.conversation_initiation_client_data?.dynamic_variables?.[
      "caller_number"
    ] ?? "unknown";

  // Persist to database (idempotent — ignores duplicate conversation_id)
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO calls (conversation_id, caller_number, caller_name, summary, urgency, action_requested, transcript, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    conversationId,
    callerNumber,
    analysis.caller_name,
    analysis.summary,
    analysis.urgency,
    analysis.action_requested,
    JSON.stringify(transcript),
    duration
  );

  // If no row was inserted, this is a duplicate delivery — acknowledge without re-notifying
  if (result.changes === 0) {
    console.log(`Duplicate webhook for ${conversationId}, already processed.`);
    return c.json({ status: "duplicate", conversation_id: conversationId });
  }

  // Send notification and track delivery status
  const sent = await sendNotification({
    caller_name: analysis.caller_name,
    caller_number: callerNumber,
    summary: analysis.summary,
    urgency: analysis.urgency,
    action_requested: analysis.action_requested,
    timestamp: new Date().toISOString(),
  });

  db.prepare(`UPDATE calls SET notification_sent = ? WHERE id = ?`).run(
    sent ? 1 : 0,
    result.lastInsertRowid
  );

  return c.json({
    status: "processed",
    call_id: result.lastInsertRowid,
    notification_sent: sent,
  });
});

export default webhook;
