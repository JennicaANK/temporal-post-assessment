import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { ClientSummary, Opening, OutreachState, SmsKind, SmsMessage } from "../src/types";
import { findEligible, seedWaitlist, toSummary } from "../src/waitlist";
import {
  cancelOutreach,
  getOutreachState,
  openingOutreachWorkflow,
  respondToOffer,
  staffDecision,
} from "../src/workflows";

// Haircut with Carla, Monday 3pm. Eligible in waitlist order:
// Maya (c1, prefers Carla), Jordan (c4, no preference), Sam (c5, requires Carla).
// Alex (c3) requires Lena and Priya (c2) wants Color, so they are never offered.
const opening: Opening = {
  id: "carla-test",
  service: "Haircut",
  stylist: "Carla",
  startsAt: new Date(2026, 9, 5, 15, 0).toISOString(),
};

let environment: TestWorkflowEnvironment;
before(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});
after(async () => {
  await environment?.teardown();
});

type Handle = WorkflowHandle<typeof openingOutreachWorkflow>;
type Harness = { handle: Handle; waitlist: ReturnType<typeof seedWaitlist>; sms: SmsMessage[]; eligibilityChecks: number };

let testCount = 0;
async function runScenario(
  scenario: (harness: Harness) => Promise<void>,
  waitlist = seedWaitlist(),
): Promise<void> {
  const taskQueue = `outreach-test-${++testCount}`;
  const harness = { waitlist, sms: [] as SmsMessage[], eligibilityChecks: 0 } as Harness;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      async getEligibleClients(target: Opening, excludeIds: string[]) {
        harness.eligibilityChecks += 1;
        return findEligible(harness.waitlist, target)
          .filter((client) => !excludeIds.includes(client.id))
          .map(toSummary);
      },
      async markClientBooked(clientId: string, openingId: string) {
        const client = harness.waitlist.find((entry) => entry.id === clientId);
        if (client) client.bookedOpeningId = openingId;
      },
      async sendSms(to: ClientSummary, kind: SmsKind) {
        const message = { to, kind, body: kind, sentAt: new Date().toISOString() };
        harness.sms.push(message);
        return message;
      },
    },
  });
  await worker.runUntil(async () => {
    harness.handle = await environment.client.workflow.start(openingOutreachWorkflow, {
      workflowId: taskQueue,
      taskQueue,
      args: [{ opening }],
    });
    await scenario(harness);
  });
}

