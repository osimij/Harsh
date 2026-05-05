// HarshIntroView.swift
// A drop-in UIKit view that renders the Harsh logo intro animation natively.
// Mirrors the timing & easing of the web version (preloader-preview.html):
//   • A thin pen traces each subpath in path order over `duration`.
//   • Earlier subpaths overlap into later ones by 35% of their slice for flow.
//   • Over the second half (t > 0.55), the filled mark bleeds in (easeOutQuad).
//
// Drop this file into your Xcode project. The SVG path is split into subpaths
// at runtime, so the animation matches the web preview exactly.
//
// Usage:
//     let intro = HarshIntroView(frame: view.bounds)
//     intro.duration = 4.5            // optional, default 4.5s
//     intro.tintColor = .black        // optional, default black
//     intro.backgroundColor = .white  // or .clear for transparent
//     view.addSubview(intro)
//     intro.play { /* on complete */ }

import UIKit

public final class HarshIntroView: UIView {

    public var duration: CFTimeInterval = 4.5
    public var subpathOverlap: Double = 0.35     // matches web `overlap`
    public var fillStart: Double = 0.55          // matches web `fillStart`

    private let logoBounds = CGRect(x: 0, y: 0, width: 160, height: 112)

    private let strokeContainer = CALayer()
    private let fillLayer = CAShapeLayer()
    private var strokeLayers: [CAShapeLayer] = []

    public override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }
    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        backgroundColor = .white

        let subpaths = HarshLogoPath.subpaths()  // [UIBezierPath]
        let totalLen = subpaths.reduce(0.0) { $0 + $1.approxLength() }

        // Slice timeline per subpath length, with overlap so the pen flows
        // continuously between subpaths. Identical math to the web version.
        var cursor = 0.0
        var slices: [(start: Double, end: Double)] = []
        for sp in subpaths {
            let dur = sp.approxLength() / totalLen
            let start = cursor
            let end = cursor + dur
            slices.append((start, end))
            cursor = end - dur * subpathOverlap
        }
        let span = slices.last?.end ?? 1.0
        slices = slices.map { (start: $0.start / span, end: $0.end / span) }

        // Build CAShapeLayer per subpath. strokeEnd starts at 0.
        let scale = bounds.width / logoBounds.width   // recomputed in layoutSubviews
        for (path, _) in zip(subpaths, slices) {
            let layer = CAShapeLayer()
            layer.path = path.cgPath
            layer.strokeColor = tintColor.cgColor
            layer.fillColor = UIColor.clear.cgColor
            layer.lineWidth = 1.4
            layer.lineCap = .round
            layer.lineJoin = .round
            layer.strokeEnd = 0
            strokeContainer.addSublayer(layer)
            strokeLayers.append(layer)
        }

        // Filled logo on top, fades in at fillStart.
        fillLayer.path = HarshLogoPath.fullPath().cgPath
        fillLayer.fillRule = .evenOdd
        fillLayer.fillColor = tintColor.cgColor
        fillLayer.opacity = 0

        layer.addSublayer(strokeContainer)
        layer.addSublayer(fillLayer)
        _ = scale  // suppress unused; real scale set in layoutSubviews
        // Cache slices for play()
        self.timing = slices
    }

    private var timing: [(start: Double, end: Double)] = []

    public override func layoutSubviews() {
        super.layoutSubviews()
        // Aspect-fit the 160×112 logo into bounds.
        let scale = min(bounds.width / logoBounds.width,
                        bounds.height / logoBounds.height)
        let drawW = logoBounds.width * scale
        let drawH = logoBounds.height * scale
        let originX = (bounds.width - drawW) / 2
        let originY = (bounds.height - drawH) / 2
        let transform = CATransform3DMakeAffineTransform(
            CGAffineTransform(translationX: originX, y: originY).scaledBy(x: scale, y: scale))
        strokeContainer.transform = transform
        fillLayer.transform = transform
    }

    public override func tintColorDidChange() {
        super.tintColorDidChange()
        for l in strokeLayers { l.strokeColor = tintColor.cgColor }
        fillLayer.fillColor = tintColor.cgColor
    }

    public func play(completion: (() -> Void)? = nil) {
        let dur = duration
        let easeInOutCubic = CAMediaTimingFunction(controlPoints: 0.65, 0, 0.35, 1)

        // Per-subpath strokeEnd animations.
        for (i, sp) in strokeLayers.enumerated() {
            let slice = timing[i]
            let begin = dur * slice.start
            let length = max(0.001, dur * (slice.end - slice.start))
            let anim = CABasicAnimation(keyPath: "strokeEnd")
            anim.fromValue = 0
            anim.toValue = 1
            anim.beginTime = CACurrentMediaTime() + begin
            anim.duration = length
            anim.timingFunction = easeInOutCubic
            anim.fillMode = .forwards
            anim.isRemovedOnCompletion = false
            sp.add(anim, forKey: "draw")
        }

        // Fill bleed-in (easeOutQuad ≈ controlPoints 0.5,1,0.89,1).
        let fillAnim = CABasicAnimation(keyPath: "opacity")
        fillAnim.fromValue = 0
        fillAnim.toValue = 1
        fillAnim.beginTime = CACurrentMediaTime() + dur * fillStart
        fillAnim.duration = dur * (1 - fillStart)
        fillAnim.timingFunction = CAMediaTimingFunction(controlPoints: 0.5, 1, 0.89, 1)
        fillAnim.fillMode = .forwards
        fillAnim.isRemovedOnCompletion = false
        fillLayer.add(fillAnim, forKey: "bleed")

        if let completion = completion {
            DispatchQueue.main.asyncAfter(deadline: .now() + dur) { completion() }
        }
    }

    public func reset() {
        for l in strokeLayers { l.removeAllAnimations(); l.strokeEnd = 0 }
        fillLayer.removeAllAnimations()
        fillLayer.opacity = 0
    }
}

