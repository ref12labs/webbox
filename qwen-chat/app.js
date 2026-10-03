// Qwen chat: two in-browser engines, no build step, nothing leaves the device.
//  gpu: WebLLM (WebGPU)            cpu: transformers.js + ONNX Runtime Web (WebAssembly)
const WEBLLM = "https://esm.run/@mlc-ai/web-llm@0.2.85";
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const $ = (id) => document.getElementById(id);
const el = { engine: $("engine"), model: $("model"), load: $("load"), system: $("system"), nogpu: $("nogpu"), progress: $("progress"),
  bar: $("bar").firstElementChild, ptext: $("ptext"), error: $("error"), log: $("log"), form: $("form"),
  input: $("input"), send: $("send"), stop: $("stop"), clear: $("clear"), stats: $("stats"), ctx: $("ctx"), reply: $("reply"), ctxnote: $("ctxnote"), meter: $("meter"), meterbar: $("meterbar"), cpunote: $("cpunote"), threads: $("threads") };

const store = {
  get(k) { try { return localStorage.getItem("qwenchat." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("qwenchat." + k, v); } catch {} },
};
const mb = (n) => n >= 1024 ? (n / 1024).toFixed(1) + " GB" : Math.round(n) + " MB";
const errText = (e) => String((e && e.message) || e);
const looksOOM = (m) => /memory|alloc|OOM|device lost|too large|limit|abort|RangeError/i.test(m);

let loadedCtx = 0;
let active = null;       // loaded engine object
let history = [], busy = false, loadedId = null, hasF16 = false, gpuReason = "";
const dlSizes = {};

// ---------------------------------------------------------------- GPU engine (WebLLM)
const gpu = {
  id: "gpu", label: "GPU (WebGPU, WebLLM)", mod: null, engine: null, available: false, reason: "checking…",
  async detect() {
    if (!navigator.gpu) return "no WebGPU in this browser";
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return "no WebGPU adapter (no GPU, blocklisted GPU or driver)";
      hasF16 = a.features.has("shader-f16");
    } catch (e) { return "WebGPU failed: " + errText(e); }
    try { this.mod = await import(WEBLLM); } catch (e) { return "could not load WebLLM from the CDN"; }
    return "";
  },
  models() {
    return this.mod.prebuiltAppConfig.model_list
      .filter((m) => /^Qwen/.test(m.model_id) && !/q0f/.test(m.model_id) && (hasF16 || !/q4f16/.test(m.model_id)))
      .sort((a, b) => (a.vram_required_MB || 0) - (b.vram_required_MB || 0))
      .map((m) => ({ id: m.model_id, label: m.model_id.replace("-MLC", ""), dl: dlSizes[m.model_id], need: "needs ~" + mb(m.vram_required_MB || 0) + " GPU memory" }));
  },
  defaultModel() { return hasF16 ? "Qwen3-0.6B-q4f16_1-MLC" : "Qwen3-0.6B-q4f32_1-MLC"; },
  async load(id, onProgress, ctx) {
    await this.unload();
    this.engine = await this.mod.CreateMLCEngine(id, { initProgressCallback: (p) => onProgress(p.progress || 0, p.text) },
      { context_window_size: ctx });
  },
  // WebLLM exposes no tokenizer: estimate from characters, calibrated by the prompt_tokens it reports after each reply.
  cpt: 3.3, exact: false, how: "estimated (WebLLM has no tokenizer API; calibrated from its own prompt token counts)",
  count(messages) {
    const chars = messages.reduce((s, m) => s + m.content.length, 0);
    return Math.ceil(chars / this.cpt) + 5 * messages.length + 3;
  },
  async generate(messages, id, onText, o) {
    const req = { messages, stream: true, stream_options: { include_usage: true }, max_tokens: o.maxTokens };
    if (/^Qwen3/.test(id)) req.extra_body = { enable_thinking: false };
    let acc = "", usage = null;
    for await (const c of await this.engine.chat.completions.create(req)) {
      const d = c.choices[0]?.delta?.content;
      if (d) { acc += d; onText(acc); }
      if (c.usage) usage = c.usage;
    }
    if (usage?.prompt_tokens) {
      const chars = messages.reduce((s, m) => s + m.content.length, 0), t = usage.prompt_tokens - 5 * messages.length - 3;
      if (t > 20) this.cpt = Math.min(6, Math.max(1.5, 0.5 * this.cpt + 0.5 * (chars / t)));
    }
    return { text: acc, tokens: usage?.completion_tokens, tps: usage?.extra?.decode_tokens_per_s };
  },
  stop() { this.engine && this.engine.interruptGenerate(); },
  async unload() { if (this.engine) { try { await this.engine.unload(); } catch {} this.engine = null; } },
};

