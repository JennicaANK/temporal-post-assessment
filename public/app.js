const $ = (selector) => document.querySelector(selector);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CANCEL_REASONS = [
  "Original client is keeping the appointment",
  "Stylist is no longer available",
  "Opening removed in Square",
];
const STATUS_LABELS = {
  searching: "Finding next client",
  offering: "Offer out",
  awaitingStaff: "Needs staff check",
  filled: "Filled",
  cancelled: "Cancelled",
  exhausted: "No one left",
};
const OUTCOME_LABELS = {
  declined: "declined",
  timedOut: "timed out (still on waitlist)",
  unavailableAfterAccept: "accepted, not bookable",
};

let lastRender = "";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const person = (client) => `${esc(client.name)} <span class="muted">${esc(client.mobile)}</span>`;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function formatWindow(ms) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

async function loadConfig() {
  const config = await api("/api/config");
  $("#service").innerHTML = config.services.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#stylist").innerHTML = config.stylists.map((s) => `<option>${esc(s)}</option>`).join("");
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  $("#time").value = `${String(soon.getHours()).padStart(2, "0")}:00`;
  $("#timing").className = config.demoTiming ? "timing demo" : "timing";
  $("#timing").textContent = config.demoTiming
    ? `DEMO TIMING: each client gets ${formatWindow(config.offerTimeoutMs)} to reply (production: 15 minutes).`
    : `Each client gets ${formatWindow(config.offerTimeoutMs)} to reply, then the next eligible client is texted automatically.`;
}

function renderOpening({ workflowId, running, state }) {
  const { opening, status } = state;
  let body = "";
  if (status === "searching") body = `<p>Checking the waitlist for the next eligible client…</p>`;
  if (status === "offering") {
    body = `<p>Offered to <strong>${person(state.currentOffer.client)}</strong>
      · <span class="countdown" data-expires="${esc(state.currentOffer.expiresAt)}"></span></p>`;
  }
  if (status === "awaitingStaff") {
    body = `<div class="hold">
      <p><strong>${esc(state.awaitingStaffFor.name)} accepted.</strong> The opening is held and no one else is being texted.
      Check Square <span class="tag">simulated</span>, then:</p>
      <button data-staff="confirm" data-id="${esc(workflowId)}">Confirm booking</button>
      <button class="secondary" data-staff="unavailable" data-id="${esc(workflowId)}">Can't book: tell client, offer next</button>
    </div>`;
  }
  if (status === "filled") body = `<p class="good">Booked: ${person(state.filledBy)}</p>`;
  if (status === "cancelled") body = `<p>Outreach stopped: ${esc(state.cancelReason)}. Not offered to anyone else.</p>`;
  if (status === "exhausted") body = `<p>No eligible clients left. The opening is unfilled.</p>`;

  const attempts = state.attempts.length
    ? `<ul>${state.attempts.map((a) => `<li>${esc(a.client.name)}: ${OUTCOME_LABELS[a.outcome]}</li>`).join("")}</ul>`
    : `<p class="muted small">None yet</p>`;
  const remaining = state.remaining.length
    ? `<ol>${state.remaining.map((c) => `<li>${esc(c.name)}</li>`).join("")}</ol>`
    : `<p class="muted small">None</p>`;
  const cancel = running
    ? `<div class="cancel">
        <select data-reason-for="${esc(workflowId)}">${CANCEL_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select>
        <button class="danger" data-cancel="${esc(workflowId)}">Opening is gone: stop outreach</button>
      </div>`
    : "";

  return `<article class="card opening ${status}">
    <div class="opening-head">
      <h3>${esc(opening.service)} with ${esc(opening.stylist)} · today ${timeOf(opening.startsAt)}</h3>
      <span class="pill ${status}">${STATUS_LABELS[status]}</span>
    </div>
    ${body}
    <div class="lists">
      <div><h4>Declined / timed out</h4>${attempts}</div>
      ${running ? `<div><h4>Next in line</h4>${remaining}</div>` : ""}
    </div>
    ${cancel}
    <p class="workflow-id"><a href="http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(workflowId)}" target="_blank">${esc(workflowId)}</a></p>
  </article>`;
}

