import path from "node:path";
import { Client, Connection, WorkflowUpdateFailedError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { OpeningAlreadyLoggedError, openingSlotId, startOpeningOutreach } from "./openings";
import type { Opening, OutreachState } from "./types";
import { SERVICES, STYLISTS, seedWaitlist } from "./waitlist";
import {
  cancelOutreach,
  getOutreachState,
  respondToOffer,
  SAME_DAY_OFFER_TIMEOUT_MS,
  staffDecision,
} from "./workflows";

// Production default is Lena's 15 minutes. OFFER_TIMEOUT_SECONDS is for demos only.
const demoSeconds = Number(process.env.OFFER_TIMEOUT_SECONDS);
const offerTimeoutMs = demoSeconds > 0 ? demoSeconds * 1000 : SAME_DAY_OFFER_TIMEOUT_MS;
const demoTiming = offerTimeoutMs !== SAME_DAY_OFFER_TIMEOUT_MS;

// SIMULATED Google Sheet: in-memory, reseeded every time the API starts.
let waitlist = seedWaitlist();

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

app.get("/api/config", (_request, response) => {
  response.json({ offerTimeoutMs, demoTiming, services: SERVICES, stylists: STYLISTS });
});

app.get("/api/waitlist", (_request, response) => {
  response.json(waitlist);
});

// Removes the client from future outreach. An offer already sent to them is
// left to finish (reply or timeout); see README "Known limitations".
app.delete("/api/waitlist/:clientId", (request, response) => {
  waitlist = waitlist.filter((client) => client.id !== request.params.clientId);
  response.status(204).end();
});

// Called by the Workflow once staff confirm a booking (simulated sheet write).
app.post("/api/waitlist/:clientId/booked", (request, response) => {
  const openingId = String(request.body?.openingId ?? "");
  waitlist = waitlist.map((client) =>
    client.id === request.params.clientId ? { ...client, bookedOpeningId: openingId } : client,
  );
  response.status(204).end();
});

app.post("/api/openings", async (request, response) => {
  const { service, stylist, time } = request.body as Record<string, string>;
  if (!SERVICES.includes(service) || !STYLISTS.includes(stylist) || !/^\d{2}:\d{2}$/.test(time ?? "")) {
    response.status(400).json({ error: "Choose a service, stylist, and time." });
    return;
  }
  // v1 supports same-day openings only, so the date is always today.
  const [hours, minutes] = time.split(":").map(Number);
  const startsAt = new Date();
  startsAt.setHours(hours, minutes, 0, 0);
  if (startsAt.getTime() < Date.now()) {
    response.status(400).json({ error: "That time has already passed today." });
    return;
  }
  const day = startsAt.toLocaleDateString("en-CA");
  const opening: Opening = {
    id: openingSlotId(stylist, day, time),
    service,
    stylist,
    startsAt: startsAt.toISOString(),
  };
  try {
    const workflowId = await startOpeningOutreach(await getClient(), opening, offerTimeoutMs);
    response.status(201).json({ workflowId });
  } catch (error) {
    if (error instanceof OpeningAlreadyLoggedError) {
      response.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

app.get("/api/openings", async (_request, response) => {
  const client = await getClient();
  const openings: Array<{ workflowId: string; running: boolean; state: OutreachState }> = [];
  for await (const execution of client.workflow.list({
    query: "WorkflowType = 'openingOutreachWorkflow'",
  })) {
    if (openings.length >= 20) break;
    try {
      const state = await client.workflow
        .getHandle(execution.workflowId, execution.runId)
        .query(getOutreachState);
      openings.push({ workflowId: execution.workflowId, running: execution.status.name === "RUNNING", state });
    } catch {
      // Worker not reachable yet; the opening will appear on the next refresh.
    }
  }
  response.json({ openings });
});

async function runUpdate(response: Response, work: () => Promise<string>) {
  try {
    response.json({ message: await work() });
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      response.status(409).json({ error: error.cause?.message ?? error.message });
      return;
    }
    throw error;
  }
}

// Simulated client phone: Accept / Decline.
app.post("/api/openings/:workflowId/respond", async (request, response) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(request.params.workflowId);
  await runUpdate(response, () =>
    handle.executeUpdate(respondToOffer, { args: [request.body] }),
  );
});

// Staff: result of the (simulated) Square check.
app.post("/api/openings/:workflowId/staff", async (request, response) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(request.params.workflowId);
  await runUpdate(response, () =>
    handle.executeUpdate(staffDecision, { args: [request.body] }),
  );
});

// Staff: the opening itself is gone. Stops outreach entirely.
app.post("/api/openings/:workflowId/cancel", async (request, response) => {
  const client = await getClient();
  const reason = String(request.body?.reason ?? "").trim() || "Opening no longer available";
  await client.workflow.getHandle(request.params.workflowId).signal(cancelOutreach, { reason });
  response.status(202).json({ accepted: true });
});

app.use(
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    response.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Juniper Salon waitlist prototype: http://localhost:${port}`);
  if (demoTiming) console.log(`DEMO TIMING: offers expire after ${offerTimeoutMs / 1000}s (production: 15 min).`);
});
