import * as THREE from "three";

/**
 * Main-view render wrapper with no postprocessing (old-school, efficient, broadly compatible).
 */
export class MoonPresentationComposer {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera
  ) {}

  setSize(_width: number, _height: number, _pixelRatio: number): void {}

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {}
}
