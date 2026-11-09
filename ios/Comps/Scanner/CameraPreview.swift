import SwiftUI
import AVFoundation

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let c = previewLayer.connection, c.isVideoRotationAngleSupported(90), c.videoRotationAngle != 90 {
            c.videoRotationAngle = 90
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    enum Pinch { case began, changed(CGFloat), ended }

    let session: AVCaptureSession
    /// Binder pages show the whole 4:3 frame (aspect fit) so the page can fill the photo.
    var fill = true
    /// Tap: the point in camera coordinates (for focus) and in the view (for the focus mark).
    var onTap: ((_ device: CGPoint, _ view: CGPoint) -> Void)?
    /// Pinch to zoom: the scale since the pinch began.
    var onPinch: ((Pinch) -> Void)?

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.backgroundColor = .black
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspectFill
        v.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:))))
        v.addGestureRecognizer(UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinched(_:))))
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onTap = onTap
        context.coordinator.onPinch = onPinch
        let gravity: AVLayerVideoGravity = fill ? .resizeAspectFill : .resizeAspect
        if uiView.previewLayer.videoGravity != gravity { uiView.previewLayer.videoGravity = gravity }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        var onTap: ((CGPoint, CGPoint) -> Void)?
        var onPinch: ((Pinch) -> Void)?

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? PreviewView else { return }
            let at = g.location(in: view)
            onTap?(view.previewLayer.captureDevicePointConverted(fromLayerPoint: at), at)
        }

        @objc func pinched(_ g: UIPinchGestureRecognizer) {
            switch g.state {
            case .began: onPinch?(.began)
            case .changed: onPinch?(.changed(g.scale))
            case .ended, .cancelled, .failed: onPinch?(.ended)
            default: break
            }
        }
    }
}

/// Maps normalized frame coordinates onto an aspect-fill (or aspect-fit) preview.
struct FrameMapper {
    var frame: CGSize
    var view: CGSize
    var fill = true

    private var displayed: CGRect {
        guard frame.width > 0, frame.height > 0 else { return .zero }
        let scale = fill ? max(view.width / frame.width, view.height / frame.height) : min(view.width / frame.width, view.height / frame.height)
        let w = frame.width * scale, h = frame.height * scale
        return CGRect(x: (view.width - w) / 2, y: (view.height - h) / 2, width: w, height: h)
    }

    func point(_ p: CGPoint) -> CGPoint {
        let d = displayed
        return CGPoint(x: d.minX + p.x * d.width, y: d.minY + p.y * d.height)
    }

    /// The inverse of `point`: a place on screen to frame coordinates (0…1).
    func normalized(_ p: CGPoint) -> CGPoint {
        let d = displayed
        guard d.width > 0, d.height > 0 else { return .zero }
        return CGPoint(x: (p.x - d.minX) / d.width, y: (p.y - d.minY) / d.height)
    }

    func rect(_ r: CGRect) -> CGRect {
        let a = point(CGPoint(x: r.minX, y: r.minY)), b = point(CGPoint(x: r.maxX, y: r.maxY))
        return CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
    }
}

/// The live outline drawn over the card.
struct DetectionOverlay: View {
    var quad: Quad?
    var frameSize: CGSize
    var tint: Color
    /// Where the card guide sits, in frame coordinates (Single mode reads what's inside it).
    var onGuide: (Quad) -> Void = { _ in }
    @State private var pulse = false

    /// The card-shaped guide shown when no card is found.
    static func guideRect(_ view: CGSize) -> CGRect {
        let w = min(view.width * 0.72, view.height * 0.5), h = w * 88 / 63
        return CGRect(x: view.width / 2 - w / 2, y: view.height * 0.44 - h / 2, width: w, height: h)
    }

    var body: some View {
        GeometryReader { geo in
            let mapper = FrameMapper(frame: frameSize, view: geo.size)
            let guide = Self.guideRect(geo.size)
            ZStack {
                Color.clear
                    .task(id: "\(geo.size.width)x\(geo.size.height) \(frameSize.width)x\(frameSize.height)") {
                        let n = { (p: CGPoint) in mapper.normalized(p) }
                        onGuide(Quad(topLeft: n(CGPoint(x: guide.minX, y: guide.minY)), topRight: n(CGPoint(x: guide.maxX, y: guide.minY)),
                                     bottomRight: n(CGPoint(x: guide.maxX, y: guide.maxY)), bottomLeft: n(CGPoint(x: guide.minX, y: guide.maxY))))
                    }
                if let quad {
                    let pts = quad.points.map(mapper.point)
                    Path { p in
                        p.move(to: pts[0])
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                        p.closeSubpath()
                    }
                    .fill(tint.opacity(0.12))
                    Path { p in
                        p.move(to: pts[0])
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                        p.closeSubpath()
                    }
                    .stroke(tint, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    .shadow(color: .black.opacity(0.25), radius: 6)
                    .transition(.opacity)
                } else {
                    // Guide: card-shaped corner brackets.
                    CornerBrackets()
                        .stroke(.white.opacity(pulse ? 0.9 : 0.55), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .frame(width: guide.width, height: guide.height)
                        .position(x: guide.midX, y: guide.midY)
                        .scaleEffect(pulse ? 1.0 : 0.985)
                        .transition(.opacity)
                        .onAppear {
                            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { pulse = true }
                        }
                }
            }
            .animation(.easeOut(duration: 0.2), value: quad == nil)
        }
        .allowsHitTesting(false)
    }
}

struct CornerBrackets: Shape {
    func path(in r: CGRect) -> Path {
        let l = min(r.width, r.height) * 0.14
        let c: CGFloat = 14
        var p = Path()
        // top-left
        p.move(to: CGPoint(x: r.minX, y: r.minY + l)); p.addLine(to: CGPoint(x: r.minX, y: r.minY + c))
        p.addQuadCurve(to: CGPoint(x: r.minX + c, y: r.minY), control: CGPoint(x: r.minX, y: r.minY)); p.addLine(to: CGPoint(x: r.minX + l, y: r.minY))
        // top-right
        p.move(to: CGPoint(x: r.maxX - l, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX - c, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY + c), control: CGPoint(x: r.maxX, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX, y: r.minY + l))
        // bottom-right
        p.move(to: CGPoint(x: r.maxX, y: r.maxY - l)); p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        p.addQuadCurve(to: CGPoint(x: r.maxX - c, y: r.maxY), control: CGPoint(x: r.maxX, y: r.maxY)); p.addLine(to: CGPoint(x: r.maxX - l, y: r.maxY))
        // bottom-left
        p.move(to: CGPoint(x: r.minX + l, y: r.maxY)); p.addLine(to: CGPoint(x: r.minX + c, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - c), control: CGPoint(x: r.minX, y: r.maxY)); p.addLine(to: CGPoint(x: r.minX, y: r.maxY - l))
        return p
    }
}
