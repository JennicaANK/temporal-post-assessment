import assert from "node:assert/strict";
import { test } from "node:test";
import type { Opening, WaitlistClient } from "../src/types";
import { findEligible, seedWaitlist } from "../src/waitlist";

const at = (day: number, hour: number) => new Date(2026, 9, 4 + day, hour, 0).toISOString(); // day 0 = Sunday
const opening = (fields: Partial<Opening>): Opening => ({
  id: "o",
  service: "Haircut",
  stylist: "Carla",
  startsAt: at(1, 15),
  ...fields,
});
const ids = (clients: WaitlistClient[]) => clients.map((client) => client.id);

test("matches service and returns earliest waitlist entries first", () => {
  const shuffled = seedWaitlist().reverse();
  assert.deepEqual(ids(findEligible(shuffled, opening({}))), ["c1", "c4", "c5"]);
  assert.deepEqual(ids(findEligible(shuffled, opening({ service: "Blowout" }))), ["c6"]);
});

test("a required stylist preference must match; a soft preference does not block", () => {
  const lena = findEligible(seedWaitlist(), opening({ stylist: "Lena" }));
  assert.deepEqual(ids(lena), ["c1", "c3", "c4"]); // Maya prefers Carla but isn't strict
});

test("opening must fall within the client's days and time of day", () => {
  // Maya is afternoon/evening only; Priya is weekday mornings only.
  assert.ok(!ids(findEligible(seedWaitlist(), opening({ startsAt: at(1, 9) }))).includes("c1"));
  assert.deepEqual(ids(findEligible(seedWaitlist(), opening({ service: "Color", stylist: "Lena", startsAt: at(1, 9) }))), ["c2"]);
  assert.deepEqual(ids(findEligible(seedWaitlist(), opening({ service: "Color", stylist: "Lena", startsAt: at(0, 9) }))), []);
});

test("a client already booked through the prototype is no longer eligible", () => {
  const waitlist = seedWaitlist().map((client) =>
    client.id === "c1" ? { ...client, bookedOpeningId: "carla-2026-10-05-1500" } : client,
  );
  assert.deepEqual(ids(findEligible(waitlist, opening({}))), ["c4", "c5"]);
});