// ---------------------------------------------------------------- CPU engine (transformers.js, WASM)
// ONNX builds from onnx-community on Hugging Face, int8 ("q8" = model_quantized.onnx).
const CPU_MODELS = [
  { id: "onnx-community/Qwen2.5-0.5B-Instruct", label: "Qwen2.5-0.5B-Instruct (int8)", mbs: 512 },
  { id: "onnx-community/Qwen3-0.6B-ONNX", label: "Qwen3-0.6B (int8)", mbs: 618 },
  { id: "onnx-community/Qwen2.5-Coder-0.5B-Instruct", label: "Qwen2.5-Coder-0.5B-Instruct (int8)", mbs: 639 },
  { id: "onnx-community/Qwen2.5-1.5B-Instruct", label: "Qwen2.5-1.5B-Instruct (int8, slow)", mbs: 1579 },
];
const cpu = {
  id: "cpu", label: "CPU (WebAssembly)", mod: null, gen: null, stopper: null, available: false, reason: "checking…",
  async detect() {
    if (typeof WebAssembly !== "object") return "no WebAssembly in this browser";
    return "";
  },
  models() { return CPU_MODELS.map((m) => ({ id: m.id, label: m.label, dl: m.mbs * 1048576, need: "runs on CPU" })); },
  defaultModel() { return CPU_MODELS[0].id; },
  async ensureLib() {
    if (this.mod) return;
    this.mod = await import(TRANSFORMERS);
    const wasm = this.mod.env.backends.onnx.wasm;
    // Threads need SharedArrayBuffer, i.e. cross-origin isolation (see README); otherwise stay single-threaded.
    wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1;
    wasm.proxy = true; // run inference in a worker so the page stays responsive and Stop works
  },
  exact: true, how: "counted with the model's own tokenizer",
  count(messages, id) {
    const tok = this.gen.tokenizer, kw = { tokenize: false, add_generation_prompt: true };
    if (/Qwen3/.test(id)) kw.enable_thinking = false;
    return tok.encode(tok.apply_chat_template(messages, kw)).length;
  },
  async load(id, onProgress) {
    await this.unload();
    onProgress(0, "Loading transformers.js…");
    await this.ensureLib();
    const files = {};
    this.gen = await this.mod.pipeline("text-generation", id, {
      dtype: "q8", device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) files[p.file] = { l: p.loaded, t: p.total };
        else if (p.status === "done" && files[p.file]) files[p.file].l = files[p.file].t;
        const v = Object.values(files), L = v.reduce((s, f) => s + f.l, 0), T = v.reduce((s, f) => s + f.t, 0);
        if (p.status === "progress" || p.status === "done") onProgress(T ? L / T : 0, "Downloading " + mb(L / 1048576) + " / " + mb(T / 1048576));
        else if (p.status === "ready") onProgress(1, "Ready");
      },
    });
    onProgress(1, "Compiling / warming up…");
    await this.gen("hi", { max_new_tokens: 1 }); // first run compiles the wasm session; do it now
  },
  async generate(messages, id, onText, o) {
    const { TextStreamer, InterruptableStoppingCriteria } = this.mod;
    this.stopper = new InterruptableStoppingCriteria();
    let acc = "", n = 0, first = 0;
    const streamer = new TextStreamer(this.gen.tokenizer, {
      skip_prompt: true, skip_special_tokens: true,
      callback_function: (t) => { acc += t; onText(acc); },
      token_callback_function: () => { if (!n) first = performance.now(); n++; },
    });
    const opts = { max_new_tokens: o.maxTokens, do_sample: false, streamer, stopping_criteria: this.stopper };
    if (/Qwen3/.test(id)) opts.chat_template_kwargs = { enable_thinking: false };
    await this.gen(messages, opts);
    const dt = (performance.now() - first) / 1000;
    return { text: acc, tokens: n, tps: n > 1 && dt > 0 ? (n - 1) / dt : undefined };
  },
  stop() { this.stopper && this.stopper.interrupt(); },
  async unload() { if (this.gen) { try { await this.gen.dispose(); } catch {} this.gen = null; } },
};
const engines = { gpu, cpu };

