import type { ClientSummary, Opening, TimeWindow, WaitlistClient } from "./types";

// SIMULATED Google Sheet: fictional clients with 555-01xx numbers.
// Seeded in memory when the API starts; not production persistence.
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const SERVICES = ["Haircut", "Color", "Blowout"];
export const STYLISTS = ["Carla", "Lena"];

export function seedWaitlist(): WaitlistClient[] {
  const base = Date.parse("2026-09-01T09:00:00Z");
  const row = (
    index: number,
    fields: Omit<WaitlistClient, "id" | "addedAt">,
  ): WaitlistClient => ({
    id: `c${index}`,
    addedAt: new Date(base + index * 3_600_000).toISOString(),
    ...fields,
  });
  return [
    row(1, { name: "Maya Chen", mobile: "+1 555-0101", service: "Haircut", preferredStylist: "Carla", stylistRequired: false, availableDays: ALL_DAYS, availableWindows: ["afternoon", "evening"] }),
    row(2, { name: "Priya Shah", mobile: "+1 555-0102", service: "Color", preferredStylist: "Lena", stylistRequired: true, availableDays: [1, 2, 3, 4, 5], availableWindows: ["morning"] }),
    row(3, { name: "Alex Kim", mobile: "+1 555-0103", service: "Haircut", preferredStylist: "Lena", stylistRequired: true, availableDays: ALL_DAYS, availableWindows: ["morning", "afternoon", "evening"] }),
    row(4, { name: "Jordan Lee", mobile: "+1 555-0104", service: "Haircut", preferredStylist: null, stylistRequired: false, availableDays: ALL_DAYS, availableWindows: ["morning", "afternoon", "evening"] }),
    row(5, { name: "Sam Rivera", mobile: "+1 555-0105", service: "Haircut", preferredStylist: "Carla", stylistRequired: true, availableDays: ALL_DAYS, availableWindows: ["morning", "afternoon", "evening"] }),
    row(6, { name: "Taylor Brooks", mobile: "+1 555-0106", service: "Blowout", preferredStylist: null, stylistRequired: false, availableDays: ALL_DAYS, availableWindows: ["morning", "afternoon", "evening"] }),
  ];
}

export function timeWindowOf(date: Date): TimeWindow {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

// Eligible = not already booked, same service, opening falls inside the
// client's availability, and a *required* stylist preference matches.
// Ordered by waitlist entry.
export function findEligible(waitlist: WaitlistClient[], opening: Opening): WaitlistClient[] {
  const startsAt = new Date(opening.startsAt);
  const window = timeWindowOf(startsAt);
  return waitlist
    .filter((client) => !client.bookedOpeningId)
    .filter((client) => client.service === opening.service)
    .filter((client) => client.availableDays.includes(startsAt.getDay()))
    .filter((client) => client.availableWindows.includes(window))
    .filter((client) => !client.stylistRequired || client.preferredStylist === opening.stylist)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export function toSummary(client: WaitlistClient): ClientSummary {
  return { id: client.id, name: client.name, mobile: client.mobile };
}
