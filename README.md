# VENOM — interactive 3D presentation

Six sections orbit a rotating 3D VENOM coin. Next/Back swing the camera around the coin.

## Run locally
ES modules need an http server (not `file://`):

    cd venom-presentation
    python3 -m http.server 8123      # then open http://localhost:8123

No build step and no network needed: Three.js and the fonts are vendored in `vendor/`.

## Controls
- **Next / Back** arrows, progress dots, **Home** button (cover)
- Keys: `→ ↓ PageDown Space Enter` next · `← ↑ PageUp` back · `Home`/`Esc` cover · `End` last · `1`–`6` jump · `F` full screen
- Swipe left/right or scroll wheel also navigate
- **Reduce motion** (defaults to your OS setting): camera cuts instead of travelling, coin stops spinning, effects show their settled state
- **Sound** toggle: short electronic blips play only when a navigation button is clicked
- Cover: click `[Your Name]`, `[Class]`, `[Date]` to type your details (saved in this browser)

## Files
- `index.html` — layout, styling, slide text (edit the `<section class="panel">` blocks)
- `main.js` — 3D scene, coin, per-section effects, camera, navigation
- `vendor/` — three.js r187, postprocessing + CSS3D add-ons, Orbitron/Inter fonts
