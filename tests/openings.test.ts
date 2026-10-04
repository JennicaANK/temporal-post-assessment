import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  OpeningAlreadyLoggedError,
  openingSlotId,
  openingWorkflowId,
  startOpeningOutreach,
} from "../src/openings";
import type { ClientSummary, Opening, SmsKind } from "../src/types";
import { findEligible, seedWaitlist, toSummary } from "../src/waitlist";
import {
  cancelOutreach,
  getOutreachState,
  openingOutreachWorkflow,
  respondToOffer,
  staffDecision,
} from "../src/workflows";

const TASK_QUEUE = "openings-test";
const TIMEOUT_MS = 15 * 60 * 1000;
let environment: TestWorkflowEnvironment;
before(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});
after(async () => {
  await environment?.teardown();
});

async function withWorker(scenario: () => Promise<void>): Promise<void> {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      async getEligibleClients(target: Opening, excludeIds: string[]) {
        return findEligible(seedWaitlist(), target)
          .filter((client) => !excludeIds.includes(client.id))
          .map(toSummary);
      },
      async markClientBooked() {},
      async sendSms(to: ClientSummary, kind: SmsKind) {
        return { to, kind, body: kind, sentAt: new Date().toISOString() };
      },
    },
  });
  await worker.runUntil(scenario);
}

let slot = 0;
function newOpening(): Opening {
  const minutes = String(++slot).padStart(2, "0");
  return {
    id: openingSlotId("Carla", "2026-10-05", `15:${minutes}`),
    service: "Haircut",
    stylist: "Carla",
    startsAt: new Date(2026, 9, 5, 15, slot).toISOString(),
  };
}
const start = (opening: Opening) =>
  startOpeningOutreach(environment.client, opening, TIMEOUT_MS, TASK_QUEUE);
const handleFor = (opening: Opening) =>
  environment.client.workflow.getHandle<typeof openingOutreachWorkflow>(openingWorkflowId(opening));

async function waitForOffer(opening: Opening): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const state = await handleFor(opening).query(getOutreachState);
    if (state.status === "offering" && state.currentOffer) return state.currentOffer.client.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("No offer was made");
}

test("slot identity is stylist + date + time", () => {
  assert.equal(openingSlotId("Carla", "2026-10-04", "17:30"), "carla-2026-10-04-1730");
  assert.equal(openingWorkflowId(newOpening()).startsWith("opening-carla-2026-10-05-15"), true);
});

test("rejects a duplicate while the first outreach is still running", async () => {
  await withWorker(async () => {
    const opening = newOpening();
    await start(opening);
    await assert.rejects(start(opening), OpeningAlreadyLoggedError);
    await assert.rejects(start(opening), { message: "This opening has already been logged." });
    await handleFor(opening).signal(cancelOutreach, { reason: "test cleanup" });
    await handleFor(opening).result();
  });
});

test("rejects a duplicate after the slot was filled", async () => {
  await withWorker(async () => {
    const opening = newOpening();
    const workflowId = await start(opening);
    const clientId = await waitForOffer(opening);
    await handleFor(opening).executeUpdate(respondToOffer, { args: [{ clientId, response: "accept" }] });
    for (let i = 0; i < 100 && (await handleFor(opening).query(getOutreachState)).status !== "awaitingStaff"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await handleFor(opening).executeUpdate(staffDecision, { args: [{ decision: "confirm" }] });
    assert.equal((await handleFor(opening).result()).status, "filled");

    await assert.rejects(start(opening), OpeningAlreadyLoggedError);
    assert.equal((await environment.client.workflow.getHandle(workflowId).describe()).status.name, "COMPLETED");
  });
});

test("rejects a duplicate after the slot's outreach was cancelled", async () => {
  await withWorker(async () => {
    const opening = newOpening();
    await start(opening);
    await handleFor(opening).signal(cancelOutreach, { reason: "Stylist unavailable" });
    assert.equal((await handleFor(opening).result()).status, "cancelled");
    await assert.rejects(start(opening), OpeningAlreadyLoggedError);
  });
});

test("the application rule holds even when the earlier run allowed Workflow ID reuse", async () => {
  await withWorker(async () => {
    // Simulate a slot whose earlier run was started with Temporal's default
    // ALLOW_DUPLICATE policy, so Temporal alone would accept a new run.
    const opening = newOpening();
    const original = await environment.client.workflow.start(openingOutreachWorkflow, {
      workflowId: openingWorkflowId(opening),
      taskQueue: TASK_QUEUE,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [{ opening, offerTimeoutMs: TIMEOUT_MS }],
    });
    await original.signal(cancelOutreach, { reason: "test" });
    await original.result();

    await assert.rejects(start(opening), OpeningAlreadyLoggedError);
    const latest = await environment.client.workflow.getHandle(openingWorkflowId(opening)).describe();
    assert.equal(latest.runId, original.firstExecutionRunId, "no new run was created");
  });
});

test("two simultaneous requests for the same slot start exactly one Workflow", async () => {
  await withWorker(async () => {
    const opening = newOpening();
    const results = await Promise.allSettled([start(opening), start(opening)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof OpeningAlreadyLoggedError);
    await handleFor(opening).signal(cancelOutreach, { reason: "test cleanup" });
    await handleFor(opening).result();
  });
});
