import AVFoundation
import CoreImage
import UIKit

/// Owns the capture session. Frames are delivered portrait-up on a background queue.
final class CameraController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "comps.camera.session")
    private let videoQueue = DispatchQueue(label: "comps.camera.frames", qos: .userInitiated)
    private let output = AVCaptureVideoDataOutput()
    private let photoOutput = AVCapturePhotoOutput()
    private var device: AVCaptureDevice?
    private var configured = false
    private var pagePhotos = false
    private let videoPreset: AVCaptureSession.Preset
    private var inFlight: [Int64: PhotoCaptureDelegate] = [:]

    /// Called on the video queue for every frame.
    var onFrame: (@Sendable (CVPixelBuffer) -> Void)?

    /// 4K frames give the OCR about twice the pixels on a card's tiny collector number.
    init(preset: AVCaptureSession.Preset = .hd4K3840x2160) {
        videoPreset = preset
        super.init()
    }

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
        guard addInputsAndOutputs() else { session.commitConfiguration(); return }
        session.commitConfiguration()
        // Photo size depends on the active format, which settles once the configuration is committed.
        if let device { applyPhotoDimensions(device) }
        configured = true
    }

    private func addInputsAndOutputs() -> Bool {
        session.sessionPreset = session.canSetSessionPreset(videoPreset) ? videoPreset : .hd1920x1080

        let preferred: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: preferred, mediaType: .video, position: .back)
        guard let device = discovery.devices.first,
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return false }
        session.addInput(input)
        self.device = device

        // Bi-planar YUV is half the memory traffic of BGRA at 4K; Vision and Core Image read it directly.
        let yuv = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        let format = output.availableVideoPixelFormatTypes.contains(yuv) ? yuv : kCVPixelFormatType_32BGRA
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: format]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)
        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        if session.canAddOutput(photoOutput) {
            session.addOutput(photoOutput)
            photoOutput.maxPhotoQualityPrioritization = .quality
        }
        applyRotation()

        do {
            try device.lockForConfiguration()
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isAutoFocusRangeRestrictionSupported { device.autoFocusRangeRestriction = .near }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            if device.isSmoothAutoFocusSupported { device.isSmoothAutoFocusEnabled = false }
            device.videoZoomFactor = recommendedZoom(for: device, subjectMM: 88)
            device.unlockForConfiguration()
        } catch {}
        return true
    }

    private func applyRotation() {
        for connection in [output.connection(with: .video), photoOutput.connection(with: .video)].compactMap({ $0 }) {
            if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        }
    }

    /// Full-resolution stills, capped at 12 MP: plenty for a binder page, and fast.
    private func applyPhotoDimensions(_ device: AVCaptureDevice) {
        guard session.outputs.contains(photoOutput) else { return }
        let dims = device.activeFormat.supportedMaxPhotoDimensions
        let capped = dims.filter { Int($0.width) * Int($0.height) <= 12_600_000 }
        let area: (CMVideoDimensions) -> Int = { Int($0.width) * Int($0.height) }
        if let best = capped.max(by: { area($0) < area($1) }) ?? dims.min(by: { area($0) < area($1) }) {
            photoOutput.maxPhotoDimensions = best
        }
    }

    /// Binder pages want the whole 4:3 sensor and full-resolution stills; single cards want 4K video frames.
    func setPageMode(_ on: Bool) {
        sessionQueue.async { [weak self] in
            guard let self, self.configured, self.pagePhotos != on, let device = self.device else { return }
            self.pagePhotos = on
            self.session.beginConfiguration()
            let preset: AVCaptureSession.Preset = on ? .photo : self.videoPreset
            if self.session.canSetSessionPreset(preset) { self.session.sessionPreset = preset }
            self.applyRotation()
            self.session.commitConfiguration()
            self.applyPhotoDimensions(device)
            do {
                try device.lockForConfiguration()
                device.videoZoomFactor = self.recommendedZoom(for: device, subjectMM: on ? 290 : 88)
                device.unlockForConfiguration()
            } catch {}
        }
    }

    /// Phones with a long minimum focus distance (Pro models) can't focus on a
    /// card held close. Zoom in a little so the subject fills the frame from
    /// further away — the approach Apple recommends for scanning small objects.
    private func recommendedZoom(for device: AVCaptureDevice, subjectMM: Float) -> CGFloat {
        let minFocus = Float(device.minimumFocusDistance)
        guard minFocus > 0 else { return 1 }
        let fov = device.activeFormat.videoFieldOfView
        let fill: Float = 0.75
        let radians = (fov / 2) * .pi / 180
        let subjectDistance = (subjectMM / fill) / tan(radians)
        guard subjectDistance < minFocus else { return 1 }
        let zoom = CGFloat(minFocus / subjectDistance)
        return min(max(1, zoom), min(device.activeFormat.videoMaxZoomFactor, 2.5))
    }

    /// Takes a full-resolution still, upright. Nil if the camera isn't running or capture fails.
    func capturePhoto() async -> CGImage? {
        await withCheckedContinuation { (continuation: CheckedContinuation<CGImage?, Never>) in
            sessionQueue.async { [weak self] in
                guard let self, self.session.isRunning, self.session.outputs.contains(self.photoOutput),
                      self.photoOutput.connection(with: .video) != nil else {
                    continuation.resume(returning: nil)
                    return
                }
                let settings = AVCapturePhotoSettings()
                settings.maxPhotoDimensions = self.photoOutput.maxPhotoDimensions
                settings.photoQualityPrioritization = .balanced
                if self.photoOutput.supportedFlashModes.contains(.off) { settings.flashMode = .off }
                let id = settings.uniqueID
                let delegate = PhotoCaptureDelegate { [weak self] image in
                    continuation.resume(returning: image)
                    self?.sessionQueue.async { self?.inFlight[id] = nil }
                }
                self.inFlight[id] = delegate
                self.photoOutput.capturePhoto(with: settings, delegate: delegate)
            }
        }
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

/// Receives one still and hands it back upright. Calls `done` exactly once.
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let done: (CGImage?) -> Void
    private let lock = NSLock()
    private var finished = false

    init(done: @escaping (CGImage?) -> Void) {
        self.done = done
    }

    private func finish(_ image: CGImage?) {
        lock.lock()
        let first = !finished
        finished = true
        lock.unlock()
        if first { done(image) }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard error == nil, let data = photo.fileDataRepresentation(),
              let image = CIImage(data: data, options: [.applyOrientationProperty: true]) else {
            finish(nil)
            return
        }
        let upright = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
        finish(CardImaging.cgImage(upright))
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        finish(nil)
    }
}
