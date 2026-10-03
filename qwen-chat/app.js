// Qwen chat: two in-browser engines, no build step, nothing leaves the device.
//  gpu: WebLLM (WebGPU)            cpu: transformers.js + ONNX Runtime Web (WebAssembly)
const WEBLLM = "https://esm.run/@mlc-ai/web-llm@0.2.85";
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const $ = (id) => document.getElementById(id);
const el = { engine: $("engine"), model: $("model"), load: $("load"), system: $("system"), nogpu: $("nogpu"), progress: $("progress"),
  bar: $("bar").firstElementChild, ptext: $("ptext"), error: $("error"), log: $("log"), form: $("form"),
  input: $("input"), send: $("send"), stop: $("stop"), clear: $("clear"), stats: $("stats"), cpunote: $("cpunote"), threads: $("threads") };

const store = {
  get(k) { try { return localStorage.getItem("qwenchat." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("qwenchat." + k, v); } catch {} },
};
const mb = (n) => n >= 1024 ? (n / 1024).toFixed(1) + " GB" : Math.round(n) + " MB";
const errText = (e) => String((e && e.message) || e);
const looksOOM = (m) => /memory|alloc|OOM|device lost|too large|limit|abort|RangeError/i.test(m);

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
  async load(id, onProgress) {
    await this.unload();
    this.engine = await this.mod.CreateMLCEngine(id, { initProgressCallback: (p) => onProgress(p.progress || 0, p.text) });
  },
  async generate(messages, id, onText, tick) {
    const req = { messages, stream: true, stream_options: { include_usage: true } };
    if (/^Qwen3/.test(id)) req.extra_body = { enable_thinking: false };
    let acc = "", usage = null;
    for await (const c of await this.engine.chat.completions.create(req)) {
      const d = c.choices[0]?.delta?.content;
      if (d) { acc += d; onText(acc); }
      if (c.usage) usage = c.usage;
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
  async generate(messages, id, onText, tick) {
    const { TextStreamer, InterruptableStoppingCriteria } = this.mod;
    this.stopper = new InterruptableStoppingCriteria();
    let acc = "", n = 0, first = 0;
    const streamer = new TextStreamer(this.gen.tokenizer, {
      skip_prompt: true, skip_special_tokens: true,
      callback_function: (t) => { acc += t; onText(acc); },
      token_callback_function: () => { if (!n) first = performance.now(); n++; },
    });
    const opts = { max_new_tokens: 512, do_sample: false, streamer, stopping_criteria: this.stopper };
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
  if (e.id === "gpu") fetchSizes();
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
  el.model.disabled = el.load.disabled = el.engine.disabled = b;
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
    await e.load(id, (p, text) => { el.bar.style.width = Math.round(p * 100) + "%"; el.ptext.textContent = text; });
    active = e; loadedId = id; history = []; el.log.textContent = ""; el.stats.textContent = "";
    store.set("model." + e.id, id);
    el.bar.style.width = "100%";
    el.ptext.textContent = "Loaded " + id + " in " + ((performance.now() - t0) / 1000).toFixed(1) + " s (cached by the browser for next time).";
    el.input.placeholder = "Message (Enter to send, Shift+Enter for newline)";
  } catch (err) {
    const m = errText(err);
    showError((looksOOM(m) ? "Not enough memory for this model. Pick a smaller model from the list and press Load model again. " : "Could not load the model. Check your connection or pick another model or engine. ") + "Details: " + m);
    el.progress.hidden = true;
  }
  setBusy(false);
  if (active) el.input.focus();
}

async function send() {
  const text = el.input.value.trim();
  if (!text || !active || busy) return;
  el.input.value = ""; autosize(); showError("");
  history.push({ role: "user", content: text });
  addMsg("user", text);
  const out = addMsg("assistant", "…");
  setBusy(true);
  let res = { text: "" }; const t0 = performance.now();
  try {
    const messages = [];
    if (el.system.value.trim()) messages.push({ role: "system", content: el.system.value.trim() });
    messages.push(...history);
    res = await active.generate(messages, loadedId, (t) => { out.textContent = t; el.log.scrollTop = el.log.scrollHeight; });
    const secs = (performance.now() - t0) / 1000;
    el.stats.textContent = (res.tokens ? res.tokens + " tokens, " : "") + (res.tps ? res.tps.toFixed(1) + " tok/s decode, " : "") + secs.toFixed(1) + " s total";
  } catch (err) {
    showError("Generation failed: " + errText(err) + (looksOOM(errText(err)) ? " — try a smaller model." : ""));
  }
  if (!res.text) out.textContent = "(no output)";
  history.push({ role: "assistant", content: res.text });
  setBusy(false); el.input.focus();
}

function autosize() { el.input.style.height = "auto"; el.input.style.height = Math.min(el.input.scrollHeight, 144) + "px"; }

el.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
el.stop.addEventListener("click", () => active && active.stop());
el.clear.addEventListener("click", () => { if (busy && active) active.stop(); history = []; el.log.textContent = ""; el.stats.textContent = ""; });
el.load.addEventListener("click", loadModel);
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
