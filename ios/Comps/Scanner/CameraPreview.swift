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
    let session: AVCaptureSession
    var onTap: ((CGPoint) -> Void)?

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.backgroundColor = .black
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspectFill
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        v.addGestureRecognizer(tap)
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onTap = onTap
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        var onTap: ((CGPoint) -> Void)?
        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? PreviewView else { return }
            let devicePoint = view.previewLayer.captureDevicePointConverted(fromLayerPoint: g.location(in: view))
            onTap?(devicePoint)
        }
    }
}

/// Maps normalized frame coordinates onto an aspect-fill preview.
struct FrameMapper {
    var frame: CGSize
    var view: CGSize

    func point(_ p: CGPoint) -> CGPoint {
        guard frame.width > 0, frame.height > 0 else { return .zero }
        let scale = max(view.width / frame.width, view.height / frame.height)
        let w = frame.width * scale, h = frame.height * scale
        return CGPoint(x: p.x * w + (view.width - w) / 2, y: p.y * h + (view.height - h) / 2)
    }
}

/// The live outline drawn over the card.
struct DetectionOverlay: View {
    var quad: Quad?
    var frameSize: CGSize
    var tint: Color
    @State private var pulse = false

    var body: some View {
        GeometryReader { geo in
            let mapper = FrameMapper(frame: frameSize, view: geo.size)
            ZStack {
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
                    let w = min(geo.size.width * 0.72, geo.size.height * 0.5)
                    let h = w * 88 / 63
                    CornerBrackets()
                        .stroke(.white.opacity(pulse ? 0.9 : 0.55), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .frame(width: w, height: h)
                        .position(x: geo.size.width / 2, y: geo.size.height * 0.44)
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
