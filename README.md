# Juniper Salon: same-day cancellation waitlist (Temporal prototype)

A local prototype that texts waitlisted clients, one at a time, when a same-day appointment is cancelled. Each opening is a durable Temporal Workflow. Texts, the waitlist sheet, and the Square check are **simulated**.

## The problem

Lena owns Juniper Salon. Last-minute cancellations leave gaps in the day. Today, Lena or Carla checks a Google Sheet of clients who want an earlier appointment, picks a match, and texts them from the salon phone. Then they have to keep watching for replies and text the next person if nobody answers.

**What Lena wants:** staff spend less time chasing replies, and more cancelled appointments get filled.
**What she can't accept:** double-bookings, or a process that still needs someone checking it constantly.

This prototype shows the process running on its own. It has not been used with real clients, so it makes no claims about time saved or fill rate.

## What the prototype does

1. **Staff log a same-day cancellation** with the service, stylist and time.
2. **The Workflow finds eligible clients** on the waitlist. A client is eligible when:
   - the service matches,
   - the opening falls inside their available days and time of day,
   - and, if they marked a stylist as *required*, the stylist matches. A stylist they only *prefer* doesn't rule them out.
3. **It texts one client at a time,** earliest waitlist entry first. Each client has **15 minutes** to reply Accept or Decline.
4. **A decline or no reply moves to the next eligible client automatically.** Someone who times out stays on the waitlist for future openings.
5. **When a client accepts, the opening is held** and no one else is texted. Staff then check Square and choose one of two actions:
   - **Confirm booking:** the client gets a confirmation, is marked **Booked** on the waitlist (so they get no further offers), and the Workflow finishes as *filled*.
   - **Can't book: tell client, offer next:** see below.
6. **Staff can stop outreach at any time** with **Opening is gone: stop outreach** (see below).
7. **The staff dashboard shows each opening:**
   - who is being offered it, with a countdown
   - who declined or timed out
   - who is next in line
   - any acceptance waiting for staff to check Square

   Staff can also remove a client from the waitlist so they get no future texts.

### Safeguards against double-booking

- **One outreach per slot, ever.** A slot is identified by stylist + date + time. Once it has been logged, logging it again is refused with *"This opening has already been logged."* This applies whether the earlier outreach is still running or has finished (filled, cancelled, or no one left). The app checks Temporal for any earlier run of that slot before starting. It does not rely on Temporal's Workflow ID reuse setting; as a backstop for two simultaneous requests, the start also uses `REJECT_DUPLICATE`.
- **Only the current offer can be accepted.** Late replies and replies from anyone else are rejected (see *Why Temporal*).
- **Booked clients get no further offers.** After **Confirm booking**, the client is marked Booked and excluded from every later eligibility check. Declines, timeouts and **Can't book** do *not* do this; those clients stay eligible. The Booked flag lives only in the prototype's in-memory waitlist. It is not synced with Square and resets when the API restarts.

### Two different staff actions

| Button | When to use it | What happens |
|---|---|---|
| **Can't book: tell client, offer next** | A client accepted, but the Square check shows this booking can't go ahead. | That client is texted that it's unavailable. **Outreach continues** with the next eligible client. |
| **Opening is gone: stop outreach** | The opening no longer exists, e.g. the original client is keeping the appointment or the stylist is unavailable. Can be used while an offer is out or while staff are checking Square. | Whoever currently holds the offer is told it's unavailable. **The Workflow ends** and no one else is offered the opening. |

## Why Temporal

Each opening is one long-running process that spends most of its time waiting on people. Temporal is a good fit for that:

- **One durable Workflow per opening.** The Workflow ID is `opening-<stylist>-<date>-<time>`, and the app never starts a second one for the same slot (see *Safeguards*).
- **Sequential offers.** The Workflow owns the loop: find the next eligible client → text them → wait → move on.
- **The 15-minute wait is a durable Temporal timer.** The Temporal server tracks the deadline, not the Worker's memory, so no one has to watch the clock.
- **Accept and Decline are Temporal Updates.** Each Update is checked before it's recorded: only the client holding the current offer can reply, and only while the offer is open. A late Accept after a timeout is rejected, which prevents double-booking.
- **Moving on happens automatically after a decline or timeout.** Staff don't have to watch for replies.
- **After an Accept, the Workflow holds the opening** and waits for a staff decision, sent as another Update, for as long as staff need. On **Confirm**, a `markClientBooked` Activity marks the client Booked.
- **Cancellation works while waiting.** The `cancelOutreach` Signal stops the Workflow whether it is waiting on a client or on staff.
- **Visible event history.** The Temporal Web UI shows each simulated text, each timer starting, firing or being cancelled, every reply and staff decision, and the cancel Signal.

## Run it

**Prerequisites:** Node.js 20 or newer, npm, and Docker Desktop (running).

```bash
npm install   # first time only
npm run dev
```

`npm run dev` starts the local Temporal server in Docker, the Worker, and the API. Then open:

- **App (staff dashboard + simulated client phones):** <http://localhost:3000>
- **Temporal Web UI:** <http://localhost:8233>

Stop with `Ctrl+C`. `npm run stop` shuts down the Temporal container.

### Optional: demo timing

```bash
OFFER_TIMEOUT_SECONDS=30 npm run dev
```

This shortens the reply window to 30 seconds, so you can watch a timeout without waiting 15 minutes. While it's on, the dashboard shows an orange **DEMO TIMING** banner. **The normal behavior, with no variable set, is Lena's 15 minutes.**

### Tests and typecheck

