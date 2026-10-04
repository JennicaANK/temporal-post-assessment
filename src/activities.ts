import type { ClientSummary, Opening, SmsKind, SmsMessage, WaitlistClient } from "./types";
import { findEligible, toSummary } from "./waitlist";

const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// SIMULATED Google Sheet read: the in-memory waitlist lives in the API process.
// Re-read before every offer so staff removals apply to the next offer.
export async function getEligibleClients(
  opening: Opening,
  excludeIds: string[],
): Promise<ClientSummary[]> {
  const response = await fetch(`${API_URL}/api/waitlist`);
  if (!response.ok) throw new Error(`Waitlist unavailable (${response.status})`);
  const waitlist = (await response.json()) as WaitlistClient[];
  return findEligible(waitlist, opening)
    .filter((client) => !excludeIds.includes(client.id))
    .map(toSummary);
}

// SIMULATED Google Sheet write: mark the client as booked so they get no
// further offers. Declines, timeouts and "can't book" never call this.
export async function markClientBooked(clientId: string, openingId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/waitlist/${encodeURIComponent(clientId)}/booked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ openingId }),
  });
  if (!response.ok) throw new Error(`Could not mark client booked (${response.status})`);
}

export function composeSms(kind: SmsKind, opening: Opening, offerTimeoutMs: number): string {
  const window = offerTimeoutMs >= 60_000 ? `${Math.round(offerTimeoutMs / 60_000)} min` : `${Math.round(offerTimeoutMs / 1000)} sec`;
  const time = new Date(opening.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const slot = `${opening.service} with ${opening.stylist} today at ${time}`;
  switch (kind) {
    case "offer":
      return `Juniper Salon: an opening for ${slot}. Reply ACCEPT or DECLINE within ${window}.`;
    case "expired":
      return `Juniper Salon: the offer for ${slot} has expired. You're still on our waitlist.`;
    case "acceptReceived":
      return `Juniper Salon: thanks! We're holding ${slot} while we confirm. We'll text you shortly.`;
    case "confirmed":
      return `Juniper Salon: you're booked for ${slot}. See you then!`;
    case "unavailable":
      return `Juniper Salon: sorry, ${slot} is no longer available. You're still on our waitlist.`;
    case "cancelled":
      return `Juniper Salon: sorry, ${slot} is no longer available. You're still on our waitlist.`;
  }
}

// SIMULATED SMS: nothing leaves this machine. The message is logged and
// returned to the Workflow so the dashboard can show a fake phone outbox.
export async function sendSms(
  to: ClientSummary,
  kind: SmsKind,
  opening: Opening,
  offerTimeoutMs: number,
): Promise<SmsMessage> {
  const message: SmsMessage = {
    to,
    kind,
    body: composeSms(kind, opening, offerTimeoutMs),
    sentAt: new Date().toISOString(),
  };
  console.log(`[SIMULATED SMS → ${to.name} ${to.mobile}] ${message.body}`);
  return message;
}