// MARK: - UIBezierPath length helper

private extension UIBezierPath {
    /// Approximate length by polyline-sampling the path. Good enough to
    /// proportion the timeline; not sub-pixel accurate.
    func approxLength() -> Double {
        var lastPoint: CGPoint = .zero
        var hasLast = false
        var total: Double = 0

        cgPath.applyWithBlock { elementPtr in
            let element = elementPtr.pointee
            switch element.type {
            case .moveToPoint:
                lastPoint = element.points[0]
                hasLast = true
            case .addLineToPoint:
                let p = element.points[0]
                if hasLast { total += hypot(Double(p.x - lastPoint.x), Double(p.y - lastPoint.y)) }
                lastPoint = p
                hasLast = true
            case .addQuadCurveToPoint:
                let c = element.points[0], p = element.points[1]
                total += polyArc(from: lastPoint, c1: c, c2: c, to: p, samples: 16)
                lastPoint = p
                hasLast = true
            case .addCurveToPoint:
                let c1 = element.points[0], c2 = element.points[1], p = element.points[2]
                total += polyArc(from: lastPoint, c1: c1, c2: c2, to: p, samples: 24)
                lastPoint = p
                hasLast = true
            case .closeSubpath:
                break
            @unknown default:
                break
            }
        }
        return total
    }

    private func polyArc(from a: CGPoint, c1: CGPoint, c2: CGPoint, to b: CGPoint, samples: Int) -> Double {
        var prev = a
        var total: Double = 0
        for i in 1...samples {
            let t = Double(i) / Double(samples)
            let mt = 1 - t
            let x = mt*mt*mt*Double(a.x) + 3*mt*mt*t*Double(c1.x) + 3*mt*t*t*Double(c2.x) + t*t*t*Double(b.x)
            let y = mt*mt*mt*Double(a.y) + 3*mt*mt*t*Double(c1.y) + 3*mt*t*t*Double(c2.y) + t*t*t*Double(b.y)
            let p = CGPoint(x: x, y: y)
            total += hypot(Double(p.x - prev.x), Double(p.y - prev.y))
            prev = p
        }
        return total
    }
}
