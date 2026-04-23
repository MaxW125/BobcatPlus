// ============================================================
// CHAT — shared primitives consumed by tab/auth.js + tab/ai.js
//
// Deviation B from the Refactor blueprint: instead of wiring
// `setAddMessage` / `setWaitWithChatCountdown` callbacks from the
// main entry, both consumers import from this module directly.
// Kept free of other module imports so anyone (auth, ai, overview)
// can surface a chat message without risking a circular graph.
// ============================================================

import { $ } from "./state.js";

export function addMessage(type, text) {
  const div = document.createElement("div");
  div.className = "chat-message " + type;
  const sender = type === "user" ? "You" : type === "ai" ? "Bobcat Plus" : "System";
  div.innerHTML = '<div class="sender">' + sender + "</div>" + text.replace(/\n/g, "<br>");
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

export function removeExistingScheduleRefreshPrompts() {
  document
    .querySelectorAll("[data-schedule-refresh-prompt]")
    .forEach((el) => el.remove());
}

export function createCountdownSystemMessage() {
  const div = document.createElement("div");
  div.className = "chat-message system";
  div.innerHTML = '<div class="sender">System</div><div class="countdown-body"></div>';
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  const body = div.querySelector(".countdown-body");
  return {
    setHtml(html) {
      body.innerHTML = html;
      $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
    },
    remove() { div.remove(); },
  };
}

export async function waitWithChatCountdown(totalSeconds) {
  const msg = createCountdownSystemMessage();
  for (let i = totalSeconds; i >= 1; i--) {
    msg.setHtml("Waiting for your TXST session to settle… <strong>" + i + "</strong>s");
    await sleep(1000);
  }
  msg.remove();
}
