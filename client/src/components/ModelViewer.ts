import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { Sparkles, CameraShake } from '@pmndrs/vanilla';

/**
 * ModelViewer Web Component - Enhanced Three.js
 *
 * Features:
 * - OrbitControls for smooth camera interaction
 * - GLB animation support
 * - Sparkle effects
 */
export class ModelViewer extends HTMLElement implements HTMLElement {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private model: THREE.Group | null = null;
  private isLoading = false;
  private orbitControls: OrbitControls | null = null;
  private ambientLight!: THREE.AmbientLight;
  private directionalLight!: THREE.DirectionalLight;
  private animationId: number = 0;
  private resizeObserver: ResizeObserver | null = null;

  // Drei-vanilla effects
  private sparkles: any = null;
  private cameraShake: CameraShake | null = null;

  // Head bone for camera tracking
  private headBone: THREE.Object3D | null = null;

  // Morph targets for facial animation
  private morphMeshes: THREE.Mesh[] = [];
  private morphTime = 0;

  // FlowB screen/face state
  private screenState = {
    isShowingContent: false,
    showContentTarget: 0,
    showContentCurrent: 0,
    blinkTimer: 0,
    nextBlinkTime: 2 + Math.random() * 3,
    isBlinking: false,
    blinkDuration: 0.15,
    blinkStartTime: 0,
    screenContent: '',
    // Animation state for reveal/hide
    contentAnimState: 'hidden' as 'hidden' | 'revealing' | 'visible' | 'hiding',
    contentAnimProgress: 0,
    contentAnimSpeed: 4, // Animation speed multiplier
  };

  // 3D content planes
  private emissivePlane: THREE.Mesh | null = null;
  private contentPlane: THREE.Mesh | null = null;
  private contentBorder: THREE.Mesh | null = null;
  private contentReference: THREE.Object3D | null = null;
  private screenMesh: THREE.Mesh | null = null; // New mesh reference for screen

  // CSS3D for HTML content display
  private css3dRenderer: CSS3DRenderer | null = null;
  private css3dContent: CSS3DObject | null = null;

  // Notification ring for UV animation
  private notificationRing: THREE.Mesh | null = null;
  private ringUVOffset: number = 0;
  private ringUVSpeed: number = 0.005; // Slower, more subtle animation

  // Animation state
  private animationMixer: THREE.AnimationMixer | null = null;
  private currentAnimation: THREE.AnimationAction | null = null;
  private animationClips: Map<string, THREE.AnimationClip> = new Map();
  private isAnimationLoaded = false;

  // Animation state - FlowB plays Idle on loop
  private animationState = {
    isPlaying: false,
    idleClipName: 'Idle',
  };

