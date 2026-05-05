# Harsh — Intro Animation Handoff

Logo intro: a thin pen traces each subpath of the Harsh mark over ~4.5s, then the filled logo bleeds in over the second half so the final state is the solid mark.

Source: [`preloader-preview.html`](../../preloader-preview.html) in the website repo.

## Recommended for iOS

Best → fallback:

1. **`HarshIntroView.swift` + `HarshLogoPath.swift`** — drop-in UIView. Vector, native, infinitely scalable, no dependencies. `view.play { /* done */ }`. **Use this if at all possible.**
2. **`intro-h265.mp4`** — H.265/HEVC, ~230 KB, white background. Drop into `AVPlayerLayer`. Cheapest path if timeline is tight.
3. **`intro-alpha.webm`** — VP9 with alpha channel (transparent bg). iOS 14+ via AVFoundation needs HEVC-with-alpha rather than WebM, so prefer #1 if you need transparency.

## All Files

| File | Format | BG | Size | Notes |
|------|--------|-----|-----|-------|
| `HarshIntroView.swift` + `HarshLogoPath.swift` | Swift / UIKit | any | 28 KB | Native, vector. `tintColor` controls logo color. |
| `intro.mp4` | H.264 MP4 | white | 341 KB | Universal, plays anywhere. 1080×756 @ 60fps. |
| `intro-h265.mp4` | HEVC MP4 | white | 231 KB | Smaller. iOS 11+. |
| `intro-alpha.webm` | VP9 alpha WebM | transparent | 417 KB | Web/Android. Not native iOS friendly. |
| `intro.apng` | APNG | transparent | 3.9 MB | Universal animated PNG with alpha. |
| `intro.gif` | GIF | white | 698 KB | 30fps, 720px wide, 64-color palette. Last-resort fallback. |
| `intro-frames-png.zip` | PNG sequence | transparent | 6.0 MB | 271 frames @ 60fps for `UIImageView` `animationImages` or custom playback. |
| `intro.html` | HTML+SVG+JS | white or transparent | 17 KB | Standalone. Open in browser. `?bg=transparent&autoplay=1` supported. |
| `intro-logo.svg` | SVG (final state) | — | 13 KB | Static vector logo for static mockups. |

## Spec

- **Duration**: 4500 ms (configurable per file)
- **Frame rate**: 60 fps (animated formats); GIF is 30 fps
- **Resolution**: 1080×756 (matches the logo's 160:112 aspect ratio)
- **Color**: `#111111` on white (or transparent)
- **One-shot**: ends on the filled logo. Re-trigger via `play()` in Swift, or `setProgress(0)` then re-call in HTML.

## Re-rendering

The exports are reproducible. From the repo root:

```sh
cd exports
node render.js --bg=white      # 271 PNG frames → frames-white/
node render.js --bg=transparent
# then re-run the ffmpeg commands from this README's git history
```

Tweakable params on `render.js`: `--width`, `--height`, `--fps`, `--duration`, `--bg`.

## Swift Quickstart

```swift
let intro = HarshIntroView(frame: view.bounds)
intro.backgroundColor = .white  // or .clear
intro.tintColor = .black        // logo color
view.addSubview(intro)
intro.play {
    // animation done — transition to your home screen
}
```

`HarshLogoPath.swift` carries the SVG path data and a small parser. No external dependencies.

## Lottie?

If the iOS dev wants a Lottie (`.lottie` / `.json`) version, convert `intro-logo.svg` via [LottieFiles' SVG-to-Lottie tool](https://lottiefiles.com/tools/svg-to-lottie) and recreate the trim-path + fill-opacity keyframes manually — the Swift drop-in already gives you a vector animation, so this is only needed if Lottie is a hard requirement.