// ---------------------------------------------------------------- UI
const KV = [ // [layers, kv heads, head dim] per Qwen family, for the KV-cache cost of a longer context (fp16 K and V)
  [/Qwen3\.5/, null], [/Qwen3-(0\.6|1\.7)B/, [28, 8, 128]], [/Qwen3-(4|8)B/, [36, 8, 128]],
  [/Qwen2(\.5)?(-Coder|-Math)?-0\.5B/, [24, 2, 64]], [/Qwen2(\.5)?(-Coder|-Math)?-1\.5B/, [28, 2, 128]],
  [/Qwen2\.5(-Coder)?-3B/, [36, 2, 128]], [/Qwen2(\.5)?(-Coder|-Math)?-7B/, [28, 4, 128]],
];
function kvMB(id, tokens) {
  const f = KV.find(([r]) => r.test(id));
  return f && f[1] ? tokens * 2 * f[1][0] * f[1][1] * f[1][2] * 2 / 1048576 : null;
}
const isPhone = () => (matchMedia("(pointer: coarse)").matches && innerWidth < 900) || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const CTX_OPTS = { gpu: [4096, 8192, 16384, 32768], cpu: [1024, 2048, 4096, 8192, 16384, 32768] };
const ctxSize = () => +el.ctx.value || 4096;
const replyLen = () => Math.max(16, Math.min(8192, +el.reply.value || 512));
const replyEff = () => Math.min(replyLen(), ctxSize() >> 1); // a reply may use at most half the context

function fillCtx() {
  const e = cur(), saved = +store.get("ctx." + e.id);
  const def = e.id === "cpu" ? 4096 : isPhone() ? 4096 : 8192;
  el.ctx.innerHTML = "";
  for (const n of CTX_OPTS[e.id]) { const o = document.createElement("option"); o.value = n; el.ctx.append(o); }
  el.ctx.value = CTX_OPTS[e.id].includes(saved) ? saved : def;
  updateCtxLabels();
}
function updateCtxLabels() {
  const e = cur(), id = el.model.value;
  for (const o of el.ctx.options) {
    const n = +o.value, extra = e.id === "gpu" ? kvMB(id, n - 4096) : null;
    o.textContent = n / 1024 + "K tokens" + (e.id === "gpu" && n > 4096 ? (extra != null ? " (+~" + mb(extra) + " GPU memory)" : " (extra GPU memory unknown)") : "");
  }
  el.ctxnote.textContent = e.id === "gpu"
    ? "GPU: WebLLM's built-in Qwen configs use 4K; the model supports ~32K. Larger sizes cost extra GPU memory (KV cache estimate for the selected model, relative to 4K) and changing the size reloads the model."
    : "CPU: the max context is used for trimming only; long histories are slow in single-threaded WebAssembly, so 4K is the default.";
}

function updateMeter() {
  const ctx = ctxSize();
  if (!active) { el.meter.textContent = "Context: load a model to count tokens (limit " + ctx + ")"; el.meterbar.value = 0; return; }
  const n = active.count(buildMessages(history), loadedId);
  el.meterbar.max = ctx; el.meterbar.value = Math.min(n, ctx);
  el.meter.textContent = "Context: " + (active.exact ? "" : "~") + n + " / " + ctx + " tokens (" + Math.round(100 * n / ctx) + "%), reply budget " + replyEff() + " · " + active.how;
}
function buildMessages(h) {
  const m = [];
  if (el.system.value.trim()) m.push({ role: "system", content: el.system.value.trim() });
  for (const x of h) m.push({ role: x.role, content: x.content });
  return m;
}
function showError(msg) { el.error.textContent = msg; el.error.hidden = !msg; }
const cur = () => engines[el.engine.value];