```bash
npm test          # Workflow, slot and eligibility tests; no Docker needed (Temporal time-skipping test server)
npm run typecheck # TypeScript
```

The tests (19) cover:
- offers going out in waitlist order
- decline → next client
- accept → staff confirm → filled
- the 15-minute timeout moving on, with the client kept on the waitlist
- rejection of late Accepts and Accepts from the wrong client
- unavailable after accept → next client
- cancel while an offer is out
- cancel while staff are checking Square
- running out of eligible clients
- a confirmed client being marked Booked and skipped on the next opening, while timed-out, declined and can't-book clients stay eligible
- logging the same slot again: refused while running, after filled, after cancelled, when the earlier run allowed ID reuse, and for two simultaneous requests

## Reproduce the core demo

Start with `OFFER_TIMEOUT_SECONDS=30 npm run dev` and open <http://localhost:3000>. The seeded waitlist has three eligible clients for a Haircut with Carla in the afternoon or evening: **Maya Chen → Jordan Lee → Sam Rivera**. Alex Kim also wants a Haircut but requires Lena, so he is skipped. Use afternoon or evening times later today.

**Opening A: timeout, can't book, decline**
1. Log a Haircut with Carla (e.g. 5:00 PM). Maya's offer appears in *Client phones*. Don't reply: after 30 seconds she is listed as *timed out (still on waitlist)* and Jordan is offered it.
2. Click **Accept** on Jordan's text. The card turns amber ("opening held") and no one else is texted. Click **Can't book: tell client, offer next**. Jordan gets an "unavailable" text and Sam is offered it.
3. Click **Decline** on Sam's text. No eligible clients are left, so the card shows **No one left**.

**Opening B: accept, confirm, Booked**

4. Log another Haircut with Carla (e.g. 5:30 PM). Maya is offered it again, because timing out didn't cost her place. Click **Accept**, then **Confirm booking**. The card shows **Filled** and the waitlist shows Maya as **Booked**.

**Opening C: booked client skipped, cancellation**

5. Log a third Haircut with Carla (e.g. 6:00 PM). Jordan is offered it first; Maya is skipped because she is Booked. Choose a reason and click **Opening is gone: stop outreach**. Jordan is notified, the card shows **Cancelled**, and no one else is texted.

**Duplicate slot**

6. Try logging 5:30 PM with Carla again. It is refused with *"This opening has already been logged."*
7. **In the Temporal Web UI,** open the `opening-…` Workflows (each card links to its own) to see the timers, Updates, Signal and Activities in the event history.

The waitlist is reseeded every time the API restarts.

## Simulated

- **Google Sheet waitlist:** six fictional clients with 555-01xx numbers, kept in memory in the API process. The Worker reads it over HTTP (`GET /api/waitlist`) before every offer.
- **SMS:** the `sendSms` Activity logs `[SIMULATED SMS …]` to the console and returns the message to the Workflow. The dashboard's *Client phones* panel shows these messages with Accept and Decline buttons. Nothing is actually sent.
- **Square check:** staff check Square themselves and report the result with the dashboard buttons. There is no Square API call.
- **Booked status:** the `markClientBooked` Activity sets a flag on the in-memory waitlist (`POST /api/waitlist/:id/booked`). It stands in for updating the Sheet; it is not a Square booking or sync.

## Not included

- Production persistence (the waitlist and Booked flags reset when the API restarts) and any production deployment.
- Authentication or roles for staff and clients.
- Real Twilio/SMS, Square, or Google Sheets integrations.
- Free-form SMS parsing. Clients only have Accept and Decline.
- Clients joining the waitlist themselves, multiple locations, and reporting.

## Scope and known limitations

- **Same-day openings only.** Lena set a 15-minute reply window for same-day openings. She didn't describe what should happen for openings on later days, so that is out of scope for v1. New openings always use today's date, and times already past are rejected.
- **Removing a client** stops future texts, starting from the next offer. If that client is already holding an offer, it runs until they reply or it times out.
- **The duplicate-slot check relies on Temporal still holding the slot's earlier run.** If Temporal's retention period deletes it, the check can no longer see it. Openings are same-day only and past times are rejected, so an expired slot can't be logged again anyway.
- **Booked is prototype state only.** A client marked Booked stays inactive until the API restarts; un-booking (e.g. if they cancel later) isn't supported.
- **There is no time limit on the staff Square check.** The opening stays held until staff confirm, mark it unbookable, or stop outreach.
- **Time of day uses the server's local clock:** morning is before 12:00, afternoon is 12:00–17:00, evening is 17:00 onwards.

## Repository map

```
src/workflows.ts   openingOutreachWorkflow: offer loop, 15-min timer, Updates, cancel Signal, state Query
src/activities.ts  getEligibleClients (simulated sheet read), markClientBooked (simulated sheet write), sendSms (simulated)
src/openings.ts    slot identity + startOpeningOutreach (refuses a slot that was already logged)
src/waitlist.ts    seeded waitlist + eligibility rules (not booked, service, availability, required stylist, order)
src/api.ts         Express API + Temporal Client: openings, client replies, staff decisions, waitlist
src/worker.ts      Worker on the assessment-starter task queue
src/types.ts       shared types
public/            staff dashboard + simulated client phones (plain HTML/JS)
tests/             Workflow, duplicate-slot (time-skipping) and eligibility tests
scripts/dev.mjs    starts Temporal (Docker), Worker, and API
compose.yml        local Temporal dev server (ports 7233, 8233)
evidence/          Temporal Web UI and dashboard screenshots
slides/            4-slide customer deck: PDF + HTML source and screenshot crops
```