async function waitFor(handle: Handle, predicate: (state: OutreachState) => boolean): Promise<OutreachState> {
  for (let i = 0; i < 100; i++) {
    const state = await handle.query(getOutreachState);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting; last state: ${JSON.stringify(await handle.query(getOutreachState))}`);
}
const offeredTo = (id: string) => (state: OutreachState) =>
  state.status === "offering" && state.currentOffer?.client.id === id;
const respond = (handle: Handle, clientId: string, response: "accept" | "decline") =>
  handle.executeUpdate(respondToOffer, { args: [{ clientId, response }] });
const smsKinds = (sms: SmsMessage[], clientId: string) =>
  sms.filter((message) => message.to.id === clientId).map((message) => message.kind);

test("offers in waitlist order, decline advances, accept waits for staff, confirm fills", async () => {
  await runScenario(async ({ handle, sms }) => {
    const first = await waitFor(handle, offeredTo("c1"));
    assert.deepEqual(first.remaining.map((client) => client.id), ["c4", "c5"]);

    await respond(handle, "c1", "decline");
    await waitFor(handle, offeredTo("c4"));
    await respond(handle, "c4", "accept");

    const held = await waitFor(handle, (state) => state.status === "awaitingStaff");
    assert.equal(held.awaitingStaffFor?.id, "c4");
    assert.equal(held.currentOffer, undefined, "no one else is being offered the held opening");

    await handle.executeUpdate(staffDecision, { args: [{ decision: "confirm" }] });
    const result = await handle.result();
    assert.equal(result.status, "filled");
    assert.equal(result.filledBy?.id, "c4");
    assert.deepEqual(result.attempts.map((a) => [a.client.id, a.outcome]), [["c1", "declined"]]);
    assert.deepEqual(smsKinds(sms, "c4"), ["offer", "acceptReceived", "confirmed"]);
    assert.deepEqual(smsKinds(sms, "c5"), [], "Sam is never contacted");
  });
});

test("15-minute durable timer advances to the next client without removing the timed-out one", async () => {
  await runScenario(async ({ handle, sms, waitlist }) => {
    await waitFor(handle, offeredTo("c1"));
    await environment.sleep("14 minutes");
    await waitFor(handle, offeredTo("c1"));

    await environment.sleep("2 minutes");
    const state = await waitFor(handle, offeredTo("c4"));
    assert.deepEqual(state.attempts.map((a) => [a.client.id, a.outcome]), [["c1", "timedOut"]]);
    assert.deepEqual(smsKinds(sms, "c1"), ["offer", "expired"]);
    assert.ok(waitlist.some((client) => client.id === "c1"), "Maya stays on the waitlist");

    await assert.rejects(respond(handle, "c1", "accept"), WorkflowUpdateFailedError, "late accept is rejected");
    await handle.signal(cancelOutreach, { reason: "test cleanup" });
    await handle.result();
  });
});

test("only the client currently holding the offer can accept", async () => {
  await runScenario(async ({ handle }) => {
    await waitFor(handle, offeredTo("c1"));
    await assert.rejects(respond(handle, "c4", "accept"), WorkflowUpdateFailedError);
    await assert.rejects(
      handle.executeUpdate(staffDecision, { args: [{ decision: "confirm" }] }),
      WorkflowUpdateFailedError,
      "staff cannot confirm before anyone accepts",
    );
    await handle.signal(cancelOutreach, { reason: "test cleanup" });
    await handle.result();
  });
});

test("unavailable after acceptance notifies that client and moves to the next", async () => {
  await runScenario(async ({ handle, sms }) => {
    await waitFor(handle, offeredTo("c1"));
    await respond(handle, "c1", "accept");
    await waitFor(handle, (state) => state.status === "awaitingStaff");
    await handle.executeUpdate(staffDecision, { args: [{ decision: "unavailable" }] });

    const state = await waitFor(handle, offeredTo("c4"));
    assert.deepEqual(state.attempts.map((a) => [a.client.id, a.outcome]), [["c1", "unavailableAfterAccept"]]);
    assert.deepEqual(smsKinds(sms, "c1"), ["offer", "acceptReceived", "unavailable"]);
    await handle.signal(cancelOutreach, { reason: "test cleanup" });
    await handle.result();
  });
});

test("cancelling while an offer is pending notifies the client and stops all outreach", async () => {
  await runScenario(async (harness) => {
    const { handle, sms } = harness;
    await waitFor(handle, offeredTo("c1"));
    await handle.signal(cancelOutreach, { reason: "Original client is keeping the appointment" });

    const result = await handle.result();
    assert.equal(result.status, "cancelled");
    assert.equal(result.cancelReason, "Original client is keeping the appointment");
    assert.deepEqual(smsKinds(sms, "c1"), ["offer", "cancelled"]);
    assert.deepEqual(smsKinds(sms, "c4"), [], "not offered to anyone else");
    assert.equal(harness.eligibilityChecks, 1);
  });
});

test("cancelling while awaiting staff confirmation notifies the accepted client and stops", async () => {
  await runScenario(async ({ handle, sms }) => {
    await waitFor(handle, offeredTo("c1"));
    await respond(handle, "c1", "accept");
    await waitFor(handle, (state) => state.status === "awaitingStaff");
    await handle.signal(cancelOutreach, { reason: "Stylist unavailable" });

    const result = await handle.result();
    assert.equal(result.status, "cancelled");
    assert.deepEqual(smsKinds(sms, "c1"), ["offer", "acceptReceived", "cancelled"]);
    assert.equal(sms.filter((message) => message.kind === "offer").length, 1);
  });
});

test("staff removal applies to the next offer; ends as exhausted when no one is left", async () => {
  await runScenario(async (harness) => {
    const { handle } = harness;
    await waitFor(handle, offeredTo("c1"));
    harness.waitlist = harness.waitlist.filter((client) => client.id !== "c4");
    await respond(handle, "c1", "decline");
    await waitFor(handle, offeredTo("c5"));
    await respond(handle, "c5", "decline");

    const result = await handle.result();
    assert.equal(result.status, "exhausted");
    assert.deepEqual(result.attempts.map((a) => a.client.id), ["c1", "c5"]);
  });
});

test("a confirmed client is marked booked and is not offered the next opening", async () => {
  const waitlist = seedWaitlist();
  await runScenario(async ({ handle }) => {
    await waitFor(handle, offeredTo("c1"));
    await respond(handle, "c1", "accept");
    await waitFor(handle, (state) => state.status === "awaitingStaff");
    await handle.executeUpdate(staffDecision, { args: [{ decision: "confirm" }] });
    assert.equal((await handle.result()).status, "filled");
  }, waitlist);
  assert.equal(waitlist.find((client) => client.id === "c1")?.bookedOpeningId, opening.id);

  // Next opening with the same waitlist: Maya is skipped, Jordan is first.
  await runScenario(async ({ handle, sms }) => {
    const state = await waitFor(handle, offeredTo("c4"));
    assert.deepEqual(state.remaining.map((client) => client.id), ["c5"]);
    assert.deepEqual(smsKinds(sms, "c1"), []);
    await handle.signal(cancelOutreach, { reason: "test cleanup" });
    await handle.result();
  }, waitlist);
});

test("timeout, decline, and can't-book leave every client eligible for future openings", async () => {
  const waitlist = seedWaitlist();
  await runScenario(async ({ handle }) => {
    await waitFor(handle, offeredTo("c1"));
    await environment.sleep("16 minutes"); // Maya times out
    await waitFor(handle, offeredTo("c4"));
    await respond(handle, "c4", "decline"); // Jordan declines
    await waitFor(handle, offeredTo("c5"));
    await respond(handle, "c5", "accept"); // Sam accepts, but staff can't book
    await waitFor(handle, (state) => state.status === "awaitingStaff");
    await handle.executeUpdate(staffDecision, { args: [{ decision: "unavailable" }] });

    const result = await handle.result();
    assert.equal(result.status, "exhausted");
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["timedOut", "declined", "unavailableAfterAccept"]);
  }, waitlist);
  assert.ok(waitlist.every((client) => !client.bookedOpeningId), "no one marked booked");
  assert.deepEqual(findEligible(waitlist, opening).map((client) => client.id), ["c1", "c4", "c5"]);
});
