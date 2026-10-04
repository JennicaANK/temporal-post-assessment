export type TimeWindow = "morning" | "afternoon" | "evening";

// One row of the (simulated) Google Sheet waitlist.
export type WaitlistClient = {
  id: string;
  name: string;
  mobile: string;
  service: string;
  preferredStylist: string | null;
  // true = "only with this stylist"; false = preference, but anyone is fine.
  stylistRequired: boolean;
  availableDays: number[]; // 0 = Sunday … 6 = Saturday
  availableWindows: TimeWindow[];
  addedAt: string; // ISO timestamp; defines waitlist order
  bookedOpeningId?: string; // set once staff confirm a booking; no more offers
};

export type ClientSummary = { id: string; name: string; mobile: string };

// A same-day cancellation that staff want to fill.
export type Opening = {
  id: string;
  service: string;
  stylist: string;
  startsAt: string; // ISO timestamp, same day only in v1
};

export type OutreachInput = {
  opening: Opening;
  // Defaults to 15 minutes. Only shortened for demos via OFFER_TIMEOUT_SECONDS.
  offerTimeoutMs?: number;
};

export type OutreachStatus =
  | "searching"
  | "offering"
  | "awaitingStaff"
  | "filled"
  | "cancelled"
  | "exhausted";

export type AttemptOutcome = "declined" | "timedOut" | "unavailableAfterAccept";

export type Attempt = { client: ClientSummary; outcome: AttemptOutcome; at: string };

export type SmsKind =
  | "offer"
  | "expired"
  | "acceptReceived"
  | "confirmed"
  | "unavailable"
  | "cancelled";

export type SmsMessage = {
  to: ClientSummary;
  kind: SmsKind;
  body: string;
  sentAt: string;
};

export type OutreachState = {
  opening: Opening;
  status: OutreachStatus;
  offerTimeoutMs: number;
  currentOffer?: { client: ClientSummary; offeredAt: string; expiresAt: string };
  awaitingStaffFor?: ClientSummary;
  filledBy?: ClientSummary;
  cancelReason?: string;
  attempts: Attempt[];
  remaining: ClientSummary[];
  messages: SmsMessage[];
};

export type ClientResponse = { clientId: string; response: "accept" | "decline" };
export type StaffDecision = { decision: "confirm" | "unavailable" };
export type CancelRequest = { reason: string };
