// Qwen chat: WebLLM (pinned) in the browser, no build step.
const WEBLLM = "https://esm.run/@mlc-ai/web-llm@0.2.85";
const $ = (id) => document.getElementById(id);
const el = { model: $("model"), load: $("load"), system: $("system"), nogpu: $("nogpu"), progress: $("progress"),
  bar: $("bar").firstElementChild, ptext: $("ptext"), error: $("error"), log: $("log"), form: $("form"),
  input: $("input"), send: $("send"), stop: $("stop"), clear: $("clear"), stats: $("stats") };

let webllm, engine, history = [], busy = false, hasF16 = false, loadedId = null;
const sizes = {}; // model id -> download bytes (fetched from Hugging Face, best effort)
const DEFAULT = "Qwen3-0.6B-q4f16_1-MLC";

function showError(msg) { el.error.textContent = msg; el.error.hidden = !msg; }
const mb = (n) => n >= 1024 ? (n / 1024).toFixed(1) + " GB" : Math.round(n) + " MB";

async function checkGPU() {
  if (!navigator.gpu) return "WebGPU is not available in this browser.";
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return "WebGPU is present but no GPU adapter was found (blocklisted GPU or driver?).";
    hasF16 = a.features.has("shader-f16");
  } catch (e) { return "WebGPU failed to initialise: " + e.message; }
  return "";
}

function gpuHelp(why) {
  el.nogpu.innerHTML = "<b>" + why + "</b><br>Use Chrome or Edge 113+ (desktop, Android 12+), or Safari 18+ / Firefox 141+ on supported systems. " +
    "If it is still missing: enable <code>chrome://flags/#enable-unsafe-webgpu</code> (Linux: also <code>#enable-vulkan</code>), " +
    "turn on hardware acceleration in browser settings, update GPU drivers, and make sure the page is served over HTTPS or localhost.";
  el.nogpu.hidden = false;
}

function modelLabel(m) {
  const dl = sizes[m.model_id];
  return m.model_id.replace("-MLC", "") + " — " + (dl ? "download ~" + mb(dl / 1048576) + ", " : "") + "needs ~" + mb(m.vram_required_MB || 0) + " GPU memory";
}

function fillModels() {
  const list = webllm.prebuiltAppConfig.model_list
    .filter((m) => /^Qwen/.test(m.model_id) && !/q0f/.test(m.model_id) && (hasF16 || !/q4f16/.test(m.model_id)))
    .sort((a, b) => (a.vram_required_MB || 0) - (b.vram_required_MB || 0));
  const prev = el.model.value;
  el.model.innerHTML = "";
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.model_id; o.textContent = modelLabel(m); o._m = m;
    el.model.append(o);
  }
  const want = prev || (hasF16 ? DEFAULT : DEFAULT.replace("q4f16", "q4f32"));
  if ([...el.model.options].some((o) => o.value === want)) el.model.value = want;
}

async function fetchSizes() {
  // Download size = sum of repo files; best effort, falls back to GPU-memory figure only.
  await Promise.all([...el.model.options].map(async (o) => {
    try {
      const r = await fetch("https://huggingface.co/api/models/mlc-ai/" + o.value + "?blobs=true");
      const j = await r.json();
      sizes[o.value] = j.siblings.reduce((s, f) => s + (f.size || 0), 0);
      o.textContent = modelLabel(o._m);
    } catch {}
  }));
}

function addMsg(role, text) {
  const d = document.createElement("div");
  d.className = "msg " + role; d.textContent = text;
  el.log.append(d); el.log.scrollTop = el.log.scrollHeight;
  return d;
}

function setBusy(b) {
  busy = b;
  el.send.hidden = b; el.stop.hidden = !b;
  el.send.disabled = b || !engine; el.input.disabled = !engine;
  el.model.disabled = el.load.disabled = b;
}

async function loadModel() {
  const id = el.model.value;
  showError("");
  el.load.disabled = el.model.disabled = true;
  el.progress.hidden = false; el.bar.style.width = "0";
  el.ptext.textContent = "Starting…";
  try {
    if (engine) { try { await engine.unload(); } catch {} engine = null; }
    const t0 = performance.now();
    engine = await webllm.CreateMLCEngine(id, { initProgressCallback: (p) => {
      el.bar.style.width = Math.round((p.progress || 0) * 100) + "%";
      el.ptext.textContent = p.text;
    } });
    loadedId = id; history = []; el.log.textContent = "";
    el.ptext.textContent = "Loaded " + id + " in " + ((performance.now() - t0) / 1000).toFixed(1) + " s (cached for next time).";
    el.bar.style.width = "100%";
    el.input.placeholder = "Message (Enter to send, Shift+Enter for newline)";
    el.input.focus();
  } catch (e) {
    engine = null;
    const m = String(e && e.message || e);
    const oom = /memory|alloc|OOM|device lost|too large|limit/i.test(m);
    showError((oom ? "Not enough GPU memory for this model. Pick a smaller model from the list and press Load model again. " : "Could not load the model. Check your connection or pick another model. ") + "Details: " + m);
    el.progress.hidden = true;
  }
  el.model.disabled = el.load.disabled = false;
  setBusy(false);
}

async function send() {
  const text = el.input.value.trim();
  if (!text || !engine || busy) return;
  el.input.value = ""; autosize(); showError("");
  history.push({ role: "user", content: text });
  addMsg("user", text);
  const out = addMsg("assistant", "…");
  setBusy(true);
  let acc = "", usage = null, t0 = performance.now();
  try {
    const messages = [];
    if (el.system.value.trim()) messages.push({ role: "system", content: el.system.value.trim() });
    messages.push(...history);
    const req = { messages, stream: true, stream_options: { include_usage: true } };
    if (/^Qwen3/.test(loadedId)) req.extra_body = { enable_thinking: false };
    const chunks = await engine.chat.completions.create(req);
    for await (const c of chunks) {
      const d = c.choices[0]?.delta?.content;
      if (d) { acc += d; out.textContent = acc; el.log.scrollTop = el.log.scrollHeight; }
      if (c.usage) usage = c.usage;
    }
    const secs = (performance.now() - t0) / 1000;
    if (usage) el.stats.textContent = usage.completion_tokens + " tokens, " + (usage.extra?.decode_tokens_per_s || usage.completion_tokens / secs).toFixed(1) + " tok/s decode, " + secs.toFixed(1) + " s total";
  } catch (e) {
    showError("Generation failed: " + (e.message || e) + " — try a smaller model if this is a memory error.");
  }
  if (!acc) out.textContent = "(no output)";
  history.push({ role: "assistant", content: acc });
  setBusy(false); el.input.focus();
}

function autosize() { el.input.style.height = "auto"; el.input.style.height = Math.min(el.input.scrollHeight, 144) + "px"; }

el.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
el.stop.addEventListener("click", () => engine && engine.interruptGenerate());
el.clear.addEventListener("click", () => { if (busy && engine) engine.interruptGenerate(); history = []; el.log.textContent = ""; el.stats.textContent = ""; });
el.load.addEventListener("click", loadModel);

(async () => {
  const why = await checkGPU();
  if (why) { gpuHelp(why); el.load.disabled = el.model.disabled = true; return; }
  try {
    webllm = await import(WEBLLM);
  } catch (e) { showError("Could not load WebLLM from the CDN: " + e.message); return; }
  fillModels();
  fetchSizes();
})();
