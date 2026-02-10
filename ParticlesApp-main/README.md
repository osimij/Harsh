# Particles v4 - Advanced Particle Forge

A high-performance, GPU-accelerated particle system and animation engine built with WebGL2 and React Three Fiber.

## 🌟 Features

- **High-Performance Rendering**: Leveraging WebGL2 for smooth, high-count particle simulations (up to 2M+ particles).
- **GPU-Accelerated Simulations**: Frame Buffer Object (FBO) based particle physics and logic.
- **Dynamic Transitions**: Advanced shape-to-shape transitions with various director strategies.
- **SVG Integration**: Parse and sample complex shapes directly from SVG files.
- **Interactive Tools**: 
  - **Magnet Tool**: Real-time interaction with particles (attraction/repulsion).
  - **Live Controls**: Comprehensive UI for adjusting particle behavior, colors, and effects.
- **Visual Effects**:
  - Bloom and glow post-processing.
  - Logo-wide gradient overlays.
  - Metallic dust palettes and sparkle effects.
- **Export Capabilities**: 
  - Video recording (Live Recorder).
  - High-resolution image export.
  - Sequence controller for complex animation scripts.

## 🏗 Project Structure

- `/js`: Core vanilla WebGL engine and application logic.
  - `app/core/`: Orchestration, lifecycle, and main particle forge logic.
  - `app/features/`: GPU controllers, recording, and sequence management.
  - `app/ui/`: UI controllers for interaction, controls, and uploads.
- `/fbo`: A specialized React Three Fiber implementation for complex FBO simulations.
- `/public`: Static assets.

## 🚀 Getting Started

### Vanilla WebGL Engine
Simply open `index.html` in a local server (like Live Server or `npx serve .`).

### FBO React Project
1. Navigate to the `fbo` directory:
   ```bash
   cd fbo
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```

## 🛠 Tech Stack

- **WebGL2**: Raw high-performance graphics.
- **React + React Three Fiber**: For the FBO sub-project.
- **Three.js**: Graphics library for the FBO module.
- **Vite**: Modern frontend build tool.
- **GLSL**: Custom shaders for simulations and rendering.

## 📜 License

MIT






