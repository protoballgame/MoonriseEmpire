Place custom moon GLB files in this folder.

Example:
  public/moon/Moon_NASA_LRO_15k_Grid_Small.glb

Then launch with:
  http://localhost:4173/?match=pvc&terrain=sphere&moonModel=/moon/Moon_NASA_LRO_15k_Grid_Small.glb

Optional model scale:
  &moonModelScale=1.0

Notes:
- Browser builds cannot reliably load arbitrary C:\ paths over http due sandbox/CORS.
- Keeping the file under public/ makes it available at /moon/<filename>.
