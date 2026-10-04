import {
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  AttemptOutcome,
  CancelRequest,
  ClientResponse,
  ClientSummary,
  OutreachInput,
  OutreachState,
  SmsKind,
  StaffDecision,
} from "./types";

// Lena's rule for same-day openings: each client gets 15 minutes to reply.
export const SAME_DAY_OFFER_TIMEOUT_MS = 15 * 60 * 1000;

const { getEligibleClients, markClientBooked, sendSms } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumInterval: "10 seconds" },
});

// Client reply (Accept / Decline). Validator rejects replies from anyone who
// does not currently hold the offer, e.g. a late reply after the timer fired.
export const respondToOffer = defineUpdate<string, [ClientResponse]>("respondToOffer");
// Staff result of the (simulated) Square check after a client accepts.
export const staffDecision = defineUpdate<string, [StaffDecision]>("staffDecision");
// Opening disappeared (original client returned, stylist unavailable, …): stop everything.
export const cancelOutreach = defineSignal<[CancelRequest]>("cancelOutreach");
export const getOutreachState = defineQuery<OutreachState>("getOutreachState");

export async function openingOutreachWorkflow(input: OutreachInput): Promise<OutreachState> {
  const offerTimeoutMs = input.offerTimeoutMs ?? SAME_DAY_OFFER_TIMEOUT_MS;
  const state: OutreachState = {
    opening: input.opening,
    status: "searching",
    offerTimeoutMs,
    attempts: [],
    remaining: [],
    messages: [],
  };
  let reply: ClientResponse["response"] | undefined;
  let decision: StaffDecision["decision"] | undefined;
  let cancelRequest: CancelRequest | undefined;

  setHandler(getOutreachState, () => state);
  setHandler(
    respondToOffer,
    ({ response }) => {
      reply = response;
      return `Received ${response}.`;
    },
    {
      validator: ({ clientId, response }) => {
        if (response !== "accept" && response !== "decline") throw new Error("Unknown response.");
        if (state.status !== "offering" || state.currentOffer?.client.id !== clientId) {
          throw new Error("This offer is no longer open.");
        }
      },
    },
  );
  setHandler(
    staffDecision,
    ({ decision: value }) => {
      decision = value;
      return `Recorded ${value}.`;
    },
    {
      validator: ({ decision: value }: StaffDecision) => {
        if (value !== "confirm" && value !== "unavailable") throw new Error("Unknown decision.");
        if (state.status !== "awaitingStaff") {
          throw new Error("No acceptance is awaiting staff confirmation.");
        }
      },
    },
  );
  setHandler(cancelOutreach, (request) => {
    cancelRequest ??= request;
  });

  async function text(to: ClientSummary, kind: SmsKind): Promise<void> {
    state.messages.push(await sendSms(to, kind, input.opening, offerTimeoutMs));
  }
  function record(client: ClientSummary, outcome: AttemptOutcome): void {
    state.attempts.push({ client, outcome, at: new Date().toISOString() });
  }
  async function finishCancelled(notify?: ClientSummary): Promise<OutreachState> {
    state.status = "cancelled";
    state.cancelReason = cancelRequest?.reason;
    state.currentOffer = undefined;
    state.awaitingStaffFor = undefined;
    state.remaining = [];
    if (notify) await text(notify, "cancelled");
    return state;
  }

  const contacted: string[] = [];
  while (true) {
    if (cancelRequest) return finishCancelled();

    // 1. Find the next eligible client (earliest waitlist entry first).
    state.status = "searching";
    const eligible = await getEligibleClients(input.opening, contacted);
    if (cancelRequest) return finishCancelled();
    if (eligible.length === 0) {
      state.status = "exhausted";
      state.remaining = [];
      return state;
    }
    const client = eligible[0];
    contacted.push(client.id);
    state.remaining = eligible.slice(1);

    // 2. Offer it to exactly one client and durably wait up to 15 minutes.
    reply = undefined;
    await text(client, "offer");
    const offeredAt = Date.now();
    state.status = "offering";
    state.currentOffer = {
      client,
      offeredAt: new Date(offeredAt).toISOString(),
      expiresAt: new Date(offeredAt + offerTimeoutMs).toISOString(),
    };
    await condition(() => reply !== undefined || cancelRequest !== undefined, offerTimeoutMs);
    state.currentOffer = undefined;
    state.status = "searching";

    if (cancelRequest) return finishCancelled(client);
    if (reply === undefined) {
      // Timeout: move on, but the client stays on the waitlist.
      record(client, "timedOut");
      await text(client, "expired");
      continue;
    }
    if (reply === "decline") {
      record(client, "declined");
      continue;
    }

    // 3. Accepted: hold the opening (no other offers) until staff check Square.
    decision = undefined;
    state.status = "awaitingStaff";
    state.awaitingStaffFor = client;
    await text(client, "acceptReceived");
    await condition(() => decision !== undefined || cancelRequest !== undefined);
    state.awaitingStaffFor = undefined;

    if (cancelRequest) return finishCancelled(client);
    if (decision === "confirm") {
      // patched() keeps Workflows that completed before this step was added replayable.
      if (patched("mark-client-booked")) await markClientBooked(client.id, input.opening.id);
      state.status = "filled";
      state.filledBy = client;
      state.remaining = [];
      await text(client, "confirmed");
      return state;
    }
    // Not bookable after all: tell this client, continue with the next one.
    record(client, "unavailableAfterAccept");
    await text(client, "unavailable");
  }
}
