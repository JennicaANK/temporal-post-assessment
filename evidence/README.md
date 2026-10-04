# Evidence

Both screenshots show one run of the opening Workflow `opening-carla-2026-10-04-1530` (Haircut with Carla, 3:30 PM) in the local Temporal Web UI. All clients are fictional seed data.

**This run used the 30-second demo timeout (`OFFER_TIMEOUT_SECONDS=30`).** The normal same-day response window is 15 minutes; only the timer length differs.

## Primary: `temporal-workflow-timeline.png`

The timeline of a single opening, read from the bottom (earliest) to the top:

1. `getEligibleClients` → `sendSms`: the first eligible client (Maya) is offered the opening.
2. **Timer 1 (30s) runs to completion:** Maya never replies, so the durable timer fires and the Workflow moves on by itself. Maya gets an "expired, still on the waitlist" text.
3. `getEligibleClients` → `sendSms`: the next client (Jordan) is offered it. **Timer 2** stops early because `respondToOffer` (Jordan accepts) arrives.
4. `staffDecision`: staff mark the opening **unavailable after acceptance**. Jordan is texted, and the Workflow continues to the next client (Sam).
5. **Timer 3** stops early when Sam accepts (`respondToOffer`).
6. `cancelOutreach` (Signal): staff report that the opening is gone. Sam is texted, and the Workflow ends without offering it to anyone else.

This one execution shows the durable timer, waiting for client replies, automatic advancement after a timeout, holding for a staff decision after acceptance, and cancellation while waiting.

## Supporting: `temporal-workflow-overview.png`

The execution summary:

- Workflow ID `opening-carla-2026-10-04-1530`, type `openingOutreachWorkflow`, task queue `assessment-starter`
- Status **Completed** after 32 seconds, with 99 events in its history
- Input: the opening with `offerTimeoutMs: 30000`, which is the demo timing
- Result: `status: "cancelled"`, with the attempt log beginning with Maya Chen recorded as `timedOut`

The Temporal status is **Completed** because the Workflow handled the staff cancellation itself and returned normally. The business outcome, `cancelled`, is in the result.

## Dashboard: `juniper-dashboard-held-opening.png`

The staff dashboard from a later local demo run, after both safeguards were added (30-second demo timing). The 8:00 PM Haircut with Carla is in **Needs staff check**: Sam Rivera accepted, the opening is held, and no one else is being texted. The waitlist shows Maya Chen and Jordan Lee as **Booked** from earlier openings, so they weren't offered this one. Slide 2 uses crops of this image (`slides/assets/`).
