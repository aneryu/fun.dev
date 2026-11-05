import { buildSceneShaders, formatCompilationDiagnostics, MESH_RENDER_WGSL } from "./compiler.js";

const UNIFORM_STRUCT_BYTES = 192; // 48 floats (12 vec4f)
const UNIFORM_SLICE_ALIGN = 256;  // WebGPU minUniformBufferOffsetAlignment
const MAX_SUBSTEP_SLICES = 20;    // Slice 0 = pick, Slices 1..18 = sim substeps, last slice = render
const PICK_BUFFER_BYTES = 48;     // 3 vec4f (hitPos, targetPos, impulse)
const MESH_VERTEX_FLOATS = 16;    // 4 x vec4f (posAndMat, normalAndRough, colorAndMetal, localAndScale)
const MESH_VERTEX_STRIDE = 64;    // 16 * 4 bytes

const MAT_STANDARD = 0.0;
const MAT_VEHICLE_BODY = 1.0;
const MAT_VEHICLE_WHEEL = 2.0;
const MAT_BIPED_CITIZEN = 3.0;
const MAT_GLOSSY_EYE = 4.0;
const MAT_UNLIT_GIZMO = 5.0;
const MAT_SHADOW_DISC = 6.0;
const MAT_ROADBED = 7.0;

const BONE_DEBUG_COLORS = [
  [0.95, 0.78, 0.16],
  [0.95, 0.52, 0.16],
  [0.24, 0.64, 0.82],
  [0.16, 0.48, 0.68],
  [0.72, 0.32, 0.14],
  [0.34, 0.72, 0.46],
  [0.84, 0.38, 0.56],
  [0.54, 0.44, 0.82],
];

export class WebGPUSDFRuntime {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.onStatus = callbacks.onStatus || (() => {});
    this.onDiagnostics = callbacks.onDiagnostics || (() => {});
    this.onFps = callbacks.onFps || (() => {});
    this.onGrabChange = callbacks.onGrabChange || (() => {});

    this.adapter = null;
    this.device = null;
    this.context = null;
    this.ctx2d = null;
    this.softwareBlit = false;
    this.blitPending = false;
    this.offscreenTexture = null;
    this.offscreenReadBuffer = null;
    this.offscreenBytesPerRow = 0;
    this.format = "bgra8unorm";
    this.contextConfigured = false;

    this.scene = null;
    this.lastGoodScene = null;
    this.trialFramesRemaining = 0;
    this.consecutiveLosses = 0;
    this.paramValues = {};
    this.compiled = null;
    this.debugMode = 0; // 0 = shaded, 1 = normals, 2 = step heatmap, 3 = distance slice
    this.gpuErrors = [];

    // Pre-allocated uniform staging scratch buffer (zero per-frame GC allocations)
    this._uniformScratch = new Float32Array(UNIFORM_STRUCT_BYTES / 4);
    this._cachedCamBasis = null;

    // GPU resources
    this.uniformBuffer = null;
    this.stateBufferA = null;
    this.stateBufferB = null;
    this.pickBuffer = null;
    this.pickReadbackBuffer = null;
    this.readbackPending = false;
    this.lastHoverHit = false;
    this.lastGrabActive = false;

    this.computeBindGroupLayout = null;
    this.renderBindGroupLayout = null;
    this.pickPipeline = null;
    this.simPipeline = null;
    this.renderPipeline = null;

    this.computeBindGroupAB = null;
    this.computeBindGroupBA = null;
    this.renderBindGroupA = null;
    this.renderBindGroupB = null;
    this.activeBufferIndex = 0; // 0 = A is current, 1 = B is current

    // Mode B (Baked Auto-Skinned Mesh & Crowd Instancing) + 3D Gizmo resources
    this.renderMode = "raymarch"; // "raymarch" | "mesh" | "crowd"
    this.bakedContext = null; // { ir, bakedResult, crowdInstances }
    this.meshBindGroupLayout = null;
    this.meshBindGroup = null;
    this.meshPipeline = null;
    this.gizmoOverlayPipeline = null;
    this.meshVertexBuffer = null;
    this.meshIndexBuffer = null;
    this.meshVertexCapacity = 0;
    this.meshIndexCapacity = 0;
    this.meshIndexCount = 0;
    this.gizmoIndexCount = 0;
    this._meshVertexScratch = null;
    this._meshIndexScratch = null;
    this._cachedMorphedMesh = null;
    this._cachedMorphedKey = "";
    this.depthTexture = null;
    this.msaaColorTexture = null;
    this.gizmoNodeCenter = null;
    this.onGizmoNodeDrag = callbacks.onGizmoNodeDrag || null;
    this.onGizmoNodeDragEnd = callbacks.onGizmoNodeDragEnd || null;
    this.onUpdateCustomMesh = callbacks.onUpdateCustomMesh || null;

    // Simulation & timing state
    this.running = false;
    this.paused = false;
    this.inViewport = true;
    this.reducedMotion = false;
    this.simTime = 0;
    this.tickCount = 0;
    this.accumulator = 0;
    this.lastFrameTime = 0;
    this.frameTimeEMA = 16.0;
    this.gpuTimeEMA = 4.0;
    this.gpuProbePending = false;
    this.renderScale = 1.0;
    this.rafId = 0;
    this._pausedRenderRaf = 0;
    this.compileToken = 0;
    this.recoveringDevice = false;

    // Cached layout rect updated by ResizeObserver
    this.cssWidth = 640;
    this.cssHeight = 480;

    // Camera & pointer state
    this.camera = {
      target: [0, 0.1, 0],
      distance: 2.8,
      azimuth: 0.35,
      elevation: 0.25,
      fov: 38,
    };

    this.pointer = {
      ndcX: 0,
      ndcY: 0,
      down: false,
      pressedForPick: false,
      releasedForPick: false,
      pressedForSim: false,
      releasedForSim: false,
      pokeHoldUntil: 0,
      spacePokeForSim: false,
      mode: "idle", // "idle" | "grab" | "orbit" | "pending" | "pinch"
      lastX: 0,
      lastY: 0,
      activePointers: new Map(),
      pinchDist: 0,
      pinchMidX: 0,
      pinchMidY: 0,
    };

    // Procedural WebAudio tactile squeak/quack synthesizer (opt-in)
    this.soundEnabled = false;
    this.audioCtx = null;