  static get observedAttributes() {
    return ['model-url', 'environment', 'animation'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.initThreeJS();
    this.loadModel();
    this.animationLoop();
  }

  disconnectedCallback() {
    this.lastFrameTime = 0;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.orbitControls) {
      this.orbitControls.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    if (this.sparkles) {
      this.sparkles.geometry.dispose();
      (this.sparkles.material as THREE.Material).dispose();
    }
    if (this.animationMixer) {
      this.animationMixer.removeEventListener('finished', this.onAnimationFinished);
      this.animationMixer.stopAllAction();
    }
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (oldValue === newValue) return;

    if (name === 'model-url') {
      this.loadModel();
    } else if (name === 'environment') {
      this.updateEnvironment(newValue || 'studio');
    } else if (name === 'animation') {
      this.playAnimation(newValue);
    }
  }

  private render() {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }
      #container {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        position: relative;
      }
      #canvas-container {
        flex: 1;
        width: 100%;
        position: relative;
        overflow: hidden;
        pointer-events: auto;
      }

      #canvas-container canvas {
        pointer-events: auto;
      }
      #loading {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        text-align: center;
        z-index: 10;
        font-family: 'Poppins', sans-serif;
      }
      .spinner {
        width: 48px;
        height: 48px;
        border: 4px solid #2a2a2a;
        border-top-color: #00ffff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin: 0 auto 1rem;
      }
      .loading-text {
        color: #00ffff;
        font-weight: 600;
        font-size: 1.125rem;
      }
      .error-text {
        color: #dc2626;
        font-weight: 600;
        font-size: 1rem;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
    shadowRoot.appendChild(style);

    const container = document.createElement('div');
    container.id = 'container';

    const canvasContainer = document.createElement('div');
    canvasContainer.id = 'canvas-container';

    const loading = document.createElement('div');
    loading.id = 'loading';
    loading.innerHTML = `
      <div class="spinner"></div>
      <div class="loading-text">Loading FlowB...</div>
    `;

    canvasContainer.appendChild(loading);
    container.appendChild(canvasContainer);
    shadowRoot.appendChild(container);
  }

  private initThreeJS() {
    const container = this.shadowRoot?.getElementById('canvas-container');
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene setup - transparent to show CSS gradient behind
    this.scene = new THREE.Scene();
    this.scene.background = null;
    // Add subtle fog for depth
    this.scene.fog = new THREE.FogExp2(0x0a0a0a, 0.02);

    // Camera setup - focused on robot's face/screen for close-up view
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    // Position closer and higher to focus on the screen face
    this.camera.position.set(0, 0.8, 2.2);

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    // CSS3D Renderer for HTML content
    this.css3dRenderer = new CSS3DRenderer();
    this.css3dRenderer.setSize(width, height);
    this.css3dRenderer.domElement.style.position = 'absolute';
    this.css3dRenderer.domElement.style.top = '0';
    this.css3dRenderer.domElement.style.left = '0';
    this.css3dRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.css3dRenderer.domElement);

    // OrbitControls - enable full 360-degree orbit for debugging
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.05;
    this.orbitControls.minDistance = 0.5;
    this.orbitControls.maxDistance = 5;
    this.orbitControls.target.set(0, 0.8, 0);
    this.orbitControls.enableRotate = true;
    this.orbitControls.rotateSpeed = 1.0;

    // Environment and lighting
    this.setupEnvironment();

    // Handle window resize with ResizeObserver
    this.resizeObserver = new ResizeObserver(() => {
      this.onWindowResize();
    });
    this.resizeObserver.observe(container);

    // Initial resize
    this.onWindowResize();
  }

  private setupEnvironment() {
    // Ambient light
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.ambientLight);

    // Main directional light (sun)
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.directionalLight.position.set(5, 10, 7);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 2048;
    this.directionalLight.shadow.mapSize.height = 2048;
    this.directionalLight.shadow.camera.near = 0.1;
    this.directionalLight.shadow.camera.far = 20;
    this.directionalLight.shadow.bias = -0.001;
    this.scene.add(this.directionalLight);

    // Fill light
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-5, 5, -5);
    this.scene.add(fillLight);

    // Rim light
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.2);
    rimLight.position.set(0, 5, -8);
    this.scene.add(rimLight);

    // Grid helper
    const gridHelper = new THREE.GridHelper(20, 20, 0x00ffff, 0x0088ff);
    gridHelper.position.y = 0;
    this.scene.add(gridHelper);

    // Add drei-vanilla effects
    this.setupDreiEffects();
  }

  private setupDreiEffects() {
    // Sparkles - magical particles around the avatar
    this.sparkles = new Sparkles({
      count: 100,
      scale: 3,
      color: new THREE.Color('#ffff00'),
      speed: 0.1,
      opacity: 0.1,
      size: 0.69,
    });
    this.sparkles.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.add(this.sparkles);

    // Camera shake disabled for debugging positioning
    // this.cameraShake = new CameraShake(this.camera);
    // this.cameraShake.maxYaw = 0.01;
    // this.cameraShake.maxPitch = 0.01;
    // this.cameraShake.maxRoll = 0.01;
    // this.cameraShake.yawFrequency = 0.1;
    // this.cameraShake.pitchFrequency = 0.1;
    // this.cameraShake.rollFrequency = 0.1;
  }

  private updateEnvironment(preset: string) {
    const lightIntensity: Record<string, number> = {
      studio: 1.2,
      sunset: 1.0,
      dawn: 1.1,
      night: 0.6,
      forest: 0.95,
      city: 1.1,
    };

    if (this.directionalLight) {
      this.directionalLight.intensity = lightIntensity[preset] || 1.2;
    }
  }

  private onWindowResize() {
    const container = this.shadowRoot?.getElementById('canvas-container');
    if (!container || !this.renderer || !this.camera) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Only update aspect ratio and renderer size
    // DO NOT reset camera position - let OrbitControls manage that
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);

    // Update CSS3D renderer size
    if (this.css3dRenderer) {
      this.css3dRenderer.setSize(width, height);
    }

    // Adjust FOV based on device type without resetting camera position
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isPortrait = width < height;
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

    if (this.model) {
      if (isMobile || isTouchDevice || (isPortrait && width < 768)) {
        // Mobile/tablet portrait view - closer to see face/screen details
        this.camera.fov = 55;
        this.camera.position.set(0, 0.8, 5.5); // Centered, focused on upper body/screen
      } else if (isPortrait) {
        // Desktop portrait (tall window) - face focus
        this.camera.fov = 48;
        this.camera.position.set(0, 0.3, 2.3);
      } else {
        // Desktop landscape - face focus, slight offset for text panel
        this.camera.fov = 45;
        this.camera.position.set(0.2, 0.3, 1.8);
      }
      this.camera.updateProjectionMatrix();
    }
  }

  private async loadModel() {
    this.isLoading = true;
    const loadingDiv = this.shadowRoot?.getElementById('loading');
    if (loadingDiv) {
      loadingDiv.style.display = 'block';
      loadingDiv.innerHTML = `
        <div class="spinner"></div>
        <div class="loading-text">Loading FlowB...</div>
      `;
    }

    try {
      const loader = new GLTFLoader();
      // Use relative path for GitHub Pages compatibility
      const modelPath = import.meta.env.BASE_URL ? `${import.meta.env.BASE_URL}FlowB.glb` : 'FlowB.glb';
      const gltf = await loader.loadAsync(modelPath);

      // Store animations from the GLB
      if (gltf.animations && gltf.animations.length > 0) {
        for (const clip of gltf.animations) {
          this.animationClips.set(clip.name, clip);
        }
        this.isAnimationLoaded = true;
      }

      // Remove old model if exists
      if (this.model) {
        this.scene.remove(this.model);
        this.model = null;
        this.headBone = null;
        this.morphMeshes = [];
      }

      this.model = gltf.scene;

      // Center and scale the avatar
      const bbox = new THREE.Box3().setFromObject(this.model);
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const targetSize = 1.6;
      const scale = targetSize / maxDim;
      this.model.scale.multiplyScalar(scale);

      const center = bbox.getCenter(new THREE.Vector3());
      // Center the model at origin
      this.model.position.x = -center.x * scale;
      this.model.position.y = -center.y * scale + size.y * scale / 2;
      this.model.position.z = -center.z * scale;

      // Model already faces camera in the GLB, no rotation needed

      // Enable shadows, find head bone, and collect morph targets
      this.model.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          // Collect meshes with morph targets
          if (child.morphTargetDictionary && Object.keys(child.morphTargetDictionary).length > 0) {
            this.morphMeshes.push(child);
          }
          // Log ALL mesh names and positions to find the face
          if (child.name) {
            console.log(`Mesh: "${child.name}" at local [${child.position.x.toFixed(2)}, ${child.position.y.toFixed(2)}, ${child.position.z.toFixed(2)}]`);
          }
        }
        // Look for head bone by name
        if (child.isBone && /head|Head/i.test(child.name)) {
          this.headBone = child;
        }
        // Find REF empty object for CSS3D content positioning (added to GLB as reference point)
        if (child.name === 'REF' || child.name === 'ref' || child.name === 'Ref') {
          this.screenMesh = child as THREE.Mesh;
          console.log('Found REF object LOCAL position:', child.position.x, child.position.y, child.position.z);
          // Note: setupCSS3DContent() is called after model is positioned in scene
        }
        // Find notification ring by name - be specific to avoid matching eyes
        if (child.name && (child.name === 'Notification_Ring' || child.name === 'Ring' || child.name === 'notification_ring' || child.name === 'ring_light')) {
          if (child.isMesh && (child.material as any).map) {
            this.notificationRing = child as THREE.Mesh;
            console.log('Found notification ring:', child.name);
          }
        }
        // Explicitly exclude eyes from UV animation
        if (child.name && (child.name.includes('Eye') || child.name.includes('eye') || child.name.includes('EYE'))) {
          console.log('Found eye mesh (excluded from UV scroll):', child.name);
        }
      });

      // Create 3D content planes if reference found
      if (this.contentReference) {
        this.createContentPlanes();
      }

      // Add to scene
      this.scene.add(this.model);

      // Force world matrix update after positioning
      this.model.updateMatrixWorld(true);

      // Setup CSS3D content after model is positioned in scene
      if (this.screenMesh) {
        this.setupCSS3DContent();
      }

      // Create animation mixer
      this.animationMixer = new THREE.AnimationMixer(this.model);

      // Play Idle animation on loop for FlowB
      if (this.animationClips.has(this.animationState.idleClipName)) {
        console.log('Starting Idle animation');
        this.playAnimation(this.animationState.idleClipName, true);
        this.animationState.isPlaying = true;
      } else {
        console.log('No Idle animation found, available:', this.getAvailableAnimations());
      }

      // Hide loading
      if (loadingDiv) {
        loadingDiv.style.display = 'none';
      }

      // Reset camera target to maintain proper orbit center
      // Keep the original target (1, 1.5, 0) for side-view orbit
      if (this.orbitControls) {
        this.orbitControls.target.set(1, 1.5, 0);
        this.orbitControls.update();
      }

    } catch (error) {
      console.error('Failed to load model:', error);
      if (loadingDiv) {
        loadingDiv.innerHTML = `
          <div class="error-text">Failed to load avatar</div>
          <div style="color: #6b7280; font-size: 0.875rem; margin-top: 0.5rem;">
            /flowb.glb
          </div>
        `;
      }
    }

    this.isLoading = false;
  }

  // Debug helper - disabled
  // private debugScreenPosition() {
  //   if (!this.screenMesh || !this.scene) return;
  //   // Debug visualization code removed
  // }

  // Calculate world position manually by traversing hierarchy
  private getWorldPositionManual(obj: THREE.Object3D): THREE.Vector3 {
    const worldPos = new THREE.Vector3();
    worldPos.copy(obj.position);

    let current: THREE.Object3D | null = obj.parent;
    while (current) {
      const parentScale = current.scale;
      const parentQuat = current.quaternion;
      const parentPos = current.position;

      // Scale
      worldPos.multiply(parentScale);
      // Rotate
      worldPos.applyQuaternion(parentQuat);
      // Translate
      worldPos.add(parentPos);

      current = current.parent;
    }

    return worldPos;
  }

  // Setup CSS3D content display on screen mesh
  private setupCSS3DContent() {
    if (!this.screenMesh || !this.scene || !this.model) return;

    // Create HTML element for content
    const contentDiv = document.createElement('div');
    contentDiv.style.width = '320px';
    contentDiv.style.height = '240px';
    contentDiv.style.background = 'rgba(0, 20, 40, 0.95)';
    contentDiv.style.border = '2px solid #00ffff';
    contentDiv.style.borderRadius = '96px';
    contentDiv.style.padding = '12px';
    contentDiv.style.color = '#00ffff';
    contentDiv.style.fontFamily = "'Poppins', sans-serif";
    contentDiv.style.fontSize = '14px';
    contentDiv.style.display = 'none';
    contentDiv.style.boxShadow = 'inset 0 0 30px rgba(0, 255, 255, 0.3)';
    contentDiv.style.textAlign = 'center';
    contentDiv.style.overflow = 'hidden';
    contentDiv.style.backfaceVisibility = 'hidden';
    contentDiv.style.webkitBackfaceVisibility = 'hidden';
    contentDiv.style.position = 'relative';

    // Static scanline grid
    const scanlineOverlay = document.createElement('div');
    scanlineOverlay.style.position = 'absolute';
    scanlineOverlay.style.inset = '0';
    scanlineOverlay.style.pointerEvents = 'none';
    scanlineOverlay.style.background = `repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.4),
      rgba(0, 0, 0, 0.4) 2px,
      transparent 2px,
      transparent 5px
    )`;
    scanlineOverlay.style.borderRadius = 'inherit';
    scanlineOverlay.style.zIndex = '1';

    // Animated scanning bar (moves down like CRT refresh)
    const scanBar = document.createElement('div');
    scanBar.style.position = 'absolute';
    scanBar.style.left = '0';
    scanBar.style.right = '0';
    scanBar.style.height = '40px';
    scanBar.style.background = 'linear-gradient(to bottom, transparent, rgba(0, 255, 255, 0.1), transparent)';
    scanBar.style.animation = 'scanmove 3s linear infinite';
    scanBar.style.borderRadius = 'inherit';
    scanBar.style.zIndex = '2';

    // Add keyframes
    const keyframes = document.createElement('style');
    keyframes.textContent = `
      @keyframes scanmove {
        0% { top: -40px; }
        100% { top: 100%; }
      }
    `;

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = '<div style="font-size: 20px; margin-bottom: 8px;">👋 Hello!</div><div>I\'m FlowB</div><div style="font-size: 12px; opacity: 0.8; margin-top: 8px;">Ready to help</div>';

    contentDiv.appendChild(keyframes);
    contentDiv.appendChild(scanlineOverlay);
    contentDiv.appendChild(scanBar);
    contentDiv.appendChild(contentWrapper);

    // Create CSS3D object
    this.css3dContent = new CSS3DObject(contentDiv);

    // Parent to head bone if found, otherwise to scene
    if (this.headBone) {
      // Calculate local position relative to head bone
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      this.screenMesh.getWorldPosition(worldPos);
      this.screenMesh.getWorldQuaternion(worldQuat);

      // Get head bone's world transform
      const headWorldPos = new THREE.Vector3();
      const headWorldQuat = new THREE.Quaternion();
      this.headBone.getWorldPosition(headWorldPos);
      this.headBone.getWorldQuaternion(headWorldQuat);

      // Calculate local position relative to head
      const headInvQuat = headWorldQuat.clone().invert();
      const localPos = worldPos.clone().sub(headWorldPos).applyQuaternion(headInvQuat);
      const localQuat = worldQuat.clone().premultiply(headInvQuat);

      // Adjust position to sit on screen surface (slightly offset Y)
      this.css3dContent.position.copy(localPos);
      this.css3dContent.position.y -= 0.08; // Slight Y offset
      this.css3dContent.position.z += 0.01; // Slight forward offset
      this.css3dContent.quaternion.copy(localQuat);
      // Smaller scale to fit inside the screen
      this.css3dContent.scale.set(0.0011, 0.0012, 0.0011);

      // Add as child of head bone so it moves with animations
      this.headBone.add(this.css3dContent);
      console.log('CSS3D content parented to head bone');
    } else {
      // Fallback: add to scene at world position
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      this.screenMesh.getWorldPosition(worldPos);
      this.screenMesh.getWorldQuaternion(worldQuat);

      // Adjust position to sit on screen surface
      worldPos.y += 0.08;
      worldPos.z += 0.01;
      this.css3dContent.position.copy(worldPos);
      this.css3dContent.quaternion.copy(worldQuat);
      // Smaller scale to fit inside the screen
      this.css3dContent.scale.set(0.0014, 0.0013, 0.0014);

      this.scene.add(this.css3dContent);
      console.log('CSS3D content added to scene (no head bone found)');
    }

    // Initially hidden
    this.css3dContent.visible = false;
  }

  // Create 3D content planes behind FlowB's glass screen
  private createContentPlanes() {
    if (!this.contentReference || !this.scene) return;

    const refPos = this.contentReference.position;
    const refRot = this.contentReference.rotation;
    const refScale = this.contentReference.scale;

    // Create emissive back-lit plane (glow behind the content)
    const emissiveGeometry = new THREE.PlaneGeometry(1, 1);
    const emissiveMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    // Use CONTENT HERE reference position but adjust Y to be on the face screen
    // The reference might be positioned lower, so we adjust upward
    const contentScaleX = refScale.x * 0.8; // Narrower
    const contentScaleY = refScale.y * 0.7; // Moderate height
    const contentSpacing = 0.02; // Space between emissive and content planes
    const adjustedY = refPos.y + 0.3; // Move up to face area

    // Emissive back-light plane (behind the content)
    this.emissivePlane = new THREE.Mesh(emissiveGeometry, emissiveMaterial);
    this.emissivePlane.position.set(refPos.x, adjustedY, refPos.z - contentSpacing);
    this.emissivePlane.rotation.copy(refRot);
    this.emissivePlane.scale.set(contentScaleX, contentScaleY, 1);
    this.emissivePlane.visible = false;
    this.scene.add(this.emissivePlane);

    // Create content plane for HTML/2D content (in front of emissive)
    const contentGeometry = new THREE.PlaneGeometry(1, 1);
    const contentMaterial = new THREE.MeshBasicMaterial({
      color: 0x004488, // Brighter blue so it's visible
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    this.contentPlane = new THREE.Mesh(contentGeometry, contentMaterial);
    this.contentPlane.position.set(refPos.x, adjustedY, refPos.z); // At adjusted position
    this.contentPlane.rotation.copy(refRot);
    this.contentPlane.scale.set(contentScaleX, contentScaleY, 1);
    this.contentPlane.visible = false;
    this.scene.add(this.contentPlane);

    // Add a wireframe border to make it visible
    const borderGeometry = new THREE.PlaneGeometry(1, 1);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    });
    this.contentBorder = new THREE.Mesh(borderGeometry, borderMaterial);
    this.contentBorder.position.set(refPos.x, adjustedY, refPos.z + 0.001);
    this.contentBorder.rotation.copy(refRot);
    this.contentBorder.scale.set(contentScaleX * 1.01, contentScaleY * 1.01, 1);
    this.contentBorder.visible = false;
    this.scene.add(this.contentBorder);

    console.log('Content planes created at:', refPos);
  }

  public playAnimation(name: string, loop: boolean = true, blendDuration: number = 0.3) {
    if (!this.model || !this.isAnimationLoaded) return;

    const clip = this.animationClips.get(name);
    if (!clip) {
      console.warn(`Animation not found: ${name}`);
      return;
    }

    const newAction = this.animationMixer!.clipAction(clip);
    newAction.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
    newAction.clampWhenFinished = !loop;

    if (this.currentAnimation) {
      // Cross fade from current to new
      this.currentAnimation.crossFadeTo(newAction, blendDuration, true);
    }

    newAction.reset().play();
    this.currentAnimation = newAction;
  }

  private lastFrameTime = 0;

  private animateMorphTargets(delta: number, now: number): void {
    if (this.morphMeshes.length === 0) return;

    this.morphTime += delta;

    // More pronounced breathing animation
    const breath = Math.sin(this.morphTime * 0.8) * 0.5 + 0.5; // 0 to 1
    const microMove = Math.sin(this.morphTime * 2.5) * 0.3;

    for (const mesh of this.morphMeshes) {
      if (!mesh.morphTargetInfluences) continue;

      const dict = mesh.morphTargetDictionary;
      if (!dict) continue;

      // Animate common VRM facial morphs
      for (const [name, index] of Object.entries(dict)) {
        const lowerName = name.toLowerCase();

        // FlowB specific blendshapes
        // Blink - periodic natural blinking
        if (lowerName === 'blink') {
          let blinkValue = 0;
          if (this.screenState.isBlinking) {
            const blinkProgress = (this.morphTime - this.screenState.blinkStartTime) / this.screenState.blinkDuration;
            if (blinkProgress >= 1) {
              this.screenState.isBlinking = false;
              this.screenState.nextBlinkTime = this.morphTime + 2 + Math.random() * 3;
            } else {
              // Sine wave for smooth blink (closed at 0.5)
              blinkValue = Math.sin(blinkProgress * Math.PI);
            }
          } else if (this.morphTime >= this.screenState.nextBlinkTime) {
            this.screenState.isBlinking = true;
            this.screenState.blinkStartTime = this.morphTime;
          }
          mesh.morphTargetInfluences[index] = blinkValue;
        }

        // ShowContent - move eyes aside when displaying content on screen
        // Smooth blend transition
        if (lowerName === 'showcontent') {
          const targetValue = this.screenState.isShowingContent ? 1 : 0;
          const currentValue = mesh.morphTargetInfluences[index] || 0;
          const blendSpeed = 0.1; // Smooth transition speed
          mesh.morphTargetInfluences[index] = currentValue + (targetValue - currentValue) * blendSpeed;
        }
      }
    }
  }

  // Public API to toggle content display mode with animation
  public showContent(show: boolean, content?: string) {
    this.screenState.isShowingContent = show;

    if (show) {
      // Start reveal animation
      this.screenState.contentAnimState = 'revealing';
      if (this.css3dContent && content) {
        this.css3dContent.element.innerHTML = content;
      }
    } else {
      // Start hide animation
      this.screenState.contentAnimState = 'hiding';
    }
  }

  public isShowingContent(): boolean {
    return this.screenState.isShowingContent;
  }

  // Toggle content mode - switches between eyes and content display
  public toggleContentMode(content?: string): boolean {
    const newState = !this.screenState.isShowingContent;
    this.showContent(newState, content);
    return newState;
  }

  public setScreenContent(content: string) {
    this.screenState.screenContent = content;
    if (this.css3dContent && this.screenState.isShowingContent) {
      this.css3dContent.element.innerHTML = content;
    }
  }

  // Update content reveal/hide animation
  private updateContentAnimation(delta: number) {
    if (!this.css3dContent) return;

    const state = this.screenState;
    const div = this.css3dContent.element as HTMLElement;

    switch (state.contentAnimState) {
      case 'revealing':
        state.contentAnimProgress += delta * state.contentAnimSpeed;
        if (state.contentAnimProgress >= 1) {
          state.contentAnimProgress = 1;
          state.contentAnimState = 'visible';
        }
        break;
      case 'hiding':
        state.contentAnimProgress -= delta * state.contentAnimSpeed;
        if (state.contentAnimProgress <= 0) {
          state.contentAnimProgress = 0;
          state.contentAnimState = 'hidden';
        }
        break;
    }

    // Apply animation transforms
    const progress = state.contentAnimProgress;
    // Easing function: ease-out-back for reveal, ease-in for hide
    let eased = progress;
    if (state.contentAnimState === 'revealing') {
      // Ease-out-back: overshoot slightly then settle
      const c1 = 1.70158;
      const c3 = c1 + 1;
      eased = 1 + c3 * Math.pow(progress - 1, 3) + c1 * Math.pow(progress - 1, 2);
    } else if (state.contentAnimState === 'hiding') {
      // Ease-in
      eased = progress * progress;
    }

    // Apply CSS transforms for cool effect
    const scale = Math.max(0.001, eased * 0.0014);
    const opacity = eased;
    const glowIntensity = eased * 30;

    div.style.display = progress > 0 ? 'flex' : 'none';
    div.style.flexDirection = 'column';
    div.style.alignItems = 'center';
    div.style.justifyContent = 'center';
    div.style.opacity = String(opacity);
    div.style.boxShadow = `inset 0 0 ${glowIntensity}px rgba(0, 255, 255, ${0.3 * eased})`;

    // Update 3D scale for "pop" effect
    // Use local scale since CSS3DObject is parented (head bone or scene)
    this.css3dContent.scale.set(scale, scale, scale);
  }

  private animationLoop = (): void => {
    this.animationId = requestAnimationFrame(this.animationLoop);

    const now = performance.now() / 1000;
    const delta = this.lastFrameTime ? now - this.lastFrameTime : 0.016;
    this.lastFrameTime = now;

    // Update orbit controls with damping
    if (this.orbitControls) {
      // Head tracking disabled to allow free camera orbit
      // Users can now orbit around the model without interference
      this.orbitControls.update();
    }

    // Update animation mixer
    if (this.animationMixer) {
      this.animationMixer.update(delta);
    }

    // Update drei-vanilla effects
    if (this.sparkles) {
      this.sparkles.update(now);
    }

    // Camera shake disabled
    // if (this.cameraShake) {
    //   this.cameraShake.update(delta, now);
    // }

    // Animate morph targets for natural facial movement
    this.animateMorphTargets(delta, now);

    // Notification ring UV scroll - moves up and down on Y axis
    if (this.notificationRing) {
      const material = this.notificationRing.material as THREE.MeshStandardMaterial;
      if (material.map) {
        // Simple Y scroll - visible movement
        material.map.offset.y = now * 0.1;
      }
    }

    // Update content reveal/hide animation
    this.updateContentAnimation(delta);

    // Backface culling - tighter angle for more realistic screen visibility
    if (this.css3dContent && this.screenMesh && this.screenState.contentAnimState !== 'hidden') {
      // Get world position and rotation since content may be parented to head bone
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      this.css3dContent.getWorldPosition(worldPos);
      this.css3dContent.getWorldQuaternion(worldQuat);

      const viewDir = new THREE.Vector3().subVectors(this.camera.position, worldPos).normalize();
      const screenNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat);
      const dot = viewDir.dot(screenNormal);
      // Only visible when almost directly facing (dot > 0.5 = ~60 degree cone)
      this.css3dContent.visible = dot > 0.5 && this.screenState.contentAnimProgress > 0;
    }

    // Render WebGL
    this.renderer.render(this.scene, this.camera);

    // Render CSS3D (HTML content on screen)
    if (this.css3dRenderer) {
      this.css3dRenderer.render(this.scene, this.camera);
    }
  };

  // Public API for external control
  public setEnvironment(preset: 'studio' | 'sunset' | 'dawn' | 'night' | 'forest' | 'city') {
    this.setAttribute('environment', preset);
  }

  public resetCamera() {
    if (this.orbitControls) {
      this.camera.position.set(2, 1.2, 3.5);
      this.orbitControls.target.set(1, 1.5, 0);
      this.orbitControls.update();
    }
  }

  public getAvailableAnimations(): string[] {
    return Array.from(this.animationClips.keys()).sort();
  }

  public setAnimation(name: string) {
    this.setAttribute('animation', name);
  }

}

// Register the custom element
if (!customElements.get('model-viewer')) {
  customElements.define('model-viewer', ModelViewer as any);
}
