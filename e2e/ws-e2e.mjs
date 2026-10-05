import WebSocket from "ws";
import { spawn, execSync } from "node:child_process";

const PAGE = "http://localhost:5174/homepage/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Preflight: leftover sessions from earlier runs would eat the maxSessions
// budget and turn every later step into server_full noise.
try { execSync("docker ps -q --filter ancestor=homepage-shell:latest | xargs -r docker kill", { stdio: "ignore" }); } catch {}

// --- chrome lifecycle -------------------------------------------------------
execSync("rm -rf /tmp/chrome-e2e", { stdio: "ignore" });
const chrome = spawn(
  "google-chrome",
  ["--headless=new", "--remote-debugging-port=9223", "--user-data-dir=/tmp/chrome-e2e", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"],
  { stdio: "ignore" },
);
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
for (let i = 0; i < 50; i++) {
  try { await fetch("http://127.0.0.1:9223/json/version"); break; } catch { await sleep(200); }
}

class Tab {
  static async open(url) {
    const r = await (await fetch("http://127.0.0.1:9223/json/new?about:blank", { method: "PUT" })).json();
    const t = new Tab(r.id);
    await t.connect();
    if (url && url !== "about:blank") await t.navigate(url);
    return t;
  }
  constructor(targetId) { this.targetId = targetId; this.id = 0; this.pending = new Map(); this.wsCount = 0; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:9223/devtools/page/${this.targetId}`);
      // handler first: the cdp() enables below need it to resolve
      this.ws.on("message", (d) => {
        const m = JSON.parse(d);
        if (m.method === "Network.webSocketCreated") this.wsCount++;
        if (m.id && this.pending.has(m.id)) {
          const { res: rs, rej: rj } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rj(new Error(m.error.message)) : rs(m.result);
        }
      });
      this.ws.on("open", async () => {
        try {
          await this.cdp("Page.enable");
          await this.cdp("Runtime.enable");
          await this.cdp("Network.enable");
          res();
        } catch (e) {
          rej(e);
        }
      });
      this.ws.on("error", rej);
    });
  }
  cdp(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  }
  async navigate(url) {
    const loaded = new Promise((res) => this.ws.once("message", (d) => { const m = JSON.parse(d); if (m.method === "Page.loadEventFired") res(); }));
    await this.cdp("Page.navigate", { url });
    await Promise.race([loaded, sleep(15000)]);
  }
  reload() { return this.navigate(PAGE); }
  text() { return this.evaluate(`document.querySelector(".xterm-rows")?.innerText ?? document.body.innerText`); }
  bodyText() { return this.evaluate("document.body.innerText"); }
  storage() { return this.evaluate(`(() => { const r = sessionStorage.getItem("homepage:sessionId"); return r ? JSON.parse(r) : null; })()`); }
  async waitForText(needle, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const t = await this.text().catch(() => "");
      if (t.includes(needle)) return true;
      await sleep(300);
    }
    return false;
  }
  async type(str) {
    for (const ch of str) await this.cdp("Input.insertText", { text: ch });
    await this.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  async clickButton(match) {
    return this.evaluate(`(() => {
      const btns = [...document.querySelectorAll("button")];
      const b = btns.find((x) => x.innerText.toLowerCase().includes(${JSON.stringify(match)}));
      if (b) { b.click(); return true; }
      return false;
    })()`);
  }
  /**
   * Authoritative terminal content: the live xterm buffer via the dev hook.
   * (.xterm-rows innerText serves stale layout in headless after reconnects
   * — it kept showing pre-takeover lines while the buffer had moved on.)
   * Synthetic CDP mouse events also wedge xterm's input pipeline, so there
   * is deliberately no click helper: programmatic button clicks never move
   * focus, and the textarea keeps it through overlay transitions.
   */
  fullBuffer() {
    return this.evaluate(`(() => {
      if (!window.__term) return "";
      const b = window.__term.buffer.active;
      const l = [];
      for (let i = 0; i < b.length; i++) l.push(b.getLine(i)?.translateToString(true) ?? "");
      return l.filter(Boolean).join("\\n");
    })()`);
  }
  async waitForBuffer(needle, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if ((await this.fullBuffer()).includes(needle)) return true;
      await sleep(300);
    }
    return false;
  }
  close() { this.ws.close(); return fetch(`http://127.0.0.1:9223/json/close/${this.targetId}`); }
}

let pass = 0, fail = 0;
const record = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

// --- phase 1: public mode ---------------------------------------------------
const A = await Tab.open(PAGE);
record("T1 boot: motd rendered", await A.waitForBuffer("open hello.md", 20000));

const storeA = await A.storage();
record(
  "T2 storage after create = {id, secret}",
  storeA && typeof storeA.id === "string" && typeof storeA.secret === "string" && storeA.secret.length === 43,
  JSON.stringify(storeA)?.slice(0, 60),
);

await A.type("echo probe$((6*7))");
record("T3 shell interactive: probe42", await A.waitForBuffer("probe42", 10000));

await A.reload();
await sleep(1000);
const storeA2 = await A.storage();
record("T4a reload reattaches: same session id", storeA2?.id === storeA.id, `${storeA.id?.slice(0, 8)} vs ${storeA2?.id?.slice(0, 8)}`);
await A.waitForText("$", 15000) || await A.type(""); // settle
await A.type("echo post$((2*3))");
record("T4b shell interactive after reattach+nudge: post6", await A.waitForBuffer("post6", 10000));

// takeover: B loads (own session), steals A's pair, reloads -> attaches A's session
const B = await Tab.open(PAGE);
await B.waitForText("open hello.md", 20000);
await B.evaluate(`sessionStorage.setItem("homepage:sessionId", ${JSON.stringify(JSON.stringify(storeA))})`);
await B.reload();
await sleep(2000);

const aBody = await A.bodyText();
record("T5a takeover: A shows 'taken over by another window'", aBody.includes("taken over by another window"), aBody.slice(-200).replace(/\n/g, " "));
record("T5b takeover: A storage cleared", (await A.storage()) === null);
const aWsBefore = A.wsCount;
await sleep(6000);
record("T5c takeover: A does not reconnect-war", A.wsCount === aWsBefore, `ws creations ${aWsBefore} -> ${A.wsCount}`);
await B.type("echo tb$((3*3))");
record("T5d winner B interactive: tb9", await B.waitForBuffer("tb9", 10000));

// retry from offline: A clicks retry -> fresh session
const clicked = await A.clickButton("retry");
await sleep(2500);
const storeA3 = await A.storage();
record("T6a retry from offline works", clicked && storeA3 && storeA3.id !== storeA.id, `new id ${storeA3?.id?.slice(0, 8)}`);
// Match the proven timing: give the fresh container's zsh time to boot
// before the first probe — input hammered mid-boot never reaches a prompt.
await sleep(4000);
await A.type("echo ra$((5*5))");
let raOk = await A.waitForBuffer("ra25", 8000);
if (!raOk) {
  await A.type("echo ra$((5*5))");
  raOk = await A.waitForBuffer("ra25", 5000);
}
record("T6b A interactive on fresh session: ra25", raOk);

// storage migration: bare-uuid legacy value treated as absent
await B.evaluate(`sessionStorage.setItem("homepage:sessionId", "123e4567-e89b-42d3-a456-426614174000")`);
await B.reload();
await sleep(2000);
const storeB = await B.storage();
record(
  "T7 legacy bare-uuid value self-migrates to fresh {id, secret}",
  storeB && storeB.id !== "123e4567-e89b-42d3-a456-426614174000" && storeB.secret?.length === 43,
  JSON.stringify(storeB)?.slice(0, 60),
);

await A.close();
await B.close();

console.log(`\n${pass} passed, ${fail} failed`);
chrome.kill("SIGKILL");
process.exit(fail ? 1 : 0);