    this._bindEvents();
  }

  async init() {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      this.onStatus({ state: "unsupported", message: "WebGPU is not available in this browser." });
      return false;
    }

    try {
      this.adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!this.adapter) {
        this.adapter = await navigator.gpu.requestAdapter();
      }
      if (!this.adapter) {
        this.onStatus({ state: "unsupported", message: "No WebGPU adapter found." });
        return false;
      }

      this.device = await this.adapter.requestDevice();
      this.device.addEventListener("uncapturederror", (event) => {
        const msg = event.error?.message || String(event.error || "Unknown WebGPU error");
        this.gpuErrors.push(msg);
        console.error("[WebGPU uncapturederror]", msg);
      });
      this.device.lost.then((info) => {
        if (this.recoveringDevice) return;
        this._handleDeviceLost(info);
      });

      this.softwareBlit = Boolean(this.adapter.info?.isFallbackAdapter);
      if (this.softwareBlit) {
        this.format = "rgba8unorm";
        this.renderScale = 0.65;
        this.ctx2d = this.canvas.getContext("2d");
      } else {
        this.context = this.canvas.getContext("webgpu");
        this.format = navigator.gpu.getPreferredCanvasFormat();
      }
      this.contextConfigured = false;
      this._measureCanvasRect();
      this._configureCanvas();
      this._createLayoutsAndCommonBuffers();

      this.onStatus({ state: "ready", message: "WebGPU initialized." });
      return true;
    } catch (error) {
      this.onStatus({ state: "unsupported", message: error.message || "Failed to initialize WebGPU." });
      return false;
    }
  }

  async _handleDeviceLost(info) {
    this.consecutiveLosses++;
    if (this.consecutiveLosses > 2) {
      this.stop();
      this.onStatus({
        state: "lost",
        message: "GPU reset repeatedly; halted automatic recovery to protect browser stability.",
      });
      return;
    }

    this.recoveringDevice = true;
    this.stop();
    this.onStatus({
      state: "lost",
      message: `GPU reset (${info?.reason || "watchdog"}): recovering with last verified shader...`,
    });
    await new Promise((r) => setTimeout(r, 300));
    const ok = await this.init();
    this.recoveringDevice = false;
    if (ok && this.lastGoodScene) {
      await this.loadScene(this.lastGoodScene, { resetCamera: false, resetState: true });
      this.onDiagnostics([
        {
          type: "warning",
          line: 1,
          column: 1,
          message: "GPU watchdog reset occurred; restored last verified shader.",
        },
      ]);
      if (!this.paused) this.start();
    }
  }

  _clampCameraElevation() {
    const groundY = Number.isFinite(this.scene?.ground?.y) ? Number(this.scene.ground.y) : -0.55;
    const minCamY = groundY + 0.08;
    const dy = (minCamY - this.camera.target[1]) / Math.max(0.5, this.camera.distance);
    const minElFromGround = Math.asin(Math.max(-0.95, Math.min(0.4, dy)));
    const minEl = Math.max(-0.35, minElFromGround);
    this.camera.elevation = Math.max(minEl, Math.min(1.25, this.camera.elevation));
  }

  _measureCanvasRect() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
    }
  }

  _configureCanvas() {
    if (!this.device) return;
    if (this.softwareBlit && this.blitPending) return;
    const isBounded = this.renderMode === "raymarch";
    const rawDpr = Math.min(window.devicePixelRatio || 1, isBounded ? 1.35 : 2.0);
    const maxPixels = isBounded ? 820000 : 3686400;
    const rawPixels = this.cssWidth * this.cssHeight * rawDpr * rawDpr;
    const budgetScale = rawPixels > maxPixels ? Math.sqrt(maxPixels / rawPixels) : 1.0;
    const effScale = this.renderMode === "custom_mesh" ? 1.0 : this.renderScale;
    const dpr = rawDpr * budgetScale * effScale;
    const width = Math.max(64, Math.round(this.cssWidth * dpr));
    const height = Math.max(64, Math.round(this.cssHeight * dpr));
    const sizeChanged = this.canvas.width !== width || this.canvas.height !== height;

    if (sizeChanged) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (this.renderMode !== "raymarch" && (sizeChanged || !this.depthTexture || !this.msaaColorTexture)) {
      if (this.depthTexture) this.depthTexture.destroy();
      if (this.msaaColorTexture) this.msaaColorTexture.destroy();
      this.depthTexture = this.device.createTexture({
        size: [width, height],
        sampleCount: 4,
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.msaaColorTexture = this.device.createTexture({
        size: [width, height],
        sampleCount: 4,
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    if (this.softwareBlit) {
      if (sizeChanged || !this.offscreenTexture) {
        if (this.offscreenTexture) this.offscreenTexture.destroy();
        if (this.offscreenReadBuffer) this.offscreenReadBuffer.destroy();
        this.offscreenTexture = this.device.createTexture({
          size: [width, height],
          format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        this.offscreenBytesPerRow = Math.ceil((width * 4) / 256) * 256;
        this.offscreenReadBuffer = this.device.createBuffer({
          size: this.offscreenBytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      }
    } else if (this.context && !this.contextConfigured) {
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "opaque",
      });
      this.contextConfigured = true;
    }
  }

  _createLayoutsAndCommonBuffers() {
    const device = this.device;

    this.computeBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_STRUCT_BYTES },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    this.renderBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_STRUCT_BYTES },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SLICE_ALIGN * MAX_SUBSTEP_SLICES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pickBuffer = device.createBuffer({
      size: PICK_BUFFER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.pickReadbackBuffer = device.createBuffer({
      size: PICK_BUFFER_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this.sdfBlocksBuffer = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.meshBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_STRUCT_BYTES },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", minBindingSize: 1024 },
        },
      ],
    });

    this.meshBindGroup = device.createBindGroup({
      layout: this.meshBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: { buffer: this.sdfBlocksBuffer, size: 1024 } },
      ],
    });

    const meshModule = device.createShaderModule({ code: MESH_RENDER_WGSL });
    const meshLayout = device.createPipelineLayout({ bindGroupLayouts: [this.meshBindGroupLayout] });
    const meshBufferLayout = {
      arrayStride: MESH_VERTEX_STRIDE, // 16 floats: posAndMat (4) + normalAndRough (4) + colorAndMetal (4) + localAndScale (4)
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: "float32x4" },
        { shaderLocation: 2, offset: 32, format: "float32x4" },
        { shaderLocation: 3, offset: 48, format: "float32x4" },
      ],
    };
    this.meshPipeline = device.createRenderPipeline({
      layout: meshLayout,
      vertex: {
        module: meshModule,
        entryPoint: "vsMeshMain",
        buffers: [meshBufferLayout],
      },
      fragment: {
        module: meshModule,
        entryPoint: "fsMeshMain",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      multisample: {
        count: 4,
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.gizmoOverlayPipeline = device.createRenderPipeline({
      layout: meshLayout,
      vertex: {
        module: meshModule,
        entryPoint: "vsMeshMain",
        buffers: [meshBufferLayout],
      },
      fragment: {
        module: meshModule,
        entryPoint: "fsMeshMain",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      multisample: {
        count: 4,
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });

    this.gizmoOverlayNoDepthPipeline = device.createRenderPipeline({
      layout: meshLayout,
      vertex: {
        module: meshModule,
        entryPoint: "vsMeshMain",
        buffers: [meshBufferLayout],
      },
      fragment: {
        module: meshModule,
        entryPoint: "fsMeshMain",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
    });
  }

  _updateModeAGizmoBuffer() {
    if (!this.device || !this.gizmoNodeCenter) return false;
    this._ensureMeshBuffers(6, 24);
    const vData = this._meshVertexScratch.subarray(0, 6 * MESH_VERTEX_FLOATS);
    const iData = this._meshIndexScratch.subarray(0, 24);
    appendGizmoOctahedron(
      vData,
      iData,
      0,
      0,
      this.gizmoNodeCenter[0],
      this.gizmoNodeCenter[1],
      this.gizmoNodeCenter[2],
      0.042
    );
    this.device.queue.writeBuffer(this.meshVertexBuffer, 0, vData.buffer, vData.byteOffset, vData.byteLength);
    this.device.queue.writeBuffer(this.meshIndexBuffer, 0, iData.buffer, iData.byteOffset, iData.byteLength);
    return true;
  }

  _recreateStateBuffers(scene, stateCount) {
    const device = this.device;
    if (this.stateBufferA) this.stateBufferA.destroy();
    if (this.stateBufferB) this.stateBufferB.destroy();

    const byteLength = Math.max(16, stateCount * 16);
    const initial = new Float32Array(stateCount * 4);
    if (typeof scene.initialState === "function") {
      scene.initialState(initial, stateCount);
    } else if (Array.isArray(scene.initialState)) {
      for (let i = 0; i < Math.min(initial.length, scene.initialState.length); i++) {
        initial[i] = Number(scene.initialState[i]) || 0;
      }
    }

    this.stateBufferA = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.stateBufferB = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(this.stateBufferA, 0, initial);
    device.queue.writeBuffer(this.stateBufferB, 0, initial);
    device.queue.writeBuffer(this.pickBuffer, 0, new Float32Array(12));
    this.activeBufferIndex = 0;

    this.computeBindGroupAB = device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: { buffer: this.stateBufferA } },
        { binding: 2, resource: { buffer: this.stateBufferB } },
        { binding: 3, resource: { buffer: this.pickBuffer } },
      ],
    });

    this.computeBindGroupBA = device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: { buffer: this.stateBufferB } },
        { binding: 2, resource: { buffer: this.stateBufferA } },
        { binding: 3, resource: { buffer: this.pickBuffer } },
      ],
    });

    this.renderBindGroupA = device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: { buffer: this.stateBufferA } },
        { binding: 2, resource: { buffer: this.pickBuffer } },
      ],
    });

    this.renderBindGroupB = device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: { buffer: this.stateBufferB } },
        { binding: 2, resource: { buffer: this.pickBuffer } },
      ],
    });
  }

  async loadScene(scene, { resetCamera = true, resetState = true, isTrustedDefault = false } = {}) {
    const token = ++this.compileToken;
    const built = buildSceneShaders(scene);
    if (!built.ok) {
      this.onDiagnostics(built.errors);
      this.onStatus({ state: "error", message: "WGSL validation error." });
      return { ok: false, errors: built.errors };
    }

    if (!this.device) {
      this.onDiagnostics([]);
      return { ok: false, errors: [] };
    }

    this.onStatus({ state: "compiling", message: "Compiling WebGPU pipelines..." });

    const device = this.device;
    device.pushErrorScope("validation");
    const computeModule = device.createShaderModule({ code: built.computeWGSL });
    const renderModule = device.createShaderModule({ code: built.renderWGSL });

    const [computeInfo, renderInfo] = await Promise.all([
      computeModule.getCompilationInfo(),
      renderModule.getCompilationInfo(),
      device.popErrorScope(),
    ]);

    if (token !== this.compileToken) return { ok: false, cancelled: true };

    const allMessages = [...computeInfo.messages, ...renderInfo.messages];
    const seen = new Set();
    const deduped = allMessages.filter((m) => {
      const key = `${m.type}:${m.lineNum}:${m.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const diagnostics = formatCompilationDiagnostics(deduped, built.userLineCount, scene.wgsl.trim());
    this.onDiagnostics(diagnostics);

    if (diagnostics.some((d) => d.type === "error")) {
      this.onStatus({ state: "error", message: "WGSL compilation error." });
      return { ok: false, errors: diagnostics };
    }

    try {
      const computeLayout = device.createPipelineLayout({
        bindGroupLayouts: [this.computeBindGroupLayout],
      });
      const renderLayout = device.createPipelineLayout({
        bindGroupLayouts: [this.renderBindGroupLayout],
      });

      const [pickPipeline, simPipeline, renderPipeline] = await Promise.all([
        device.createComputePipelineAsync({
          layout: computeLayout,
          compute: { module: computeModule, entryPoint: "csPickMain" },
        }),
        device.createComputePipelineAsync({
          layout: computeLayout,
          compute: { module: computeModule, entryPoint: "csSimMain" },
        }),
        device.createRenderPipelineAsync({
          layout: renderLayout,
          vertex: { module: renderModule, entryPoint: "vsMain" },
          fragment: {
            module: renderModule,
            entryPoint: "fsMain",
            targets: [{ format: this.format }],
          },
          primitive: { topology: "triangle-list" },
        }),
      ]);

      if (token !== this.compileToken) return { ok: false, cancelled: true };

      this.pickPipeline = pickPipeline;
      this.simPipeline = simPipeline;
      this.renderPipeline = renderPipeline;
      this.scene = scene;
      this.compiled = built;

      // Only promote to lastGoodScene immediately if it's a built-in default or no good scene exists yet;
      // user-edited shaders undergo a 45-frame trial before becoming lastGoodScene (prevents TDR loop).
      if (isTrustedDefault || !this.lastGoodScene) {
        this.lastGoodScene = scene;
        this.trialFramesRemaining = 0;
      } else {
        this.trialFramesRemaining = 45;
      }

      if (resetState || !this.stateBufferA) {
        this._recreateStateBuffers(scene, built.stateCount);
        this.simTime = 0;
        this.tickCount = 0;
        this.accumulator = 0;
      }

      if (resetCamera && scene.camera) {
        this.camera.target = [...(scene.camera.target || [0, 0.1, 0])];
        const baseDist = scene.camera.distance ?? 2.8;
        this.camera.fov = scene.camera.fov ?? 38;
        if (scene.bounds && Number.isFinite(scene.bounds.radius)) {
          const halfFovRad = ((this.camera.fov || 38) * Math.PI) / 360;
          const aspect = this.canvas ? Math.max(0.5, (this.canvas.width || 640) / Math.max(1, this.canvas.height || 640)) : 1.0;
          const minFitDist = (scene.bounds.radius / (Math.sin(halfFovRad) * Math.min(1.0, aspect))) * 0.96;
          this.camera.distance = Math.max(baseDist, minFitDist);
        } else {
          this.camera.distance = baseDist;
        }
        this.camera.azimuth = scene.camera.angles?.[0] ?? 0.35;
        this.camera.elevation = scene.camera.angles?.[1] ?? 0.25;
        this._clampCameraElevation();
      }

      if (resetState) {
        this.paramValues = {};
        for (const [key, spec] of Object.entries(scene.params || {})) {
          this.paramValues[key] = spec.default ?? 1.0;
        }
      }

      this.onStatus({
        state: this.paused ? "paused" : "running",
        message: this.paused ? "WebGPU · Paused" : "WebGPU · Live",
      });
      return { ok: true, errors: [] };
    } catch (error) {
      const errDiag = [{ type: "error", line: 1, column: 1, message: error.message || "Pipeline creation failed." }];
      this.onDiagnostics(errDiag);
      this.onStatus({ state: "error", message: "Pipeline creation failed." });
      return { ok: false, errors: errDiag };
    }
  }

  _schedulePausedRender() {
    if (!this.paused || this._pausedRenderRaf) return;
    this._pausedRenderRaf = requestAnimationFrame(() => {
      this._pausedRenderRaf = 0;
      this.renderSingleFrame();
    });
  }

  resetSimulation() {
    if (!this.scene || !this.compiled || !this.device) return;
    this._recreateStateBuffers(this.scene, this.compiled.stateCount);
    this.simTime = 0;
    this.tickCount = 0;
    this.accumulator = 0;
    this.renderSingleFrame();
  }

  setParam(key, value) {
    this.paramValues[key] = Number(value);
    this._cachedMorphedKey = "";
    if (this.paused) {
      this._schedulePausedRender();
    }
  }

  setDebugMode(mode) {
    this.debugMode = Number(mode) || 0;
    if (this.paused) {
      this._schedulePausedRender();
    }
  }

  setRenderMode(mode) {
    this.renderMode = ["raymarch", "mesh", "crowd", "animate_compare", "world", "custom_mesh"].includes(mode)
      ? mode
      : "raymarch";
    if (this.paused) {
      this._schedulePausedRender();
    }
  }

  uploadCustomMeshStream(vData, iData, indexCount, gizmoIndexCount = 0, version = null, blocksUniformData = null) {
    if (!this.device || !vData || !iData || indexCount <= 0) {
      this.meshIndexCount = 0;
      this.gizmoIndexCount = 0;
      this._uploadedCustomVersion = null;
      return;
    }
    if (
      version !== null &&
      this._uploadedCustomVersion === version &&
      this.meshIndexCount === indexCount &&
      this.gizmoIndexCount === gizmoIndexCount
    ) {
      return;
    }
    const vertexCount = Math.floor(vData.length / MESH_VERTEX_FLOATS);
    this._ensureMeshBuffers(vertexCount, indexCount);
    this.device.queue.writeBuffer(this.meshVertexBuffer, 0, vData.buffer, vData.byteOffset, vData.byteLength);
    this.device.queue.writeBuffer(this.meshIndexBuffer, 0, iData.buffer, iData.byteOffset, indexCount * 4);
    if (blocksUniformData && this.sdfBlocksBuffer && blocksUniformData.byteLength >= 1024) {
      this.device.queue.writeBuffer(
        this.sdfBlocksBuffer,
        0,
        blocksUniformData.buffer,
        blocksUniformData.byteOffset,
        1024
      );
    }
    this.meshIndexCount = indexCount;
    this.gizmoIndexCount = gizmoIndexCount;
    this._uploadedCustomVersion = version;
  }

  setGaitOptions(opts) {
    this.gaitOptions = opts ? { ...(this.gaitOptions || {}), ...opts } : {};
    if (this.paused) {
      this._schedulePausedRender();
    }
  }

  attachMeshHooks(hooks) {
    this.meshHooks = hooks || null;
  }

  setBakedContext(ir, bakedResult, crowdCount = 16) {
    this._cachedMorphedMesh = null;
    this._cachedMorphedKey = "";
    if (!ir || !bakedResult || !this.meshHooks) {
      this.bakedContext = null;
      return;
    }
    const crowdInstances = this.meshHooks.generateCrowdInstances(ir, bakedResult, crowdCount, 1.05);
    this.bakedContext = { ir, bakedResult, crowdInstances };
    if (this.paused) {
      this._schedulePausedRender();
    }
  }

  setGizmoNodeCenter(centerVec3) {
    this.gizmoNodeCenter = Array.isArray(centerVec3) ? [...centerVec3] : null;
    if (this.paused) {
      this._schedulePausedRender();
    }
  }

  _ensureMeshBuffers(vertexCount, indexCount) {
    if (!this.device) return;
    if (vertexCount > this.meshVertexCapacity || !this.meshVertexBuffer || !this._meshVertexScratch) {
      if (this.meshVertexBuffer) this.meshVertexBuffer.destroy();
      this.meshVertexCapacity = Math.max(vertexCount, 4096) * 2;
      this.meshVertexBuffer = this.device.createBuffer({
        size: this.meshVertexCapacity * MESH_VERTEX_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this._meshVertexScratch = new Float32Array(this.meshVertexCapacity * MESH_VERTEX_FLOATS);
    }
    if (indexCount > this.meshIndexCapacity || !this.meshIndexBuffer || !this._meshIndexScratch) {
      if (this.meshIndexBuffer) this.meshIndexBuffer.destroy();
      this.meshIndexCapacity = Math.max(indexCount, 12288) * 2;
      this.meshIndexBuffer = this.device.createBuffer({
        size: this.meshIndexCapacity * 4,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this._meshIndexScratch = new Uint32Array(this.meshIndexCapacity);
    }
  }

  _updateModeBMeshBuffers(interpTime) {
    if (this.renderMode === "custom_mesh" && this.onUpdateCustomMesh) {
      this.onUpdateCustomMesh(this, interpTime);
      return;
    }
    if (!this.device || !this.bakedContext || !this.meshHooks) {
      this.meshIndexCount = 0;
      this.gizmoIndexCount = 0;
      return;
    }
    if (this.renderMode === "animate_compare" && this.meshHooks.packAnimateCompareScene) {
      this.meshHooks.packAnimateCompareScene(this, interpTime, this.gaitOptions || {});
      return;
    }
    if (this.renderMode === "world" && this.meshHooks.stepAndPackWorld) {
      this.meshHooks.stepAndPackWorld(this, interpTime);
      return;
    }
    const {
      evaluateCSRMorphedMesh,
      evaluateProceduralRigPose,
      evaluateSkinnedMesh,
    } = this.meshHooks;
    const { ir, bakedResult, crowdInstances } = this.bakedContext;
    const skinning = bakedResult.skinning;
    const baseMesh = bakedResult.baseMesh;

    if (this.renderMode === "mesh") {
      const morphKey = JSON.stringify(this.paramValues);
      if (!this._cachedMorphedMesh || this._cachedMorphedKey !== morphKey) {
        this._cachedMorphedMesh = evaluateCSRMorphedMesh(ir, bakedResult, this.paramValues);
        this._cachedMorphedKey = morphKey;
      }
      const morphed = this._cachedMorphedMesh;
      const activeSkinning = morphed.skinning || skinning;
      const pose = this.meshHooks.evaluateFootLockedIKPose
        ? this.meshHooks.evaluateFootLockedIKPose(ir, interpTime, {
            ...(this.gaitOptions || {}),
            speed: this.reducedMotion ? 0.0 : (this.gaitOptions?.speed ?? 1.0),
          }).boneTransforms
        : evaluateProceduralRigPose(ir, interpTime, {
            amplitude: this.reducedMotion ? 0.0 : 1.0,
          });
      const skinned = evaluateSkinnedMesh(ir, morphed, activeSkinning, pose);
      const V = skinned.vertexCount;
      const I = skinned.indices.length;

      // Reserve extra vertices/indices for ground contact shadow disc (13 verts, 36 indices) + optional 3D gizmo octahedron (6 verts, 24 indices)
      const shadowV = 13;
      const shadowI = 36;
      const gizmoV = this.gizmoNodeCenter ? 6 : 0;
      const gizmoI = this.gizmoNodeCenter ? 24 : 0;
      const totalV = V + shadowV + gizmoV;
      const totalI = I + shadowI + gizmoI;
      this._ensureMeshBuffers(totalV, totalI);

      const vData = this._meshVertexScratch.subarray(0, totalV * MESH_VERTEX_FLOATS);
      const iData = this._meshIndexScratch.subarray(0, totalI);

      const tintShift =
        ((this.paramValues.eyeTint ?? this.paramValues.coatTint ?? this.paramValues.cabTint ?? 0.5) - 0.5) * 0.22;
      const beakBoneIdx = ir.boneNameToIndex.get("beak");
      const wingLBoneIdx = ir.boneNameToIndex.get("wing.L");
      const wingRBoneIdx = ir.boneNameToIndex.get("wing.R");
      const isVehicle = ir.rigTemplate === "vehicle4" || ir.boneNameToIndex.has("wheel.FL");
      const isBiped = ir.rigTemplate === "biped15" || ir.boneNameToIndex.has("thigh.L");
      const baseRefPos = morphed.baseReferencePositions || baseMesh.positions;
      const hoodScale = Math.max(0.5, (this.paramValues.hoodLen ?? 0.25) / 0.25);
      const cabinScale = Math.max(0.5, (this.paramValues.cabinLen ?? 0.14) / 0.14);

      for (let v = 0; v < V; v++) {
        // Keep 1:1 world coordinates so Mode A, Mode B, and 3D Gizmo ray hit-testing are identical
        const px = skinned.positions[v * 3];
        const py = skinned.positions[v * 3 + 1];
        const pz = skinned.positions[v * 3 + 2];
        const nx = skinned.normals[v * 3];
        const ny = skinned.normals[v * 3 + 1];
        const nz = skinned.normals[v * 3 + 2];

        let r = 0.96, g = 0.78 + tintShift, b = 0.16;
        let matId = MAT_STANDARD;
        let rough = 0.34;
        let metal = 0.0;
        let locX = 0.0, locY = 0.0, locZ = 0.0, scaleW = 1.0;
        const domBone = activeSkinning.dominantBones?.[v] ?? 0;
        const gTag = skinned.groupTags?.[v] || "body";

        if (this.debugMode === 2) {
          // 4-bone auto-skinning weight blend visualization
          r = 0; g = 0; b = 0;
          for (let s = 0; s < 4; s++) {
            const w = (activeSkinning.weights[v * 4 + s] || 0) / 255.0;
            const jb = (activeSkinning.joints[v * 4 + s] || 0) % BONE_DEBUG_COLORS.length;
            const c = BONE_DEBUG_COLORS[jb];
            r += c[0] * w;
            g += c[1] * w;
            b += c[2] * w;
          }
        } else if (this.debugMode === 3) {
          // Island group + CSR morph displacement intensity visualization
          const refIdx = Math.min(v, Math.floor(baseRefPos.length / 3) - 1);
          const disp = Math.hypot(
            morphed.positions[v * 3] - baseRefPos[refIdx * 3],
            morphed.positions[v * 3 + 1] - baseRefPos[refIdx * 3 + 1],
            morphed.positions[v * 3 + 2] - baseRefPos[refIdx * 3 + 2]
          );
          const heat = Math.min(1.0, disp / (baseMesh.voxelSize * 1.5));
          const isSubIsland = gTag !== "body";
          r = isSubIsland ? 0.22 + heat * 0.75 : 0.18 + heat * 0.80;
          g = isSubIsland ? 0.62 - heat * 0.25 : 0.48 * (1.0 - heat * 0.5);
          b = isSubIsland ? 0.82 : 0.72 * (1.0 - heat);
        } else {
          if (isVehicle) {
            const restX = morphed.positions[v * 3];
            const restY = morphed.positions[v * 3 + 1];
            const restZ = morphed.positions[v * 3 + 2];
            if (gTag.startsWith("wheel")) {
              r = 0.20; g = 0.22; b = 0.25;
              matId = MAT_VEHICLE_WHEEL;
              rough = 0.76;
              locX = restX; locY = restY; locZ = restZ;
            } else if (gTag === "roofSign") {
              r = 1.0; g = 0.94; b = 0.62;
              rough = 0.18;
            } else {
              const cabVal = this.paramValues.cabTint ?? 0.5;
              r = 0.98 - Math.max(0, cabVal - 0.55) * 1.2;
              g = 0.76 + (cabVal - 0.5) * 0.25;
              b = 0.14 + Math.max(0, cabVal - 0.5) * 1.3;
              matId = MAT_VEHICLE_BODY;
              rough = 0.22;
              locX = restX;
              locY = restY;
              locZ = restZ / hoodScale;
              scaleW = cabinScale / hoodScale;
            }
          } else if (isBiped) {
            const restX = morphed.positions[v * 3];
            const restY = morphed.positions[v * 3 + 1];
            const restZ = morphed.positions[v * 3 + 2];
            if (gTag === "pack") {
              r = 0.42; g = 0.26; b = 0.16;
              rough = 0.45;
            } else {
              const coatVal = this.paramValues.coatTint ?? 0.35;
              r = 0.24 + (1.0 - coatVal) * 0.54;
              g = 0.30 + Math.sin(coatVal * Math.PI) * 0.26;
              b = 0.28 + coatVal * 0.46;
              matId = MAT_BIPED_CITIZEN;
              rough = 0.68;
              locX = restX; locY = restY; locZ = restZ;
            }
          } else if (gTag === "buoy") {
            r = 0.94; g = 0.36 - tintShift * 0.5; b = 0.24 + tintShift * 1.2;
            rough = 0.24;
          } else if (gTag.startsWith("eye")) {
            r = 0.04; g = 0.04; b = 0.05;
            matId = MAT_GLOSSY_EYE;
            rough = 0.03;
            locX = morphed.positions[v * 3];
            locY = morphed.positions[v * 3 + 1];
            locZ = morphed.positions[v * 3 + 2];
          } else if (gTag === "beak" || domBone === beakBoneIdx) {
            r = 0.96; g = 0.46; b = 0.10;
            rough = 0.30;
          } else if (domBone === wingLBoneIdx || domBone === wingRBoneIdx) {
            r = 0.94; g = 0.72 + tintShift; b = 0.14;
            rough = 0.34;
          }
          if (this.gizmoNodeCenter) {
            const gx = this.gizmoNodeCenter[0];
            const gy = this.gizmoNodeCenter[1];
            const gz = this.gizmoNodeCenter[2];
            const distToGizmo = Math.hypot(px - gx, py - gy, pz - gz);
            if (distToGizmo < 0.16) {
              r = Math.min(1.0, r * 0.65 + 0.10);
              g = Math.min(1.0, g * 0.65 + 0.35);
              b = Math.min(1.0, b * 0.45 + 0.55);
            }
          }
        }

        const base = v * MESH_VERTEX_FLOATS;
        vData[base] = px;
        vData[base + 1] = py;
        vData[base + 2] = pz;
        vData[base + 3] = matId;
        vData[base + 4] = nx;
        vData[base + 5] = ny;
        vData[base + 6] = nz;
        vData[base + 7] = rough;
        vData[base + 8] = r;
        vData[base + 9] = g;
        vData[base + 10] = b;
        vData[base + 11] = metal;
        vData[base + 12] = locX;
        vData[base + 13] = locY;
        vData[base + 14] = locZ;
        vData[base + 15] = scaleW;
      }

      iData.set(skinned.indices, 0);

      // Append ground contact shadow disc at world ground (y = 0.01)
      appendShadowDisc(vData, iData, V, I, 0.0, 0.01, 0.0, 0.28);

      // Append 3D Gizmo octahedron marker at selected node center in 1:1 world space
      if (this.gizmoNodeCenter) {
        appendGizmoOctahedron(
          vData,
          iData,
          V + shadowV,
          I + shadowI,
          this.gizmoNodeCenter[0],
          this.gizmoNodeCenter[1],
          this.gizmoNodeCenter[2],
          0.042
        );
      }

      this.device.queue.writeBuffer(this.meshVertexBuffer, 0, vData.buffer, vData.byteOffset, vData.byteLength);
      this.device.queue.writeBuffer(this.meshIndexBuffer, 0, iData.buffer, iData.byteOffset, iData.byteLength);
      this.meshIndexCount = totalI;
      this.gizmoIndexCount = gizmoI;
      return;
    }

    // Mode B Crowd: render all DNA-varied instances with phase-offset skeletal poses
    const instances = crowdInstances || [];
    const isVehicle = ir.rigTemplate === "vehicle4" || ir.boneNameToIndex.has("wheel.FL");
    const isBiped = ir.rigTemplate === "biped15" || ir.boneNameToIndex.has("thigh.L");
    const laneCfg = ir.crowd || {};
    const hasRoadbed = isVehicle && (laneCfg.layout === "lanes" || laneCfg.lanes > 0);
    const roadV = hasRoadbed ? 8 : 0;
    const roadI = hasRoadbed ? 12 : 0;

    let totalV = roadV;
    let totalI = roadI;
    for (let idx = 0; idx < instances.length; idx++) {
      const inst = instances[idx];
      totalV += (inst.vertexCount ?? baseMesh.vertexCount) + 13;
      totalI += (inst.indices?.length ?? baseMesh.indices.length) + 36;
    }
    this._ensureMeshBuffers(totalV, totalI);

    const vData = this._meshVertexScratch.subarray(0, totalV * MESH_VERTEX_FLOATS);
    const iData = this._meshIndexScratch.subarray(0, totalI);
    const beakBoneIdx = ir.boneNameToIndex.get("beak");

    let vCursor = 0;
    let iCursor = 0;
    const numLanes = Math.max(1, laneCfg.lanes ?? 4);
    const carsPerLane = Math.max(1, Math.ceil(instances.length / numLanes));
    const laneSpacing = laneCfg.laneSpacing ?? 0.44;
    const wrapHalf = laneCfg.wrapHalfSpan ?? 0.94;
    const laneSpeeds = [0.46, 0.56, 0.54, 0.44];

    if (hasRoadbed) {
      const roadHalfX = numLanes * laneSpacing * 0.5 + 0.18;
      const roadHalfZ = wrapHalf + 0.18;
      appendFlatQuad(vData, iData, vCursor, iCursor, -roadHalfX, roadHalfX, -0.008, -roadHalfZ, roadHalfZ, 0.20, 0.22, 0.26);
      vCursor += 4;
      iCursor += 6;
      appendFlatQuad(vData, iData, vCursor, iCursor, -0.022, 0.022, -0.008, -roadHalfZ, roadHalfZ, 0.96, 0.76, 0.16);
      vCursor += 4;
      iCursor += 6;
    }

    for (let idx = 0; idx < instances.length; idx++) {
      const inst = instances[idx];
      const instSkinning = inst.skinning || skinning;
      const instIndices = inst.indices || baseMesh.indices;
      const instGroupTags = inst.groupTags || baseMesh.groupTags;
      const instVCount = inst.vertexCount ?? baseMesh.vertexCount;
      const instTCount = inst.triangleCount ?? baseMesh.triangleCount;
      const instHoodScale = Math.max(0.5, (inst.params?.hoodLen ?? this.paramValues.hoodLen ?? 0.25) / 0.25);
      const instCabinScale = Math.max(0.5, (inst.params?.cabinLen ?? this.paramValues.cabinLen ?? 0.14) / 0.14);

      const laneIdx = idx % numLanes;
      const slotInLane = Math.floor(idx / numLanes);
      // First half of lanes drive Southbound (+Z); second half drive Northbound (-Z)
      const laneDir = laneIdx < numLanes * 0.5 ? 1.0 : -1.0;
      const laneSpeed = laneSpeeds[laneIdx % laneSpeeds.length];
      const travelDist = isVehicle && !this.reducedMotion ? interpTime * laneSpeed : 0.0;

      const pose = evaluateProceduralRigPose(ir, interpTime, {
        phaseOffset: inst.phaseOffset,
        amplitude: this.reducedMotion ? 0.0 : 1.0,
        steer: isVehicle ? 0.0 : undefined,
        wheelSpin: isVehicle ? travelDist / (0.052 * 0.68) : undefined,
      });
      const skinned = evaluateSkinnedMesh(
        ir,
        {
          positions: inst.restPositions,
          normals: inst.restNormals,
          indices: instIndices,
          groupTags: instGroupTags,
          vertexCount: instVCount,
          triangleCount: instTCount,
        },
        instSkinning,
        pose
      );

      const effYaw = isVehicle ? (laneDir > 0 ? 0.0 : Math.PI) : inst.yaw;
      const cosY = Math.cos(effYaw);
      const sinY = Math.sin(effYaw);
      const ox = isVehicle ? (laneIdx - (numLanes - 1) * 0.5) * laneSpacing : inst.worldOffset[0];
      const oy = inst.worldOffset[1];
      let oz = inst.worldOffset[2];
      if (isVehicle) {
        const span = wrapHalf * 2.0;
        const baseZ = (slotInLane - (carsPerLane - 1) * 0.5) * (span / carsPerLane);
        const rawZ = baseZ + laneDir * travelDist;
        oz = rawZ - Math.floor((rawZ + wrapHalf) / span) * span;
      }
      const scale = isVehicle ? 0.68 : 0.62;
      const V = skinned.vertexCount;

      for (let v = 0; v < V; v++) {
        const lx = skinned.positions[v * 3] * scale;
        const ly = skinned.positions[v * 3 + 1] * scale;
        const lz = skinned.positions[v * 3 + 2] * scale;
        const px = cosY * lx + sinY * lz + ox;
        const py = ly + oy;
        const pz = -sinY * lx + cosY * lz + oz;

        const lnx = skinned.normals[v * 3];
        const lny = skinned.normals[v * 3 + 1];
        const lnz = skinned.normals[v * 3 + 2];
        const nx = cosY * lnx + sinY * lnz;
        const ny = lny;
        const nz = -sinY * lnx + cosY * lnz;

        const domBone = instSkinning.dominantBones?.[v] ?? 0;
        const gTag = skinned.groupTags?.[v] || "body";
        let r = 0.96 - inst.tint * 0.14;
        let g = 0.72 + (inst.tint - 0.5) * 0.22;
        let b = 0.15 + inst.tint * 0.25;
        let matId = MAT_STANDARD;
        let rough = 0.34;
        let metal = 0.0;
        let locX = 0.0, locY = 0.0, locZ = 0.0, scaleW = 1.0;

        if (this.debugMode === 2) {
          r = 0; g = 0; b = 0;
          for (let s = 0; s < 4; s++) {
            const w = (instSkinning.weights[v * 4 + s] || 0) / 255.0;
            const jb = (instSkinning.joints[v * 4 + s] || 0) % BONE_DEBUG_COLORS.length;
            const c = BONE_DEBUG_COLORS[jb];
            r += c[0] * w;
            g += c[1] * w;
            b += c[2] * w;
          }
        } else if (this.debugMode === 3) {
          const isSubIsland = gTag !== "body";
          r = isSubIsland ? 0.85 : 0.24 + inst.tint * 0.5;
          g = isSubIsland ? 0.42 : 0.52;
          b = isSubIsland ? 0.78 : 0.72 - inst.tint * 0.3;
        } else if (isVehicle) {
          const restX = inst.restPositions[v * 3];
          const restY = inst.restPositions[v * 3 + 1];
          const restZ = inst.restPositions[v * 3 + 2];
          if (gTag.startsWith("wheel")) {
            r = 0.20; g = 0.22; b = 0.25;
            matId = MAT_VEHICLE_WHEEL;
            rough = 0.76;
            locX = restX; locY = restY; locZ = restZ;
          } else if (gTag === "roofSign") {
            r = 1.0; g = 0.94; b = 0.62;
            rough = 0.18;
          } else {
            if (inst.tint < 0.14) {
              r = 0.94; g = 0.96; b = 0.98;
            } else if (inst.tint > 0.88) {
              r = 0.24; g = 0.68; b = 0.74;
            } else {
              const warmShift = (inst.tint - 0.5) * 0.08;
              r = 0.98; g = 0.78 + warmShift; b = 0.12;
            }
            matId = MAT_VEHICLE_BODY;
            rough = 0.22;
            locX = restX;
            locY = restY;
            locZ = restZ / instHoodScale;
            scaleW = instCabinScale / instHoodScale;
          }
        } else if (isBiped) {
          const restX = inst.restPositions[v * 3];
          const restY = inst.restPositions[v * 3 + 1];
          const restZ = inst.restPositions[v * 3 + 2];
          if (gTag === "pack") {
            r = 0.42; g = 0.26; b = 0.16;
            rough = 0.45;
          } else {
            r = 0.24 + (1.0 - inst.tint) * 0.54;
            g = 0.30 + Math.sin(inst.tint * Math.PI) * 0.26;
            b = 0.28 + inst.tint * 0.46;
            matId = MAT_BIPED_CITIZEN;
            rough = 0.68;
            locX = restX; locY = restY; locZ = restZ;
          }
        } else if (gTag.startsWith("eye")) {
          r = 0.04; g = 0.04; b = 0.05;
          matId = MAT_GLOSSY_EYE;
          rough = 0.03;
          locX = inst.restPositions[v * 3];
          locY = inst.restPositions[v * 3 + 1];
          locZ = inst.restPositions[v * 3 + 2];
        } else if (gTag === "beak" || domBone === beakBoneIdx) {
          r = 0.96; g = 0.46; b = 0.10;
          rough = 0.30;
        }

        const base = (vCursor + v) * MESH_VERTEX_FLOATS;
        vData[base] = px;
        vData[base + 1] = py;
        vData[base + 2] = pz;
        vData[base + 3] = matId;
        vData[base + 4] = nx;
        vData[base + 5] = ny;
        vData[base + 6] = nz;
        vData[base + 7] = rough;
        vData[base + 8] = r;
        vData[base + 9] = g;
        vData[base + 10] = b;
        vData[base + 11] = metal;
        vData[base + 12] = locX;
        vData[base + 13] = locY;
        vData[base + 14] = locZ;
        vData[base + 15] = scaleW;
      }

      for (let k = 0; k < instIndices.length; k++) {
        iData[iCursor + k] = instIndices[k] + vCursor;
      }
      vCursor += V;
      iCursor += instIndices.length;

      appendShadowDisc(vData, iData, vCursor, iCursor, ox, oy - 0.002, oz, 0.17, hasRoadbed);
      vCursor += 13;
      iCursor += 36;
    }

    this.device.queue.writeBuffer(this.meshVertexBuffer, 0, vData.buffer, vData.byteOffset, vData.byteLength);
    this.device.queue.writeBuffer(this.meshIndexBuffer, 0, iData.buffer, iData.byteOffset, iData.byteLength);
    this.meshIndexCount = totalI;
    this.gizmoIndexCount = 0;
  }

  setPaused(paused) {
    const wasPaused = this.paused;
    this.paused = Boolean(paused);
    if (this.device) {
      this.onStatus({
        state: this.paused ? "paused" : "running",
        message: this.paused ? "WebGPU · Paused" : "WebGPU · Live",
      });
    }
    if (this.paused && !wasPaused && this.running && this.device) {
      this._schedulePausedRender();
    }
  }

  triggerSpacePoke() {
    const now = performance.now();
    this.pointer.pokeHoldUntil = now + 110; // Hold poke active for 110ms so 60Hz sim always catches it
    this.pointer.spacePokeForSim = true;
    this._playSynthesizedSqueak("poke");
    if (this.paused) {
      this.stepDeterministically(1 / 30);
    }
  }

  playSqueak(kind = "squeeze") {
    this._playSynthesizedSqueak(kind);
  }

  // Synthesizes a playful rubber-duck squeak toy sound using dual resonant bandpass formants
  _playSynthesizedSqueak(kind = "squeeze") {
    if (!this.soundEnabled) return;
    try {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume();
      }
      const ctx = this.audioCtx;
      const now = ctx.currentTime;
      const duration = kind === "release" ? 0.14 : 0.16;

      const osc = ctx.createOscillator();
      const formant1 = ctx.createBiquadFilter();
      const formant2 = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = "sawtooth";
      if (kind === "release") {
        osc.frequency.setValueAtTime(620, now);
        osc.frequency.exponentialRampToValueAtTime(920, now + duration * 0.45);
        osc.frequency.exponentialRampToValueAtTime(480, now + duration);
      } else {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(840, now + 0.045);
        osc.frequency.exponentialRampToValueAtTime(590, now + duration);
      }

      formant1.type = "bandpass";
      formant1.frequency.setValueAtTime(1450, now);
      formant1.Q.setValueAtTime(4.5, now);

      formant2.type = "bandpass";
      formant2.frequency.setValueAtTime(2650, now);
      formant2.Q.setValueAtTime(5.5, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc.connect(formant1);
      osc.connect(formant2);
      formant1.connect(gain);
      formant2.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + duration);
    } catch {
      // Audio is optional
    }
  }

  _computeCameraBasis() {
    this._clampCameraElevation();
    const { target, distance, azimuth, elevation, fov } = this.camera;
    let effTarget = target;
    let effDist = distance;
    if (this.renderMode === "mesh" && this.bakedContext) {
      const isBiped = this.bakedContext.ir.boneNameToIndex.has("hips");
      const isVehicle = this.bakedContext.ir.rigTemplate === "vehicle4" || this.bakedContext.ir.boneNameToIndex.has("wheel.FL");
      effTarget = isBiped
        ? [target[0], 0.85, target[2]]
        : isVehicle
          ? [target[0], 0.16, target[2]]
          : [target[0], 0.25, target[2]];
      effDist = isBiped
        ? distance * 0.95
        : isVehicle
          ? 1.12
          : distance * 0.56;
    } else if (this.renderMode === "animate_compare" && this.bakedContext) {
      const isBiped = this.bakedContext.ir.boneNameToIndex.has("hips");
      const isVehicle = this.bakedContext.ir.rigTemplate === "vehicle4" || this.bakedContext.ir.boneNameToIndex.has("wheel.FL");
      effTarget = isBiped
        ? [target[0], 0.56, target[2]]
        : isVehicle
          ? [target[0], 0.14, target[2]]
          : [target[0], 0.24, target[2]];
      effDist = isBiped ? 2.55 : isVehicle ? 2.25 : 2.15;
    } else if (this.renderMode === "crowd" && this.bakedContext) {
      const isVehicle = this.bakedContext.ir.rigTemplate === "vehicle4" || this.bakedContext.ir.boneNameToIndex.has("wheel.FL");
      effTarget = isVehicle ? [target[0], 0.02, target[2]] : [target[0], 0.20, target[2]];
      effDist = isVehicle ? 2.82 : distance;
    }

    const cosEl = Math.cos(elevation);
    const sinEl = Math.sin(elevation);
    const sinAz = Math.sin(azimuth);
    const cosAz = Math.cos(azimuth);

    const pos = [
      effTarget[0] + effDist * cosEl * sinAz,
      effTarget[1] + effDist * sinEl,
      effTarget[2] + effDist * cosEl * cosAz,
    ];

    const forward = normalize3([effTarget[0] - pos[0], effTarget[1] - pos[1], effTarget[2] - pos[2]]);
    const worldUp = [0, 1, 0];
    const right = normalize3(cross3(forward, worldUp));
    const up = normalize3(cross3(right, forward));

    const aspect = (this.canvas.width || 640) / Math.max(1, this.canvas.height || 480);
    const tanHalfFov = Math.tan((fov * Math.PI) / 360);
    const pixelAngle = (2 * tanHalfFov) / Math.max(64, this.canvas.height || 480);

    // Pointer ray in world space
    const rx = this.pointer.ndcX * aspect * tanHalfFov;
    const ry = this.pointer.ndcY * tanHalfFov;
    const rayDir = normalize3([
      forward[0] + rx * right[0] + ry * up[0],
      forward[1] + rx * right[1] + ry * up[1],
      forward[2] + rx * right[2] + ry * up[2],
    ]);

    this._cachedCamBasis = { pos, target: effTarget, right, up, forward, aspect, tanHalfFov, pixelAngle, rayDir };
    return this._cachedCamBasis;
  }

  _writeUniformSlice(sliceIndex, { simTime, dt, metaY, tickCount, pointerFlags, allowGrab = true }) {
    const cam = this._cachedCamBasis || this._computeCameraBasis();
    const data = this._uniformScratch;
    const stepScale = this.scene?.stepScale ?? 0.85;
    const stateCount = this.compiled?.stateCount ?? 16;

    // Wrap simTime smoothly every 3600s so f32 trig never loses precision on multi-day sessions
    const wrappedTime = simTime % 3600;

    // camPos (xyz, time)
    data[0] = cam.pos[0];
    data[1] = cam.pos[1];
    data[2] = cam.pos[2];
    data[3] = wrappedTime;

    // camTarget (xyz, dt)
    data[4] = cam.target[0];
    data[5] = cam.target[1];
    data[6] = cam.target[2];
    data[7] = dt;

    // camRight (xyz, aspect)
    data[8] = cam.right[0];
    data[9] = cam.right[1];
    data[10] = cam.right[2];
    data[11] = cam.aspect;

    // camUp (xyz, tanHalfFov)
    data[12] = cam.up[0];
    data[13] = cam.up[1];
    data[14] = cam.up[2];
    data[15] = cam.tanHalfFov;

    // camForward (xyz, pixelAngle)
    data[16] = cam.forward[0];
    data[17] = cam.forward[1];
    data[18] = cam.forward[2];
    data[19] = cam.pixelAngle;

    // pointerRayOrigin (xyz, pointerDown) — suppress pointerDown during camera orbit/pinch
    const isInteractiveDown = allowGrab && this.pointer.down && this.pointer.mode !== "orbit" && this.pointer.mode !== "pinch";
    data[20] = cam.pos[0];
    data[21] = cam.pos[1];
    data[22] = cam.pos[2];
    data[23] = isInteractiveDown ? 1.0 : 0.0;

    // pointerRayDir (xyz, flags)
    data[24] = cam.rayDir[0];
    data[25] = cam.rayDir[1];
    data[26] = cam.rayDir[2];
    data[27] = pointerFlags;

    // simMeta (stepScale, substepOrDebugMode, tickCount, stateCount)
    data[28] = stepScale;
    data[29] = metaY;
    data[30] = tickCount % 1000000;
    data[31] = stateCount;

    // params (16 floats)
    const keys = this.compiled?.paramKeys || [];
    for (let i = 0; i < 16; i++) {
      data[32 + i] = i < keys.length ? (this.paramValues[keys[i]] ?? 1.0) : 0.0;
    }

    this.device.queue.writeBuffer(
      this.uniformBuffer,
      sliceIndex * UNIFORM_SLICE_ALIGN,
      data.buffer,
      data.byteOffset,
      UNIFORM_STRUCT_BYTES
    );
  }

  // Deterministic stepping for ?t=<seconds>&paused=1 verification
  async stepDeterministically(targetSeconds) {
    if (!this.device || !this.renderPipeline || !this.scene) return;
    this._computeCameraBasis();
    const fixedTick = 1 / 60;
    const totalTicks = Math.max(0, Math.min(1800, Math.round(targetSeconds / fixedTick)));
    const substeps = Math.max(1, Math.min(4, this.scene.substeps || 1));
    const subDt = fixedTick / substeps;

    const now = performance.now();
    const pokeActive = now < this.pointer.pokeHoldUntil || this.pointer.spacePokeForSim;

    let encoder = null;
    let pass = null;
    let sliceCursor = 1;
    const flushStepBatch = () => {
      if (pass && encoder) {
        pass.end();
        this.device.queue.submit([encoder.finish()]);
      }
      encoder = null;
      pass = null;
      sliceCursor = 1;
    };

    for (let tick = 0; tick < totalTicks; tick++) {
      if (tick === 0 && (pokeActive || this.pointer.down)) {
        encoder = this.device.createCommandEncoder();
        pass = encoder.beginComputePass();
        const pickFlags = (this.pointer.pressedForPick ? 1 : 0) | (pokeActive ? 4 : 0);
        this.pointer.pressedForPick = false;
        this._writeUniformSlice(0, {
          simTime: this.simTime,
          dt: fixedTick,
          metaY: 0,
          tickCount: this.tickCount,
          pointerFlags: pickFlags,
        });
        const pickBG = this.activeBufferIndex === 0 ? this.computeBindGroupAB : this.computeBindGroupBA;
        pass.setPipeline(this.pickPipeline);
        pass.setBindGroup(0, pickBG, [0]);
        pass.dispatchWorkgroups(1);
        flushStepBatch();
      }

      if (this.compiled.hasSimulate) {
        const workgroups = Math.ceil(this.compiled.stateCount / 64);
        for (let s = 0; s < substeps; s++) {
          if (!encoder) {
            encoder = this.device.createCommandEncoder();
            pass = encoder.beginComputePass();
            pass.setPipeline(this.simPipeline);
          }
          const sliceIndex = sliceCursor++;
          this._writeUniformSlice(sliceIndex, {
            simTime: this.simTime,
            dt: subDt,
            metaY: s,
            tickCount: this.tickCount,
            pointerFlags: tick === 0 && s === 0 && pokeActive ? 4 : 0,
          });
          const bg = this.activeBufferIndex === 0 ? this.computeBindGroupAB : this.computeBindGroupBA;
          pass.setBindGroup(0, bg, [sliceIndex * UNIFORM_SLICE_ALIGN]);
          pass.dispatchWorkgroups(workgroups);
          this.activeBufferIndex = 1 - this.activeBufferIndex;
          this.simTime += subDt;
          if (sliceCursor >= MAX_SUBSTEP_SLICES - 1) {
            flushStepBatch();
          }
        }
      } else {
        this.simTime += fixedTick;
      }
      this.tickCount++;
    }
    flushStepBatch();
    this.pointer.spacePokeForSim = false;
    if (this.canvas) this.canvas.dataset.stepPhase = "beforeRenderSingleFrame";
    await this.renderSingleFrame();
    if (this.canvas) this.canvas.dataset.stepPhase = "beforeWorkDone";
    await this.device.queue.onSubmittedWorkDone();
    if (this.canvas) this.canvas.dataset.stepPhase = "afterWorkDone";
  }

  // Synchronously records texture->buffer copy into encoder BEFORE queue.submit
  _recordOffscreenCopyIfNeeded(encoder) {
    if (!this.softwareBlit || !this.offscreenTexture || !this.offscreenReadBuffer) return false;
    const width = this.canvas.width;
    const height = this.canvas.height;
    encoder.copyTextureToBuffer(
      { texture: this.offscreenTexture },
      { buffer: this.offscreenReadBuffer, bytesPerRow: this.offscreenBytesPerRow, rowsPerImage: height },
      [width, height, 1]
    );
    return true;
  }

  // Maps offscreenReadBuffer ONLY AFTER queue.submit has been executed
  async _finishOffscreenBlit() {
    if (!this.softwareBlit || !this.offscreenReadBuffer) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    await this.offscreenReadBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(this.offscreenReadBuffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcStart = y * this.offscreenBytesPerRow;
      pixels.set(mapped.subarray(srcStart, srcStart + width * 4), y * width * 4);
    }
    this.offscreenReadBuffer.unmap();
    this.ctx2d.putImageData(new ImageData(pixels, width, height), 0, 0);
  }

  async renderSingleFrame() {
    if (this._singleFrameInFlight) {
      await this._singleFrameInFlight;
    }
    this._singleFrameInFlight = this._doRenderSingleFrame();
    try {
      await this._singleFrameInFlight;
    } finally {
      this._singleFrameInFlight = null;
    }
  }

  async _doRenderSingleFrame() {
    const canRender = this.renderPipeline || (this.renderMode === "custom_mesh" && this.meshPipeline);
    if (!this.device || !canRender || (!this.context && !this.softwareBlit)) return;
    if (this._blitPromise) {
      try {
        await this._blitPromise;
      } catch {}
    }
    this._configureCanvas();
    this._computeCameraBasis();
    this._writeUniformSlice(0, {
      simTime: this.simTime,
      dt: 1 / 60,
      metaY: this.debugMode,
      tickCount: this.tickCount,
      pointerFlags: 0,
    });

    const encoder = this.device.createCommandEncoder();
    const view = this.softwareBlit
      ? this.offscreenTexture.createView()
      : this.context.getCurrentTexture().createView();

    if (this.renderMode !== "raymarch" && (this.bakedContext || this.renderMode === "custom_mesh") && this.meshPipeline && this.depthTexture && this.msaaColorTexture) {
      this._updateModeBMeshBuffers(this.simTime);
      if (this.renderMode === "world") {
        this._computeCameraBasis();
        this._writeUniformSlice(0, {
          simTime: this.simTime,
          dt: 1 / 60,
          metaY: this.debugMode,
          tickCount: this.tickCount,
          pointerFlags: 0,
        });
      }
      const wc = this.renderMode === "world" && this.worldClearColor ? this.worldClearColor : [1.0, 0.831, 0.231];
      const rPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.msaaColorTexture.createView(),
            resolveTarget: view,
            clearValue: { r: wc[0], g: wc[1], b: wc[2], a: 1.0 },
            loadOp: "clear",
            storeOp: "discard",
          },
        ],
        depthStencilAttachment: {
          view: this.depthTexture.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "discard",
        },
      });
      if (this.meshIndexCount > 0) {
        const mainIndexCount = this.meshIndexCount - this.gizmoIndexCount;
        rPass.setPipeline(this.meshPipeline);
        rPass.setBindGroup(0, this.meshBindGroup, [0]);
        rPass.setVertexBuffer(0, this.meshVertexBuffer);
        rPass.setIndexBuffer(this.meshIndexBuffer, "uint32");
        if (mainIndexCount > 0) {
          rPass.drawIndexed(mainIndexCount);
        }
        if (this.gizmoIndexCount > 0 && this.gizmoOverlayPipeline) {
          rPass.setPipeline(this.gizmoOverlayPipeline);
          rPass.drawIndexed(this.gizmoIndexCount, 1, mainIndexCount);
        }
      }
      rPass.end();
    } else {
      const hasModeAGizmo = Boolean(this.gizmoNodeCenter && this.gizmoOverlayNoDepthPipeline && this._updateModeAGizmoBuffer());
      const rPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 1.0, g: 0.831, b: 0.231, a: 1.0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      rPass.setPipeline(this.renderPipeline);
      const renderBG = this.activeBufferIndex === 0 ? this.renderBindGroupA : this.renderBindGroupB;
      rPass.setBindGroup(0, renderBG, [0]);
      rPass.draw(3);
      if (hasModeAGizmo) {
        rPass.setPipeline(this.gizmoOverlayNoDepthPipeline);
        rPass.setBindGroup(0, this.meshBindGroup, [0]);
        rPass.setVertexBuffer(0, this.meshVertexBuffer);
        rPass.setIndexBuffer(this.meshIndexBuffer, "uint32");
        rPass.drawIndexed(24);
      }
      rPass.end();
    }

    const needsBlit = this._recordOffscreenCopyIfNeeded(encoder);
    if (this.canvas) this.canvas.dataset.renderPhase = "submitting";
    this.device.queue.submit([encoder.finish()]);
    if (this.canvas) this.canvas.dataset.renderPhase = "submitted";
    if (needsBlit) {
      this.blitPending = true;
      try {
        if (this.canvas) this.canvas.dataset.renderPhase = "mapping";
        await this._finishOffscreenBlit();
        if (this.canvas) this.canvas.dataset.renderPhase = "mapped";
      } finally {
        this.blitPending = false;
      }
    }
    if (this.canvas) this.canvas.dataset.renderPhase = "done";
  }

  _tickFrame(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame((t) => this._tickFrame(t));

    const canRender = this.renderPipeline || (this.renderMode === "custom_mesh" && this.meshPipeline);
    if (document.hidden || !this.inViewport || this.paused || !this.device || !canRender) return;
    if (this.softwareBlit && this.blitPending) return;

    const rawDt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 1 / 60;
    this.lastFrameTime = now;

    const frameMs = rawDt * 1000;
    if (frameMs > 0 && frameMs < 150) {
      this.frameTimeEMA = this.frameTimeEMA * 0.9 + frameMs * 0.1;
      this.onFps(Math.round(1000 / Math.max(1, this.frameTimeEMA)));
    }

    this._configureCanvas();
    this._computeCameraBasis();

    const fixedTick = 1 / 60;
    this.accumulator += Math.min(rawDt, 0.1);

    let ticksToRun = 0;
    while (this.accumulator >= fixedTick && ticksToRun < 2) {
      this.accumulator -= fixedTick;
      ticksToRun++;
    }
    if (ticksToRun === 2) {
      this.accumulator = 0;
    }

    const pokeActive = now < this.pointer.pokeHoldUntil;
    const allowGrab = this.pointer.mode !== "orbit" && this.pointer.mode !== "pinch";

    // Pick flags consumed by csPickMain this render frame
    const pickFlags =
      (allowGrab && this.pointer.pressedForPick ? 1 : 0) |
      (this.pointer.releasedForPick ? 2 : 0) |
      (pokeActive ? 4 : 0);
    this.pointer.pressedForPick = false;
    this.pointer.releasedForPick = false;

    const needPick = Boolean(
      this.pointer.dirty || this.pointer.down || pokeActive || pickFlags !== 0 || this.lastGrabActive
    );
    this.pointer.dirty = false;

    const encoder = this.device.createCommandEncoder();

    // Simulation substeps use Slices 1 .. sliceCursor-1
    const substeps = Math.max(1, Math.min(4, this.scene?.substeps || 1));
    const subDt = fixedTick / substeps;
    let sliceCursor = 1;
    const isInteracting = (allowGrab && this.pointer.down) || pokeActive || this.pointer.pressedForSim;
    const advanceSim = !this.reducedMotion || isInteracting;

    if (this.renderMode === "custom_mesh" || !this.pickPipeline) {
      if (ticksToRun > 0 && advanceSim) {
        this.simTime += ticksToRun * fixedTick;
        this.tickCount += ticksToRun;
      }
    } else if (needPick || (ticksToRun > 0 && advanceSim)) {
      const cPass = encoder.beginComputePass();

      if (needPick) {
        // Dedicated Slice 0 for csPickMain (uses real frameDt for frame-rate independent smoothing)
        this._writeUniformSlice(0, {
          simTime: this.simTime,
          dt: Math.min(rawDt, 0.05),
          metaY: 0,
          tickCount: this.tickCount,
          pointerFlags: pickFlags,
          allowGrab,
        });

        const pickBG = this.activeBufferIndex === 0 ? this.computeBindGroupAB : this.computeBindGroupBA;
        cPass.setPipeline(this.pickPipeline);
        cPass.setBindGroup(0, pickBG, [0]);
        cPass.dispatchWorkgroups(1);
      }

      if (ticksToRun > 0 && advanceSim) {
        const simFlags =
          (allowGrab && this.pointer.pressedForSim ? 1 : 0) |
          (this.pointer.releasedForSim ? 2 : 0) |
          (pokeActive || this.pointer.spacePokeForSim ? 4 : 0);
        this.pointer.pressedForSim = false;
        this.pointer.releasedForSim = false;
        this.pointer.spacePokeForSim = false;

        if (this.compiled?.hasSimulate) {
          const workgroups = Math.ceil(this.compiled.stateCount / 64);
          cPass.setPipeline(this.simPipeline);
          for (let t = 0; t < ticksToRun; t++) {
            for (let s = 0; s < substeps; s++) {
              if (sliceCursor >= MAX_SUBSTEP_SLICES - 1) break;
              this._writeUniformSlice(sliceCursor, {
                simTime: this.simTime,
                dt: subDt,
                metaY: s,
                tickCount: this.tickCount,
                pointerFlags: t === 0 && s === 0 ? simFlags : 0,
                allowGrab,
              });
              const simBG = this.activeBufferIndex === 0 ? this.computeBindGroupAB : this.computeBindGroupBA;
              cPass.setBindGroup(0, simBG, [sliceCursor * UNIFORM_SLICE_ALIGN]);
              cPass.dispatchWorkgroups(workgroups);
              this.activeBufferIndex = 1 - this.activeBufferIndex;
              this.simTime += subDt;
              sliceCursor++;
            }
            this.tickCount++;
          }
        } else {
          this.simTime += ticksToRun * fixedTick;
          this.tickCount += ticksToRun;
        }
      }

      cPass.end();
    }

    // Dedicated Render Slice at sliceCursor so Slice 0 is never clobbered.
    // Smoothly interpolate visual time on high-refresh-rate displays (120/144Hz).
    const renderSlice = sliceCursor;
    const interpTime = advanceSim ? this.simTime + this.accumulator : this.simTime;
    this._writeUniformSlice(renderSlice, {
      simTime: interpTime,
      dt: fixedTick,
      metaY: this.debugMode,
      tickCount: this.tickCount,
      pointerFlags: 0,
      allowGrab,
    });

    const shouldCopyPick = this.renderMode !== "custom_mesh" && Boolean(this.pickPipeline) && needPick && !this.readbackPending;
    if (shouldCopyPick) {
      encoder.copyBufferToBuffer(this.pickBuffer, 0, this.pickReadbackBuffer, 0, PICK_BUFFER_BYTES);
    }

    // Fullscreen SDF or Mode B Skinned Mesh Render Pass
    const view = this.softwareBlit
      ? this.offscreenTexture.createView()
      : this.context.getCurrentTexture().createView();
    if (this.renderMode !== "raymarch" && (this.bakedContext || this.renderMode === "custom_mesh") && this.meshPipeline && this.depthTexture && this.msaaColorTexture) {
      this._updateModeBMeshBuffers(interpTime);
      if (this.renderMode === "world") {
        this._computeCameraBasis();
        this._writeUniformSlice(renderSlice, {
          simTime: interpTime,
          dt: fixedTick,
          metaY: this.debugMode,
          tickCount: this.tickCount,
          pointerFlags: 0,
          allowGrab,
        });
      }
      const wc = this.renderMode === "world" && this.worldClearColor ? this.worldClearColor : [1.0, 0.831, 0.231];
      const rPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.msaaColorTexture.createView(),
            resolveTarget: view,
            clearValue: { r: wc[0], g: wc[1], b: wc[2], a: 1.0 },
            loadOp: "clear",
            storeOp: "discard",
          },
        ],
        depthStencilAttachment: {
          view: this.depthTexture.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "discard",
        },
      });
      if (this.meshIndexCount > 0) {
        const mainIndexCount = this.meshIndexCount - this.gizmoIndexCount;
        rPass.setPipeline(this.meshPipeline);
        rPass.setBindGroup(0, this.meshBindGroup, [renderSlice * UNIFORM_SLICE_ALIGN]);
        rPass.setVertexBuffer(0, this.meshVertexBuffer);
        rPass.setIndexBuffer(this.meshIndexBuffer, "uint32");
        if (mainIndexCount > 0) {
          rPass.drawIndexed(mainIndexCount);
        }
        if (this.gizmoIndexCount > 0 && this.gizmoOverlayPipeline) {
          rPass.setPipeline(this.gizmoOverlayPipeline);
          rPass.drawIndexed(this.gizmoIndexCount, 1, mainIndexCount);
        }
      }
      rPass.end();
    } else {
      const hasModeAGizmo = Boolean(this.gizmoNodeCenter && this.gizmoOverlayNoDepthPipeline && this._updateModeAGizmoBuffer());
      const rPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 1.0, g: 0.831, b: 0.231, a: 1.0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      rPass.setPipeline(this.renderPipeline);
      const renderBG = this.activeBufferIndex === 0 ? this.renderBindGroupA : this.renderBindGroupB;
      rPass.setBindGroup(0, renderBG, [renderSlice * UNIFORM_SLICE_ALIGN]);
      rPass.draw(3);
      if (hasModeAGizmo) {
        rPass.setPipeline(this.gizmoOverlayNoDepthPipeline);
        rPass.setBindGroup(0, this.meshBindGroup, [renderSlice * UNIFORM_SLICE_ALIGN]);
        rPass.setVertexBuffer(0, this.meshVertexBuffer);
        rPass.setIndexBuffer(this.meshIndexBuffer, "uint32");
        rPass.drawIndexed(24);
      }
      rPass.end();
    }

    const needsBlit = this._recordOffscreenCopyIfNeeded(encoder);

    // CRITICAL: Submit command buffer synchronously BEFORE calling mapAsync on any readback buffer!
    this.device.queue.submit([encoder.finish()]);

    // Promote trial shader to lastGoodScene after 45 clean frames
    if (this.trialFramesRemaining > 0) {
      this.trialFramesRemaining--;
      if (this.trialFramesRemaining === 0 && this.scene) {
        this.lastGoodScene = this.scene;
        this.consecutiveLosses = 0;
      }
    }

    if (needsBlit) {
      this.blitPending = true;
      this._blitPromise = this._finishOffscreenBlit()
        .catch(() => {})
        .finally(() => {
          this.blitPending = false;
          this._blitPromise = null;
        });
    }

    if (shouldCopyPick) {
      this.readbackPending = true;
      this.pickReadbackBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const arr = new Float32Array(this.pickReadbackBuffer.getMappedRange());
          const prevGrab = this.lastGrabActive;
          this.lastGrabActive = arr[3] > 0.5;
          this.lastHoverHit = arr[11] > 0.5;
          if (prevGrab !== this.lastGrabActive) {
            this.onGrabChange(this.lastGrabActive);
            if (this.lastGrabActive) {
              this._playSynthesizedSqueak("squeeze");
            } else {
              this._playSynthesizedSqueak("release");
            }
          }
          if (this.pointer.down && this.pointer.mode === "pending") {
            this.pointer.mode = this.lastGrabActive ? "grab" : "orbit";
          }
          if (this.pointer.down && this.pointer.mode === "grab") {
            this.canvas.style.cursor = "grabbing";
          } else if (!this.pointer.down) {
            this.canvas.style.cursor = this.lastHoverHit ? "grab" : "default";
          }
          this.pickReadbackBuffer.unmap();
          this.readbackPending = false;
        })
        .catch(() => {
          this.readbackPending = false;
        });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = 0;
    this.rafId = requestAnimationFrame((t) => this._tickFrame(t));
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  _bindEvents() {
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        this._measureCanvasRect();
        if (this.paused) this._schedulePausedRender();
      });
      ro.observe(this.canvas);
    }

    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          this.inViewport = entry.isIntersecting;
        }
      });
      io.observe(this.canvas);
    }

    const updateNDC = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
      this.pointer.ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
      this.pointer.dirty = true;
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      try {
        this.canvas.focus({ preventScroll: true });
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic events without active pointerId
      }
      this.pointer.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointer.activePointers.size >= 2) {
        // Transition cleanly to two-finger pinch/orbit: release any single-finger grab
        if (this.pointer.down) {
          this.pointer.down = false;
          this.pointer.releasedForPick = true;
          this.pointer.releasedForSim = true;
        }
        const pts = [...this.pointer.activePointers.values()];
        this.pointer.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.pointer.pinchMidX = (pts[0].x + pts[1].x) * 0.5;
        this.pointer.pinchMidY = (pts[0].y + pts[1].y) * 0.5;
        this.pointer.mode = "pinch";
        return;
      }

      updateNDC(e.clientX, e.clientY);
      this.pointer.lastX = e.clientX;
      this.pointer.lastY = e.clientY;
      if (e.shiftKey) {
        this.pointer.down = false;
        this.pointer.mode = "orbit";
        return;
      }

      // Check if pointer ray hits the 3D Gizmo octahedron in Mode A, Mode B, or custom_mesh editor mode
      if (
        (this.renderMode === "mesh" || this.renderMode === "raymarch" || this.renderMode === "custom_mesh") &&
        this.gizmoNodeCenter &&
        this.onGizmoNodeDrag
      ) {
        const cam = this._computeCameraBasis();
        const toCenter = [
          this.gizmoNodeCenter[0] - cam.pos[0],
          this.gizmoNodeCenter[1] - cam.pos[1],
          this.gizmoNodeCenter[2] - cam.pos[2],
        ];
        const proj =
          toCenter[0] * cam.rayDir[0] +
          toCenter[1] * cam.rayDir[1] +
          toCenter[2] * cam.rayDir[2];
        const closest = [
          cam.pos[0] + cam.rayDir[0] * proj - this.gizmoNodeCenter[0],
          cam.pos[1] + cam.rayDir[1] * proj - this.gizmoNodeCenter[1],
          cam.pos[2] + cam.rayDir[2] * proj - this.gizmoNodeCenter[2],
        ];
        const rayDist = Math.hypot(closest[0], closest[1], closest[2]);
        if (proj > 0 && rayDist < 0.095) {
          this.pointer.down = false;
          this.pointer.mode = "gizmo";
          this.canvas.style.cursor = "move";
          return;
        }
      }

      if (this.renderMode !== "raymarch") {
        this.pointer.down = false;
        this.pointer.mode = "orbit";
      } else {
        this.pointer.down = true;
        this.pointer.pressedForPick = true;
        this.pointer.pressedForSim = true;
        this.pointer.mode = this.lastHoverHit ? "grab" : "pending";
      }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (this.pointer.activePointers.has(e.pointerId)) {
        this.pointer.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.pointer.activePointers.size >= 2) {
        const pts = [...this.pointer.activePointers.values()];
        const nextDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const midX = (pts[0].x + pts[1].x) * 0.5;
        const midY = (pts[0].y + pts[1].y) * 0.5;
        if (this.pointer.pinchDist > 8 && nextDist > 8) {
          const ratio = this.pointer.pinchDist / nextDist;
          this.camera.distance = Math.max(1.4, Math.min(5.5, this.camera.distance * ratio));
        }
        const dx = midX - this.pointer.pinchMidX;
        const dy = midY - this.pointer.pinchMidY;
        this.camera.azimuth -= dx * 0.006;
        this.camera.elevation += dy * 0.005;
        this._clampCameraElevation();
        this.pointer.pinchDist = nextDist;
        this.pointer.pinchMidX = midX;
        this.pointer.pinchMidY = midY;
        if (this.paused) this._schedulePausedRender();
        return;
      }

      updateNDC(e.clientX, e.clientY);
      if (!this.pointer.down && this.pointer.mode !== "orbit" && this.pointer.mode !== "gizmo") {
        this.canvas.style.cursor = this.lastHoverHit ? "grab" : "default";
        return;
      }
      const dx = e.clientX - this.pointer.lastX;
      const dy = e.clientY - this.pointer.lastY;
      this.pointer.lastX = e.clientX;
      this.pointer.lastY = e.clientY;

      if (this.pointer.mode === "gizmo" && this.gizmoNodeCenter && this.onGizmoNodeDrag) {
        const cam = this._cachedCamBasis || this._computeCameraBasis();
        const dist = Math.hypot(
          this.gizmoNodeCenter[0] - cam.pos[0],
          this.gizmoNodeCenter[1] - cam.pos[1],
          this.gizmoNodeCenter[2] - cam.pos[2]
        );
        const worldPerPixel = (2.0 * dist * cam.tanHalfFov) / Math.max(120, this.cssHeight);
        const moveRight = dx * worldPerPixel;
        const moveUp = -dy * worldPerPixel;
        const deltaWorld = [
          cam.right[0] * moveRight + cam.up[0] * moveUp,
          cam.right[1] * moveRight + cam.up[1] * moveUp,
          cam.right[2] * moveRight + cam.up[2] * moveUp,
        ];
        this.onGizmoNodeDrag(deltaWorld);
        if (this.paused) this._schedulePausedRender();
      } else if (this.pointer.mode === "orbit") {
        this.camera.azimuth -= dx * 0.0075;
        this.camera.elevation += dy * 0.0065;
        this._clampCameraElevation();
        if (this.paused) this._schedulePausedRender();
      } else {
        this.canvas.style.cursor = "grabbing";
        if (this.paused) this._schedulePausedRender();
      }
    });

    const releasePointer = (e) => {
      this.pointer.activePointers.delete(e.pointerId);
      if (this.pointer.activePointers.size === 1 && this.pointer.mode === "pinch") {
        // Remaining single finger smoothly transitions to orbit without jumping
        const remaining = [...this.pointer.activePointers.values()][0];
        this.pointer.lastX = remaining.x;
        this.pointer.lastY = remaining.y;
        this.pointer.mode = "orbit";
        return;
      }
      if (this.pointer.activePointers.size === 0) {
        const wasGizmo = this.pointer.mode === "gizmo";
        if (this.pointer.down) {
          this.pointer.down = false;
          this.pointer.releasedForPick = true;
          this.pointer.releasedForSim = true;
        }
        this.pointer.mode = "idle";
        this.canvas.style.cursor = this.lastHoverHit ? "grab" : "default";
        if (wasGizmo) {
          this.onGizmoNodeDragEnd?.();
        }
      }
    };

    this.canvas.addEventListener("pointerup", releasePointer);
    this.canvas.addEventListener("pointercancel", releasePointer);

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
        this.camera.distance = Math.max(1.4, Math.min(5.5, this.camera.distance * Math.exp(delta * 0.0011)));
        this._clampCameraElevation();
        if (this.paused) this._schedulePausedRender();
      },
      { passive: false }
    );

    this.canvas.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.camera.azimuth += 0.1;
        if (this.paused) this._schedulePausedRender();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.camera.azimuth -= 0.1;
        if (this.paused) this._schedulePausedRender();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.camera.elevation += 0.08;
        this._clampCameraElevation();
        if (this.paused) this._schedulePausedRender();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.camera.elevation -= 0.08;
        this._clampCameraElevation();
        if (this.paused) this._schedulePausedRender();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        this.camera.distance = Math.max(1.4, this.camera.distance * 0.92);
        this._clampCameraElevation();
        if (this.paused) this._schedulePausedRender();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        this.camera.distance = Math.min(5.5, this.camera.distance * 1.08);
        this._clampCameraElevation();
        if (this.paused) this._schedulePausedRender();
      } else if (e.key === " ") {
        e.preventDefault();
        this.triggerSpacePoke();
      }
    });
  }
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// Appends a 12-segment ground contact shadow disc (13 vertices, 36 indices).
// Uses formal materialId = MAT_SHADOW_DISC (6.0) and radial UV in normalAndRough.xz.
function appendShadowDisc(vData, iData, vOffset, iOffset, cx, cy, cz, radius, onAsphalt = false) {
  const groundR = onAsphalt ? 0.20 : 1.0;
  const groundG = onAsphalt ? 0.22 : 212.0 / 255.0;
  const groundB = onAsphalt ? 0.26 : 59.0 / 255.0;
  const centerBase = vOffset * MESH_VERTEX_FLOATS;
  vData[centerBase] = cx;
  vData[centerBase + 1] = cy;
  vData[centerBase + 2] = cz;
  vData[centerBase + 3] = MAT_SHADOW_DISC;
  vData[centerBase + 4] = 0.0;
  vData[centerBase + 5] = 1.0;
  vData[centerBase + 6] = 0.0;
  vData[centerBase + 7] = 1.0;
  vData[centerBase + 8] = groundR;
  vData[centerBase + 9] = groundG;
  vData[centerBase + 10] = groundB;
  vData[centerBase + 11] = 0.0;
  vData[centerBase + 12] = 0.0;
  vData[centerBase + 13] = 0.0;
  vData[centerBase + 14] = 0.0;
  vData[centerBase + 15] = 1.0;

  const segments = 12;
  for (let s = 0; s < segments; s++) {
    const theta = (s / segments) * Math.PI * 2.0;
    const ux = Math.cos(theta);
    const uz = Math.sin(theta);
    const vx = cx + ux * radius;
    const vz = cz + uz * radius * 0.88;
    const base = (vOffset + 1 + s) * MESH_VERTEX_FLOATS;
    vData[base] = vx;
    vData[base + 1] = cy;
    vData[base + 2] = vz;
    vData[base + 3] = MAT_SHADOW_DISC;
    vData[base + 4] = ux;
    vData[base + 5] = 1.0;
    vData[base + 6] = uz;
    vData[base + 7] = 1.0;
    vData[base + 8] = groundR;
    vData[base + 9] = groundG;
    vData[base + 10] = groundB;
    vData[base + 11] = 0.0;
    vData[base + 12] = 0.0;
    vData[base + 13] = 0.0;
    vData[base + 14] = 0.0;
    vData[base + 15] = 1.0;

    const next = ((s + 1) % segments) + 1;
    const idxBase = iOffset + s * 3;
    iData[idxBase] = vOffset;
    iData[idxBase + 1] = vOffset + next;
    iData[idxBase + 2] = vOffset + 1 + s;
  }
}

// Appends a 3D Gizmo octahedron marker (6 vertices, 24 indices) in Focus Blue (#004E89) using MAT_UNLIT_GIZMO (5.0).
function appendGizmoOctahedron(vData, iData, vOffset, iOffset, cx, cy, cz, radius) {
  const pts = [
    [cx + radius, cy, cz],
    [cx - radius, cy, cz],
    [cx, cy + radius, cz],
    [cx, cy - radius, cz],
    [cx, cy, cz + radius],
    [cx, cy, cz - radius],
  ];
  for (let i = 0; i < 6; i++) {
    const base = (vOffset + i) * MESH_VERTEX_FLOATS;
    vData[base] = pts[i][0];
    vData[base + 1] = pts[i][1];
    vData[base + 2] = pts[i][2];
    vData[base + 3] = MAT_UNLIT_GIZMO;
    vData[base + 4] = 0.0;
    vData[base + 5] = 1.0;
    vData[base + 6] = 0.0;
    vData[base + 7] = 0.5;
    vData[base + 8] = 0.0;
    vData[base + 9] = 0.42;
    vData[base + 10] = 0.78;
    vData[base + 11] = 0.0;
    vData[base + 12] = 0.0;
    vData[base + 13] = 0.0;
    vData[base + 14] = 0.0;
    vData[base + 15] = 1.0;
  }
  const faces = [
    [0, 2, 4],
    [4, 2, 1],
    [1, 2, 5],
    [5, 2, 0],
    [4, 3, 0],
    [1, 3, 4],
    [5, 3, 1],
    [0, 3, 5],
  ];
  for (let f = 0; f < 8; f++) {
    iData[iOffset + f * 3] = vOffset + faces[f][0];
    iData[iOffset + f * 3 + 1] = vOffset + faces[f][1];
    iData[iOffset + f * 3 + 2] = vOffset + faces[f][2];
  }
}

function appendFlatQuad(vData, iData, vOffset, iOffset, xMin, xMax, y, zMin, zMax, r, g, b) {
  const pts = [
    [xMin, y, zMin],
    [xMax, y, zMin],
    [xMax, y, zMax],
    [xMin, y, zMax],
  ];
  for (let k = 0; k < 4; k++) {
    const base = (vOffset + k) * MESH_VERTEX_FLOATS;
    vData[base] = pts[k][0];
    vData[base + 1] = pts[k][1];
    vData[base + 2] = pts[k][2];
    vData[base + 3] = MAT_ROADBED;
    vData[base + 4] = 0.0;
    vData[base + 5] = 1.0;
    vData[base + 6] = 0.0;
    vData[base + 7] = 0.85;
    vData[base + 8] = r;
    vData[base + 9] = g;
    vData[base + 10] = b;
    vData[base + 11] = 0.0;
    vData[base + 12] = 0.0;
    vData[base + 13] = 0.0;
    vData[base + 14] = 0.0;
    vData[base + 15] = 1.0;
  }
  iData[iOffset] = vOffset;
  iData[iOffset + 1] = vOffset + 2;
  iData[iOffset + 2] = vOffset + 1;
  iData[iOffset + 3] = vOffset;
  iData[iOffset + 4] = vOffset + 3;
  iData[iOffset + 5] = vOffset + 2;
}
