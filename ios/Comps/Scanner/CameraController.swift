import AVFoundation
import UIKit

/// Owns the capture session. Frames are delivered portrait-up on a background queue.
final class CameraController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "comps.camera.session")
    private let videoQueue = DispatchQueue(label: "comps.camera.frames", qos: .userInitiated)
    private let output = AVCaptureVideoDataOutput()
    private var device: AVCaptureDevice?
    private var configured = false

    /// Called on the video queue for every frame.
    var onFrame: (@Sendable (CVPixelBuffer) -> Void)?

    static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    func start() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.configured { self.configure() }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    private func configure() {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .hd1920x1080

        let preferred: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: preferred, mediaType: .video, position: .back)
        guard let device = discovery.devices.first,
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        self.device = device

        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        if let connection = output.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }

        do {
            try device.lockForConfiguration()
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isAutoFocusRangeRestrictionSupported { device.autoFocusRangeRestriction = .near }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            if device.isSmoothAutoFocusSupported { device.isSmoothAutoFocusEnabled = false }
            device.videoZoomFactor = recommendedZoom(for: device)
            device.unlockForConfiguration()
        } catch {}
        configured = true
    }

    /// Phones with a long minimum focus distance (Pro models) can't focus on a
    /// card held close. Zoom in a little so the card fills the frame from
    /// further away — the approach Apple recommends for scanning small objects.
    private func recommendedZoom(for device: AVCaptureDevice) -> CGFloat {
        let minFocus = Float(device.minimumFocusDistance)
        guard minFocus > 0 else { return 1 }
        let fov = device.activeFormat.videoFieldOfView
        let cardHeightMM: Float = 88
        let fill: Float = 0.75
        let radians = (fov / 2) * .pi / 180
        let subjectDistance = (cardHeightMM / fill) / tan(radians)
        guard subjectDistance < minFocus else { return 1 }
        let zoom = CGFloat(minFocus / subjectDistance)
        return min(max(1, zoom), min(device.activeFormat.videoMaxZoomFactor, 2.5))
    }

    func setTorch(_ on: Bool) {
        sessionQueue.async { [weak self] in
            guard let device = self?.device, device.hasTorch else { return }
            do {
                try device.lockForConfiguration()
                device.torchMode = on ? .on : .off
                device.unlockForConfiguration()
            } catch {}
        }
    }

    func focus(at point: CGPoint) {
        sessionQueue.async { [weak self] in
            guard let device = self?.device else { return }
            do {
                try device.lockForConfiguration()
                if device.isFocusPointOfInterestSupported {
                    device.focusPointOfInterest = point
                    device.focusMode = .autoFocus
                }
                device.unlockForConfiguration()
            } catch {}
        }
    }

    var hasTorch: Bool { device?.hasTorch ?? false }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        onFrame?(pixelBuffer)
    }
}