function renderPhone(openings) {
  const messages = openings.flatMap(({ workflowId, state }) =>
    state.messages.map((message) => ({
      ...message,
      workflowId,
      canReply:
        message.kind === "offer" &&
        state.status === "offering" &&
        state.currentOffer?.client.id === message.to.id,
    })),
  );
  messages.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  if (!messages.length) return `<p class="muted">No texts sent yet.</p>`;
  return messages
    .map(
      (m) => `<div class="sms">
        <p class="small muted">To ${esc(m.to.name)} · ${esc(m.to.mobile)} · ${timeOf(m.sentAt)}</p>
        <p>${esc(m.body)}</p>
        ${m.canReply ? `<button data-reply="accept" data-client="${esc(m.to.id)}" data-id="${esc(m.workflowId)}">Accept</button>
          <button class="secondary" data-reply="decline" data-client="${esc(m.to.id)}" data-id="${esc(m.workflowId)}">Decline</button>` : ""}
      </div>`,
    )
    .join("");
}

function renderWaitlist(waitlist) {
  return waitlist
    .map(
      (c, index) => `<tr>
        <td>${index + 1}</td>
        <td>${person(c)}</td>
        <td>${esc(c.service)}${c.preferredStylist ? ` · ${esc(c.preferredStylist)}${c.stylistRequired ? " only" : " preferred"}` : ""}</td>
        <td class="small">${c.availableDays.length === 7 ? "Any day" : c.availableDays.map((d) => DAYS[d]).join(", ")}<br />${c.availableWindows.join(", ")}</td>
        <td>${c.bookedOpeningId ? `<span class="tag">Booked</span>` : `<button class="link" data-remove="${esc(c.id)}">Remove</button>`}</td>
      </tr>`,
    )
    .join("");
}

function tickCountdowns() {
  for (const element of document.querySelectorAll(".countdown")) {
    const left = Math.max(0, Date.parse(element.dataset.expires) - Date.now());
    const minutes = Math.floor(left / 60_000);
    const seconds = Math.floor((left % 60_000) / 1000);
    element.textContent = `${minutes}:${String(seconds).padStart(2, "0")} left to reply`;
  }
}

async function refresh() {
  const [{ openings }, waitlist] = await Promise.all([api("/api/openings"), api("/api/waitlist")]);
  const snapshot = JSON.stringify([openings, waitlist]);
  if (snapshot !== lastRender) {
    lastRender = snapshot;
    $("#openings").innerHTML = openings.length
      ? openings.map(renderOpening).join("")
      : `<p class="muted">No openings yet.</p>`;
    $("#phone").innerHTML = renderPhone(openings);
    $("#waitlist").innerHTML = renderWaitlist(waitlist);
  }
  tickCountdowns();
}

async function act(work) {
  try {
    await work();
  } catch (error) {
    alert(error.message);
  }
  lastRender = "";
  await refresh();
}

$("#new-opening").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  const body = Object.fromEntries(new FormData(event.target));
  try {
    await api("/api/openings", { method: "POST", body });
    await refresh();
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const { id } = target.dataset;
  if (target.dataset.reply) {
    act(() => api(`/api/openings/${id}/respond`, { method: "POST", body: { clientId: target.dataset.client, response: target.dataset.reply } }));
  } else if (target.dataset.staff) {
    act(() => api(`/api/openings/${id}/staff`, { method: "POST", body: { decision: target.dataset.staff } }));
  } else if (target.dataset.cancel) {
    const workflowId = target.dataset.cancel;
    const reason = document.querySelector(`[data-reason-for="${CSS.escape(workflowId)}"]`).value;
    if (confirm(`Stop all outreach for this opening?\n\n${reason}\n\nNo one else will be offered it.`)) {
      act(() => api(`/api/openings/${workflowId}/cancel`, { method: "POST", body: { reason } }));
    }
  } else if (target.dataset.remove) {
    act(() => api(`/api/waitlist/${target.dataset.remove}`, { method: "DELETE" }));
  }
});

loadConfig().then(refresh).catch(console.error);
setInterval(() => refresh().catch(console.error), 1000);
