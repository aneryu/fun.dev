import { buildSceneShaders, formatCompilationDiagnostics, MESH_RENDER_WGSL } from "./compiler.js";

const UNIFORM_STRUCT_BYTES = 192; // 48 floats (12 vec4f)
const UNIFORM_SLICE_ALIGN = 256;  // WebGPU minUniformBufferOffsetAlignment
const MAX_SUBSTEP_SLICES = 20;    // Slice 0 = pick, Slices 1..18 = sim substeps, last slice = render
const PICK_BUFFER_BYTES = 48;     // 3 vec4f (hitPos, targetPos, impulse)
const MESH_VERTEX_FLOATS = 16;    // 4 x vec4f (posAndMat, normalAndRough, colorAndMetal, localAndScale)
const MESH_VERTEX_STRIDE = 64;    // 16 * 4 bytes

const MAT_UNLIT_GIZMO = 5.0;

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

    // "raymarch" draws the scene's WGSL SDF (the homepage); "custom_mesh" draws the vertex stream
    // the Studio uploads through onUpdateCustomMesh, plus the 3D gizmo.
    this.renderMode = "raymarch";
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
    this.renderMode = mode === "custom_mesh" ? mode : "raymarch";
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

  _updateCustomMesh(interpTime) {
    if (this.onUpdateCustomMesh) {
      this.onUpdateCustomMesh(this, interpTime);
    }
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
    if (this.paused) {
      this.stepDeterministically(1 / 30);
    }
  }

  _computeCameraBasis() {
    this._clampCameraElevation();
    const { target, distance, azimuth, elevation, fov } = this.camera;
    const effTarget = target;
    const effDist = distance;

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

    if (this.renderMode === "custom_mesh" && this.meshPipeline && this.depthTexture && this.msaaColorTexture) {
      this._updateCustomMesh(this.simTime);
      const wc = [1.0, 0.831, 0.231];
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

    // Fullscreen SDF raymarch or the Studio mesh render pass
    const view = this.softwareBlit
      ? this.offscreenTexture.createView()
      : this.context.getCurrentTexture().createView();
    if (this.renderMode === "custom_mesh" && this.meshPipeline && this.depthTexture && this.msaaColorTexture) {
      this._updateCustomMesh(interpTime);
      const wc = [1.0, 0.831, 0.231];
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

      // Check if the pointer ray hits the 3D gizmo octahedron
      if (
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