function fillModels() {
  const e = cur(), prev = store.get("model." + e.id);
  const list = e.models();
  el.model.innerHTML = "";
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.id; o._m = m; o.textContent = modelText(m);
    el.model.append(o);
  }
  el.model.value = list.some((m) => m.id === prev) ? prev : e.defaultModel();
  el.cpunote.hidden = e.id !== "cpu";
  el.threads.textContent = e.id === "cpu" ? (self.crossOriginIsolated
    ? "Multi-threaded (page is cross-origin isolated)."
    : "Single-threaded: threads need SharedArrayBuffer, which needs cross-origin isolation headers that this host cannot set.") : "";
  fillCtx();
  if (e.id === "gpu") fetchSizes();
  updateMeter();
}
const modelText = (m) => m.label + " — " + (m.dl ? "download ~" + mb(m.dl / 1048576) + ", " : "") + m.need;

async function fetchSizes() { // GPU download sizes from Hugging Face repo listings, best effort
  await Promise.all([...el.model.options].map(async (o) => {
    if (dlSizes[o.value] || cur().id !== "gpu") return;
    try {
      const j = await (await fetch("https://huggingface.co/api/models/mlc-ai/" + o.value + "?blobs=true")).json();
      dlSizes[o.value] = j.siblings.reduce((s, f) => s + (f.size || 0), 0);
      o._m.dl = dlSizes[o.value]; o.textContent = modelText(o._m);
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
  el.send.disabled = b || !active; el.input.disabled = !active;
  el.model.disabled = el.load.disabled = el.engine.disabled = el.ctx.disabled = b;
}

async function loadModel() {
  const e = cur(), id = el.model.value;
  showError("");
  setBusy(true); el.send.hidden = false; el.stop.hidden = true;
  el.progress.hidden = false; el.bar.style.width = "0"; el.ptext.textContent = "Starting…";
  const other = e === gpu ? cpu : gpu;
  if (active === other) { await other.unload(); }
  active = null; el.input.disabled = el.send.disabled = true;
  try {
    const t0 = performance.now();
    await e.load(id, (p, text) => { el.bar.style.width = Math.round(p * 100) + "%"; el.ptext.textContent = text; }, ctxSize());
    loadedCtx = ctxSize();
    active = e; loadedId = id; history = []; el.log.textContent = ""; el.stats.textContent = "";
    store.set("model." + e.id, id);
    el.bar.style.width = "100%";
    el.ptext.textContent = "Loaded " + id + " in " + ((performance.now() - t0) / 1000).toFixed(1) + " s (cached by the browser for next time).";
    el.input.placeholder = "Message (Enter to send, Shift+Enter for newline)";
  } catch (err) {
    const m = errText(err);
    showError((looksOOM(m) ? "Not enough memory for this model" + (e === gpu ? " at this context size" : "") + ". Pick a smaller model" + (e === gpu ? " or context size" : "") + " from the list and press Load model again. " : "Could not load the model. Check your connection or pick another model or engine. ") + "Details: " + m);
    el.progress.hidden = true;
  }
  setBusy(false);
  updateMeter();
  if (active) el.input.focus();
}

async function send() {
  const text = el.input.value.trim();
  if (!text || !active || busy) return;
  const ctx = ctxSize(), reply = replyEff(), e = active;
  const fits = (h) => e.count(buildMessages(h), loadedId) + reply <= ctx;
  const user = { role: "user", content: text };
  if (!fits([user])) {
    showError("This message plus the system prompt and the reply budget (" + reply + " tokens) do not fit in the " + ctx + "-token context. Shorten it, lower the reply length, or raise the context size.");
    return;
  }
  el.input.value = ""; autosize(); showError("");
  // Trim: drop the oldest turns (never the system prompt) until the new turn and the reply fit.
  const pending = [...history, user];
  let dropped = 0;
  while (!fits(pending)) {
    const x = pending.shift(); dropped++; x.node && x.node.classList.add("dropped");
    while (pending.length > 1 && pending[0].role !== "user") { const y = pending.shift(); dropped++; y.node && y.node.classList.add("dropped"); }
  }
  history = pending;
  if (dropped) addMsg("note", "Earlier messages were dropped to fit the context (" + dropped + " message" + (dropped > 1 ? "s" : "") + ", shown dimmed above).");
  user.node = addMsg("user", text);
  const out = addMsg("assistant", "…");
  setBusy(true);
  let res = { text: "" }; const t0 = performance.now();
  try {
    res = await e.generate(buildMessages(history), loadedId, (t) => { out.textContent = t; el.log.scrollTop = el.log.scrollHeight; }, { maxTokens: reply });
    const secs = (performance.now() - t0) / 1000;
    el.stats.textContent = (res.tokens ? res.tokens + " tokens, " : "") + (res.tps ? res.tps.toFixed(1) + " tok/s decode, " : "") + secs.toFixed(1) + " s total";
  } catch (err) {
    showError("Generation failed: " + errText(err) + (looksOOM(errText(err)) ? " — try a smaller model or context size." : ""));
  }
  if (!res.text) out.textContent = "(no output)";
  history.push({ role: "assistant", content: res.text, node: out });
  setBusy(false); updateMeter(); el.input.focus();
}

function autosize() { el.input.style.height = "auto"; el.input.style.height = Math.min(el.input.scrollHeight, 144) + "px"; }

el.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
el.stop.addEventListener("click", () => active && active.stop());
el.clear.addEventListener("click", () => { if (busy && active) active.stop(); history = []; el.log.textContent = ""; el.stats.textContent = ""; updateMeter(); });
el.load.addEventListener("click", loadModel);
el.ctx.addEventListener("change", () => {
  store.set("ctx." + el.engine.value, el.ctx.value); updateMeter();
  if (active === gpu && el.engine.value === "gpu" && loadedCtx !== ctxSize()) loadModel(); // WebLLM needs a reload for a new window size
});
el.reply.value = store.get("reply") || 512;
el.reply.addEventListener("change", () => { el.reply.value = replyLen(); store.set("reply", el.reply.value); updateMeter(); });
el.system.addEventListener("input", updateMeter);
el.model.addEventListener("change", updateCtxLabels);
el.engine.addEventListener("change", () => { store.set("engine", el.engine.value); fillModels(); });

(async () => {
  for (const e of Object.values(engines)) {
    const o = document.createElement("option");
    o.value = e.id; o.textContent = e.label; el.engine.append(o);
  }
  await Promise.all(Object.values(engines).map(async (e) => {
    e.reason = await e.detect(); e.available = !e.reason;
    const o = el.engine.querySelector('option[value="' + e.id + '"]');
    o.disabled = !e.available; o.title = e.reason;
    if (!e.available) o.textContent = e.label + " — unavailable: " + e.reason;
  }));
  el.engine.title = gpu.available ? "" : "GPU unavailable: " + gpu.reason;
  if (!gpu.available) {
    el.nogpu.innerHTML = "<b>GPU engine unavailable: " + gpu.reason + ".</b> Using the CPU engine instead (slower). For WebGPU use Chrome or Edge 113+ (desktop, Android 12+), or Safari 18+ / Firefox 141+ on supported systems; if it is still missing, enable <code>chrome://flags/#enable-unsafe-webgpu</code> (Linux: also <code>#enable-vulkan</code>), turn on hardware acceleration and update GPU drivers.";
    el.nogpu.hidden = false;
  }
  const saved = store.get("engine");
  const pick = saved && engines[saved]?.available ? saved : gpu.available ? "gpu" : cpu.available ? "cpu" : "";
  if (!pick) { showError("Neither WebGPU nor WebAssembly is available in this browser."); el.load.disabled = true; return; }
  el.engine.value = pick;
  fillModels();
})();
