import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import type { Opening } from "./types";
import { openingOutreachWorkflow } from "./workflows";

export const TASK_QUEUE = "assessment-starter";

export class OpeningAlreadyLoggedError extends Error {
  constructor() {
    super("This opening has already been logged.");
  }
}

// A slot is identified by stylist + date + time, e.g. "carla-2026-10-04-1530".
export function openingSlotId(stylist: string, day: string, time: string): string {
  return `${stylist}-${day}-${time.replace(":", "")}`.toLowerCase();
}

export function openingWorkflowId(opening: Opening): string {
  return `opening-${opening.id}`;
}

// Business rule: outreach for a slot is started at most once, whatever the
// earlier run's outcome (running, filled, cancelled, exhausted).
export async function startOpeningOutreach(
  client: Client,
  opening: Opening,
  offerTimeoutMs: number,
  taskQueue = TASK_QUEUE,
): Promise<string> {
  const workflowId = openingWorkflowId(opening);
  // 1. Application check: any earlier run for this slot, open or closed, blocks a new one.
  try {
    await client.workflow.getHandle(workflowId).describe();
    throw new OpeningAlreadyLoggedError();
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
  }
  // 2. Temporal backstop for two simultaneous requests that both passed step 1:
  // a running duplicate is always refused, and REJECT_DUPLICATE refuses a closed one.
  try {
    await client.workflow.start(openingOutreachWorkflow, {
      workflowId,
      taskQueue,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [{ opening, offerTimeoutMs }],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) throw new OpeningAlreadyLoggedError();
    throw error;
  }
  return workflowId;
}
