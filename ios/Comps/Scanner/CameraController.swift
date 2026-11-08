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
    /// Zoom is in the Camera app's terms: 1× is the main lens, 0.5× the ultra-wide. On phones with
    /// an ultra-wide the device is the multi-lens camera, whose zoom factor 1 is the ultra-wide;
    /// this is the factor where the main lens takes over (1 on phones with only the main lens).
    private var zoomBase: CGFloat = 1

    /// Called on the video queue for every frame.
    var onFrame: (@Sendable (CVPixelBuffer) -> Void)?
    /// The zoom actually applied (after clamping), whenever it changes.
    var onZoom: (@Sendable (CGFloat) -> Void)?
    /// Where the lens sits and whether focus is held there (tap or slider) or automatic.
    var onFocus: (@Sendable (_ lens: Float, _ locked: Bool) -> Void)?
    /// After switching between card and page mode, once the camera is ready again.
    var onReconfigured: (@Sendable () -> Void)?
    /// Once the camera is set up: the widest zoom on offer (0.5 with an ultra-wide) and whether
    /// focus can be set by hand with the slider (the multi-lens camera only takes a tapped spot).
    var onLenses: (@Sendable (_ minZoom: CGFloat, _ manualFocus: Bool) -> Void)?

    /// The most the scanner zooms, in Camera app terms (sharp enough for reading cards up to here).
    static let maxZoom: CGFloat = 6

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

        // The multi-lens camera when there is one: it offers 0.5×, and moves to the ultra-wide by itself
        // when a card is too close for the main lens to focus (how the Camera app does close-ups).
        let preferred: [AVCaptureDevice.DeviceType] = [.builtInTripleCamera, .builtInDualWideCamera, .builtInWideAngleCamera]
        guard let device = preferred.lazy.compactMap({ AVCaptureDevice.default($0, for: .video, position: .back) }).first,
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return false }
        session.addInput(input)
        self.device = device
        if device.isVirtualDevice, device.constituentDevices.contains(where: { $0.deviceType == .builtInUltraWideCamera }),
           let mainLens = device.virtualDeviceSwitchOverVideoZoomFactors.first {
            zoomBase = CGFloat(truncating: mainLens)
        }

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
            if device.isVirtualDevice {
                device.setPrimaryConstituentDeviceSwitchingBehavior(.auto, restrictedSwitchingBehaviorConditions: [])
            }
            device.videoZoomFactor = factor(defaultZoom(device, subjectMM: 88), device)
            device.unlockForConfiguration()
        } catch {}
        onLenses?(device.minAvailableVideoZoomFactor / zoomBase, device.isLockingFocusWithCustomLensPositionSupported)
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
    /// `zoom`, `lens` and `point` are the user's settings for the new mode (nil: automatic).
    func setPageMode(_ on: Bool, zoom: CGFloat?, lens: Float?, point: CGPoint?) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            defer { self.onReconfigured?() }
            guard self.configured, let device = self.device else { return }
            if self.pagePhotos != on {
                self.pagePhotos = on
                self.session.beginConfiguration()
                let preset: AVCaptureSession.Preset = on ? .photo : self.videoPreset
                if self.session.canSetSessionPreset(preset) { self.session.sessionPreset = preset }
                self.applyRotation()
                self.session.commitConfiguration()
                self.applyPhotoDimensions(device)
            }
            // A new format resets zoom and can drop a held focus: put the user's back.
            self.applyZoom(zoom, smooth: false)
            self.applyHeldFocus(lens: lens, point: point)
        }
    }

    // MARK: Zoom and focus

    /// Zoom to `zoom` (0.5 = ultra-wide, 1 = main lens; nil: the automatic zoom for the current mode).
    func setZoom(_ zoom: CGFloat?, smooth: Bool = false) {
        sessionQueue.async { [weak self] in self?.applyZoom(zoom, smooth: smooth) }
    }

    /// The device's zoom factor for a Camera-app zoom, within what the camera can do.
    private func factor(_ zoom: CGFloat, _ device: AVCaptureDevice) -> CGFloat {
        let most = min(device.activeFormat.videoMaxZoomFactor, device.maxAvailableVideoZoomFactor, Self.maxZoom * zoomBase)
        return min(max(zoom * zoomBase, device.minAvailableVideoZoomFactor), most)
    }

    private func applyZoom(_ zoom: CGFloat?, smooth: Bool) {
        guard let device else { return }
        let f = factor(zoom ?? defaultZoom(device, subjectMM: pagePhotos ? 290 : 88), device)
        do {
            try device.lockForConfiguration()
            if smooth { device.ramp(toVideoZoomFactor: f, withRate: 8) } else { device.cancelVideoZoomRamp(); device.videoZoomFactor = f }
            device.unlockForConfiguration()
        } catch { return }
        onZoom?(f / zoomBase)
    }

    /// Tap to focus: focus and expose on that spot, then hold focus there.
    func focus(at point: CGPoint) {
        sessionQueue.async { [weak self] in self?.applyFocus(at: point) }
    }

    private func applyFocus(at point: CGPoint) {
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) {
                device.focusPointOfInterest = point
                device.focusMode = .autoFocus
            }
            if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposurePointOfInterest = point
                device.exposureMode = .continuousAutoExposure
            }
            device.unlockForConfiguration()
        } catch { return }
        // Report where the lens settled, so the focus slider starts there.
        sessionQueue.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let device = self?.device else { return }
            self?.onFocus?(device.lensPosition, true)
        }
    }

    /// Puts back a mode's held focus: the slider's lens position where this camera takes one,
    /// else the spot that was tapped, else automatic.
    func holdFocus(lens: Float?, point: CGPoint?) {
        sessionQueue.async { [weak self] in self?.applyHeldFocus(lens: lens, point: point) }
    }

    private func applyHeldFocus(lens: Float?, point: CGPoint?) {
        if let lens, device?.isLockingFocusWithCustomLensPositionSupported == true {
            applyLens(lens)
        } else if let point {
            applyFocus(at: point)
        } else {
            applyAutoFocus()
        }
    }

    /// Manual focus: 0 is closest, 1 is furthest. Held until set back to automatic.
    func setLens(_ position: Float) {
        sessionQueue.async { [weak self] in self?.applyLens(position) }
    }

    private func applyLens(_ position: Float) {
        guard let device, device.isLockingFocusWithCustomLensPositionSupported else { return }
        let p = min(max(position, 0), 1)
        do {
            try device.lockForConfiguration()
            device.setFocusModeLocked(lensPosition: p, completionHandler: nil)
            device.unlockForConfiguration()
        } catch { return }
        onFocus?(p, true)
    }

    /// Back to continuous autofocus and exposure, centred.
    func autoFocus() {
        sessionQueue.async { [weak self] in self?.applyAutoFocus() }
    }

    private func applyAutoFocus() {
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            let center = CGPoint(x: 0.5, y: 0.5)
            if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = center }
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = center }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            device.unlockForConfiguration()
        } catch { return }
        onFocus?(device.lensPosition, false)
    }

    /// The zoom a mode starts at. The multi-lens camera starts at 1× and handles close-ups itself.
    private func defaultZoom(_ device: AVCaptureDevice, subjectMM: Float) -> CGFloat {
        zoomBase > 1 ? 1 : recommendedZoom(for: device, subjectMM: subjectMM)
    }

    /// Main lens only: a long minimum focus distance can't focus on a card held
    /// close. Zoom in a little so the subject fills the frame from further away,
    /// the approach Apple recommends for scanning small objects.
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
