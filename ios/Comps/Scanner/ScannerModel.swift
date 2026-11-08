import SwiftUI
import SwiftData
import AudioToolbox

/// One scanned card waiting in the tray.
@Observable
final class ScanItem: Identifiable {
    enum Status: String { case matching, matched, review, failed }

    let id: UUID
    /// A small picture of the scan (the sharper one for the review screen is on disk).
    let photo: UIImage
    var status: Status = .matching
    var candidates: [ScanCandidate] = []
    var selected: Int = 0
    var variant: String?
    var grader: String?
    var grade: String?
    var condition: String
    var quantity = 1
    /// Binder pocket ("Row 2 · 3"), when it came from a page.
    var pocket: String?
    let scannedAt: Date

    @ObservationIgnored var lines: [OCRLine] = []
    @ObservationIgnored var scan: CGImage?
    @ObservationIgnored var attempts = 0
    @ObservationIgnored var memoryKey: String?
    @ObservationIgnored var retakeToken: UUID?
    /// Single scans keep their review photo in memory; tray scans keep it on disk.
    @ObservationIgnored var jpeg: Data?

    init(id: UUID = UUID(), photo: UIImage, condition: String, scannedAt: Date = Date()) {
        self.id = id
        self.photo = photo
        self.condition = condition
        self.scannedAt = scannedAt
    }

    /// A card brought back from the saved tray.
    convenience init(restoring e: ScanJournal.Entry, photo: UIImage?) {
        self.init(id: e.id, photo: photo ?? UIImage(), condition: e.condition, scannedAt: e.scannedAt)
        candidates = e.candidates
        selected = e.candidates.indices.contains(e.selected) ? e.selected : 0
        variant = e.variant
        grader = e.grader
        grade = e.grade
        quantity = max(1, e.quantity)
        pocket = e.pocket
        memoryKey = e.memoryKey
        // One still being matched when the app closed can't be read again: check it by hand.
        let saved = Status(rawValue: e.status) ?? .review
        status = saved == .matching ? (e.candidates.isEmpty ? .failed : .review) : saved
    }

    /// The sharper copy of the scan for the review screen.
    func largePhoto() async -> UIImage? {
        if let jpeg { return UIImage(data: jpeg) }
        return await ScanJournal.photo(id)
    }

    var choice: ScanCandidate? { candidates.indices.contains(selected) ? candidates[selected] : nil }

    var unitValue: Double? {
        guard let c = choice else { return nil }
        let v = c.variants.first { $0.variant == variant } ?? c.variants.first
        if grader != nil, let g = v?.grades?.value(grader: grader, grade: grade) ?? c.card.grades?.value(grader: grader, grade: grade) { return g }
        let raw = v?.price ?? c.card.price
        return raw.map { $0 * (grader == nil ? (CardCondition(rawValue: condition)?.factor ?? 1) : 1) }
    }

    /// Pick a candidate by hand. Remembered, so the same read resolves this way next time.
    func choose(_ index: Int) {
        guard candidates.indices.contains(index) else { return }
        let c = candidates[index]
        selected = index
        variant = c.card.variant ?? c.variants.first?.variant
        status = .matched
        if let memoryKey { ScanMemory.remember(memoryKey, cardID: c.id) }
    }
}

/// A binder page being read: the photo, and each pocket's card.
@Observable
final class BinderPage: Identifiable {
    struct Pocket: Identifiable {
        let id = UUID()
        var quad: Quad
        var item: ScanItem
    }

    let id = UUID()
    let photo: UIImage
    var pockets: [Pocket] = []
    var reading = true

    init(photo: UIImage) { self.photo = photo }

    var items: [ScanItem] { pockets.map(\.item) }
    var total: Double { items.reduce(0) { $0 + ($1.unitValue ?? 0) * Double($1.quantity) } }
}

@MainActor
@Observable
final class ScannerModel {
    enum Mode: String, CaseIterable { case continuous = "Continuous", single = "Single", binder = "Binder" }
    enum Phase: Equatable { case starting, denied, searching, steady, reading, matched(String), noMatch }

    private(set) var mode: Mode = .continuous
    var phase: Phase = .starting
    var quad: Quad?
    var pageQuads: [Quad] = []
    var frameSize: CGSize = CGSize(width: 1080, height: 1920)
    var items: [ScanItem] = []
    private(set) var torch = false
    private(set) var paused = false
    var singleResult: ScanItem?
    var page: BinderPage?
    var flash = 0
    /// A short message for the scanner to show ("Skipped a repeat…").
    private(set) var notice: (text: String, id: UUID)?
    var lockedSet: SetOption?
    private(set) var layout: BinderLayout = BinderLayout(rawValue: UserDefaults.standard.string(forKey: "scan.binderLayout") ?? "") ?? .nine

    // Camera controls. Zoom and a held focus are remembered for each mode, so a stand stays set up.
    private(set) var zoom: CGFloat = 1
    /// The widest zoom: 0.5 on phones with an ultra-wide lens.
    private(set) var minZoom: CGFloat = 1
    /// Whether this camera takes a focus set by hand (the slider); otherwise a tapped spot is held.
    private(set) var manualFocus = true
    private(set) var focusLocked = false
    private(set) var lensPosition: Float = 0.5
    /// Where the last tap-to-focus landed (view coordinates), for the focus mark.
    private(set) var focusMark: (point: CGPoint, id: UUID)?
    /// True for the moment the camera switches between card and page set-ups.
    private(set) var switching = false
    @ObservationIgnored private var pageModeTask: Task<Void, Never>?
    @ObservationIgnored private var pinchStart: CGFloat = 1
    // Crash protection: the tray is saved to disk as it changes (see ScanJournal).
    @ObservationIgnored private var trayLoaded = false
    @ObservationIgnored private var loadingTray = false
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    /// Set while the review list is open: scanning pauses so the list holds still.
    @ObservationIgnored private var pausedBeforeReview: Bool?

    func setLayout(_ l: BinderLayout) {
        layout = l
        UserDefaults.standard.set(l.rawValue, forKey: "scan.binderLayout")
    }

    let camera = CameraController()
    private let engine = ScanEngine()
    private var lastCaptured: UUID?
    private var defaultCondition: String { UserDefaults.standard.string(forKey: Pref.scanCondition) ?? "NM" }
    private var haptics: Bool { UserDefaults.standard.object(forKey: Pref.haptics) as? Bool ?? true }
    private var sound: Bool { UserDefaults.standard.bool(forKey: Pref.scanSound) }
    private var autoAccept: Double { UserDefaults.standard.object(forKey: Pref.autoAccept) as? Double ?? 0.8 }
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let notify = UINotificationFeedbackGenerator()

    var total: Double { items.reduce(0) { sum, item in sum + (item.unitValue ?? 0) * Double(item.quantity) } }
    var readyCount: Int { items.filter { $0.status == .matched || $0.status == .review }.count }
    var readingPage: Bool { page?.reading == true }

    init() {
        engine.continuous = true
        let engine = self.engine
        camera.onFrame = { buffer in engine.process(buffer) }
        engine.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        camera.onZoom = { [weak self] z in Task { @MainActor in self?.zoom = z } }
        camera.onLenses = { [weak self] widest, manual in
            Task { @MainActor in
                self?.minZoom = widest
                self?.manualFocus = manual
            }
        }
        camera.onFocus = { [weak self] lens, locked in
            Task { @MainActor in
                self?.lensPosition = lens
                self?.focusLocked = locked
            }
        }
        camera.onReconfigured = { [weak self] in
            Task { @MainActor in withAnimation(.easeOut(duration: 0.25)) { self?.switching = false } }
        }
    }

    func setMode(_ m: Mode) {
        guard m != mode else { return }
        let pageChange = (m == .binder) != (mode == .binder)
        mode = m
        engine.continuous = m == .continuous
        engine.binder = m == .binder
        engine.reset()
        quad = nil
        pageQuads = []
        if m == .continuous, singleResult == nil { setPaused(false) }
        if m == .binder { setPaused(false) }
        phase = .searching
        if pageChange {
            // Switching the camera between card and page set-ups takes a moment. Wait until the
            // choice settles (tapping through modes switches once), and soften the change.
            switching = true
            pageModeTask?.cancel()
            pageModeTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(220))
                guard let self, !Task.isCancelled else { return }
                camera.setPageMode(mode == .binder, zoom: savedZoom(mode), lens: savedLens(mode), point: savedPoint(mode))
            }
        } else {
            camera.setZoom(savedZoom(m), smooth: true)
            if savedLens(m) != nil || savedPoint(m) != nil || focusLocked { camera.holdFocus(lens: savedLens(m), point: savedPoint(m)) }
        }
    }

    // MARK: Zoom and focus

    private func zoomKey(_ m: Mode) -> String { "scan.zoom.\(m.rawValue)" }
    private func lensKey(_ m: Mode) -> String { "scan.lens.\(m.rawValue)" }
    private func pointKey(_ m: Mode) -> String { "scan.focusPoint.\(m.rawValue)" }
    private func savedZoom(_ m: Mode) -> CGFloat? {
        let z = UserDefaults.standard.double(forKey: zoomKey(m))
        return z > 0 ? CGFloat(z) : nil
    }
    /// The spot last tapped to focus, held for next time (a stand keeps the card in the same place).
    private func savedPoint(_ m: Mode) -> CGPoint? {
        guard let xy = UserDefaults.standard.array(forKey: pointKey(m)) as? [Double], xy.count == 2 else { return nil }
        return CGPoint(x: xy[0], y: xy[1])
    }
    private func savedLens(_ m: Mode) -> Float? {
        (UserDefaults.standard.object(forKey: lensKey(m)) as? Double).map(Float.init)
    }

    /// Zoom to a level (the quick buttons), remembered for this mode.
    func setZoom(_ z: CGFloat, smooth: Bool = true) {
        let z = min(max(z, minZoom), CameraController.maxZoom)
        zoom = z
        camera.setZoom(z, smooth: smooth)
        UserDefaults.standard.set(Double(z), forKey: zoomKey(mode))
    }

    func pinch(_ p: CameraPreview.Pinch) {
        switch p {
        case .began: pinchStart = zoom
        case .changed(let scale):
            let z = min(max(pinchStart * scale, minZoom), CameraController.maxZoom)
            zoom = z
            camera.setZoom(z)
        case .ended: setZoom(zoom, smooth: false)
        }
    }

    /// Tap to focus there; the slider can then fine-tune it.
    func tapFocus(device: CGPoint, view: CGPoint) {
        camera.focus(at: device)
        focusLocked = true
        focusMark = (view, UUID())
        // A tapped spot replaces a slider setting, and is remembered for this mode.
        UserDefaults.standard.set([Double(device.x), Double(device.y)], forKey: pointKey(mode))
        UserDefaults.standard.removeObject(forKey: lensKey(mode))
        if haptics { light.impactOccurred(intensity: 0.5) }
    }

    /// Manual focus from the slider, remembered for this mode (handy on a stand).
    func setLens(_ p: Float) {
        lensPosition = p
        focusLocked = true
        camera.setLens(p)
        UserDefaults.standard.set(Double(p), forKey: lensKey(mode))
    }

    func autoFocus() {
        focusLocked = false
        camera.autoFocus()
        UserDefaults.standard.removeObject(forKey: lensKey(mode))
        UserDefaults.standard.removeObject(forKey: pointKey(mode))
    }

    func setTorch(_ on: Bool) {
        torch = on
        camera.setTorch(on)
    }

    func setPaused(_ p: Bool) {
        paused = p
        engine.isPaused = p
    }

    func start() async {
        Task { await restoreTray() }
        guard await CameraController.requestAccess() else { phase = .denied; return }
        light.prepare()
        notify.prepare()
        camera.start()
        // The zoom and focus last used in this mode (a stand stays set up between sessions).
        camera.setZoom(savedZoom(mode))
        if savedLens(mode) != nil || savedPoint(mode) != nil { camera.holdFocus(lens: savedLens(mode), point: savedPoint(mode)) }
        Task { await Catalog.shared.ensureLoaded() }
        phase = .searching
    }

    func stop() {
        setTorch(false)
        camera.stop()
        saveTray()
    }

    // MARK: Crash protection

    /// Brings back the cards from an earlier session that weren't added yet (after a crash,
    /// or when the scanner was closed), before anything new is saved over them.
    private func restoreTray() async {
        guard !trayLoaded, !loadingTray else { return }
        loadingTray = true
        let saved = await ScanJournal.load()
        let here = Set(items.map(\.id))
        let back = saved.filter { !here.contains($0.0.id) }.map { ScanItem(restoring: $0.0, photo: $0.1) }
        if !back.isEmpty {
            items.append(contentsOf: back)
            notice = ("Picked up \(back.count) card\(back.count == 1 ? "" : "s") you scanned last time", UUID())
        }
        trayLoaded = true
        loadingTray = false
        watchTray()
        if !items.isEmpty { saveTray() }
    }

    /// Saves the tray shortly after anything in it changes: a card scanned, removed or added,
    /// a match fixed, the grade, condition or quantity changed.
    private func watchTray() {
        withObservationTracking {
            for item in items {
                _ = (item.status, item.selected, item.candidates.count, item.variant, item.grader, item.grade, item.condition, item.quantity)
            }
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.scheduleSave()
                self?.watchTray()
            }
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.saveTray()
        }
    }

    /// Saves the tray now. Never before the saved one has been read back, so it can't be wiped.
    func saveTray() {
        guard trayLoaded else { return }
        saveTask?.cancel()
        ScanJournal.save(items)
    }

    // MARK: Review

    func beginReview() {
        guard pausedBeforeReview == nil else { return }
        pausedBeforeReview = paused
        setPaused(true)
    }

    func endReview() {
        if let was = pausedBeforeReview { setPaused(was) }
        pausedBeforeReview = nil
        saveTray()
    }

    private var reviewing: Bool { pausedBeforeReview != nil }

    func shutter() {
        switch mode {
        case .single: engine.captureRequested = true
        case .binder: capturePage()
        case .continuous: setPaused(!paused)
        }
    }

    private func matchContext() -> MatchContext {
        var recent: [String: Int] = [:]
        for item in items.prefix(30) where item.status == .matched {
            if let set = item.choice?.card.setName { recent[set, default: 0] += 1 }
        }
        return MatchContext(lockedSet: lockedSet?.id, recentSets: recent)
    }

    private func handle(_ event: ScanEngine.Event) {
        switch event {
        case .quad(let q, let size):
            guard mode != .binder else { return }
            frameSize = size
            // Light smoothing so the outline glides instead of jittering.
            if let q, let cur = quad, q.distance(to: cur) < 0.1 { quad = cur.lerp(to: q, 0.6) } else { quad = q }
            if q == nil, phase == .steady || phase == .noMatch { phase = .searching }
        case .quads(let qs, let size):
            guard mode == .binder else { return }
            frameSize = size
            pageQuads = qs
        case .steady:
            if phase == .searching { phase = .steady }
        case .reading:
            phase = .reading
            if haptics { light.impactOccurred(intensity: 0.7) }
        case .captured(let card):
            if let id = card.retakeOf {
                // Second look: pool both reads and decide again (unless it was already settled).
                if let item = items.first(where: { $0.id == id }) ?? (pendingSingle?.id == id ? pendingSingle : nil),
                   item.status == .matching, item.scan != nil {
                    item.lines += card.lines
                    Task { await resolve(item) }
                }
                return
            }
            guard let photo = card.photo else { return }
            flash += 1
            if sound { AudioServicesPlaySystemSound(1104) }
            let item = ScanItem(photo: photo.thumb, condition: defaultCondition)
            item.lines = card.lines
            item.scan = card.cgImage
            lastCaptured = item.id
            if mode == .continuous {
                withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) { items.insert(item, at: 0) }
                ScanJournal.savePhoto(photo.jpeg, for: item.id)
            } else {
                item.jpeg = photo.jpeg
                setPaused(true)
                pendingSingle = item
            }
            Task { await resolve(item) }
        }
    }

    /// Single mode: the card being read, before its sheet opens.
    private var pendingSingle: ScanItem?

    private func isConfident(_ candidates: [ScanCandidate]) -> Bool {
        guard let top = candidates.first else { return false }
        return top.score >= autoAccept && (candidates.count < 2 || top.score - candidates[1].score >= 0.08)
    }

    private func resolve(_ item: ScanItem) async {
        let result = await CardResolver.resolve(lines: item.lines, image: item.scan, context: matchContext())
        item.memoryKey = result.features.memoryKey
        item.grader = result.features.grader
        item.grade = result.features.grade

        // Not sure yet and the card is probably still under the camera: take a second look before deciding.
        if !isConfident(result.candidates), item.attempts < 2, item.pocket == nil, item.id == lastCaptured {
            item.attempts += 1
            item.candidates = result.candidates
            let token = UUID()
            item.retakeToken = token
            engine.requestRetake(item.id, attempt: item.attempts)
            Task {
                try? await Task.sleep(for: .seconds(1.4))
                // The card was taken away before the second look: settle with what we have.
                if item.retakeToken == token, item.status == .matching { finish(item, result.candidates) }
            }
            return
        }
        finish(item, result.candidates)
    }

    private func finish(_ item: ScanItem, _ candidates: [ScanCandidate]) {
        item.retakeToken = nil
        // Matching is done: let go of the full-size scan (about 7 MB each).
        item.scan = nil
        withAnimation(.snappy) {
            item.candidates = candidates
            item.selected = 0
            if let top = candidates.first {
                item.variant = top.card.variant ?? top.variants.first?.variant
                item.status = isConfident(candidates) ? .matched : .review
                if item.pocket == nil { phase = .matched(top.card.name) }
            } else {
                item.status = .failed
                if item.pocket == nil { phase = .noMatch }
            }
        }
        guard item.pocket == nil else { return }
        if mode == .continuous, !reviewing, isRepeat(item) {
            // Scan protection: the same card read again right after itself is dropped.
            withAnimation(.snappy) { items.removeAll { $0.id == item.id } }
            notice = ("Skipped a repeat of \(item.choice?.card.name ?? "that card")", UUID())
            if haptics { notify.notificationOccurred(.warning) }
            return
        }
        if haptics { item.status == .failed ? notify.notificationOccurred(.warning) : notify.notificationOccurred(.success) }
        if mode == .single, pendingSingle === item {
            pendingSingle = nil
            singleResult = item
        }
    }

    /// The same card and printing as the scan just before it, within a few seconds.
    /// (A second copy on purpose: raise the quantity in Review.)
    private func isRepeat(_ item: ScanItem) -> Bool {
        guard let card = item.choice?.card.id,
              let i = items.firstIndex(where: { $0.id == item.id }), i + 1 < items.count else { return false }
        let previous = items[i + 1]
        return previous.choice?.card.id == card && previous.variant == item.variant
            && item.scannedAt.timeIntervalSince(previous.scannedAt) < 8
    }

    // MARK: Binder pages

    func capturePage() {
        guard mode == .binder, page?.reading != true else { return }
        let layout = self.layout
        let guide = layout.guide(frame: frameSize)
        phase = .reading
        if haptics { light.impactOccurred(intensity: 0.8) }
        Task {
            guard let photo = await camera.capturePhoto() else {
                phase = .noMatch
                return
            }
            flash += 1
            let page = BinderPage(photo: UIImage(cgImage: photo))
            self.page = page
            let cells: [(BinderCell, ScanPhoto?)] = await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    let read = BinderReader.read(photo, layout: layout, guide: guide)
                    continuation.resume(returning: read.map { cell in (cell, cell.isEmpty ? nil : cell.image.map(ScanPhoto.init)) })
                }
            }
            let condition = defaultCondition
            var pockets: [BinderPage.Pocket] = []
            var jpegs: [(UUID, Data?)] = []
            for (cell, shot) in cells where !cell.isEmpty {
                guard let image = cell.image, let shot else { continue }
                let item = ScanItem(photo: shot.thumb, condition: condition)
                item.lines = cell.lines
                item.scan = image
                item.pocket = layout.rows > 1 ? "Row \(cell.row + 1) · \(cell.column + 1)" : "\(cell.column + 1)"
                pockets.append(BinderPage.Pocket(quad: cell.quad, item: item))
                jpegs.append((item.id, shot.jpeg))
            }
            withAnimation(.snappy) {
                page.pockets = pockets
                items.insert(contentsOf: pockets.map(\.item), at: 0)
            }
            for (id, jpeg) in jpegs { ScanJournal.savePhoto(jpeg, for: id) }
            // A few at a time: each match may fetch card images for the visual check.
            await withTaskGroup(of: Void.self) { group in
                var next = 0
                while next < min(3, pockets.count) {
                    let item = pockets[next].item
                    group.addTask { await self.resolve(item) }
                    next += 1
                }
                while await group.next() != nil {
                    guard next < pockets.count else { continue }
                    let item = pockets[next].item
                    group.addTask { await self.resolve(item) }
                    next += 1
                }
            }
            page.reading = false
            phase = pockets.isEmpty ? .noMatch : .searching
            if haptics { pockets.isEmpty ? notify.notificationOccurred(.warning) : notify.notificationOccurred(.success) }
        }
    }

    func closePage() {
        page = nil
        phase = .searching
    }

    /// Takes a card off a page before adding it (scanned by mistake, or a sleeve you don't want).
    /// From a swipe, the list animates the row away itself, so `animated` is false there
    /// (animating it twice can crash the list).
    func removePocket(_ pocket: BinderPage.Pocket, from page: BinderPage, animated: Bool = false) {
        let change = {
            page.pockets.removeAll { $0.id == pocket.id }
            self.items.removeAll { $0.id == pocket.item.id }
        }
        if animated { withAnimation(.snappy, change) } else { change() }
        if haptics { light.impactOccurred(intensity: 0.6) }
    }

    // MARK: Tray

    /// Same as removePocket: false when the list's own swipe already animates it.
    func remove(_ item: ScanItem, animated: Bool = false) {
        if animated {
            withAnimation(.snappy) { items.removeAll { $0.id == item.id } }
        } else {
            items.removeAll { $0.id == item.id }
        }
        if haptics { light.impactOccurred(intensity: 0.6) }
    }

    /// Clears the tray (after a confirmation in the review list).
    func removeAll() {
        items.removeAll()
        saveTray()
    }

    func resumeSingle() {
        singleResult = nil
        pendingSingle = nil
        engine.reset()
        setPaused(false)
        phase = .searching
    }

    /// Adds scanned cards to the collection, merging repeats into quantities.
    @discardableResult
    func commit(_ list: [ScanItem], context: ModelContext) -> Int {
        var added = 0
        var merged: [String: Holding] = [:]
        // In the order they were scanned, so History lists them like the stack they came from.
        for item in list.sorted(by: { $0.scannedAt < $1.scannedAt }) {
            guard let c = item.choice else { continue }
            let key = [c.card.id, item.variant ?? "", item.grader ?? "", item.grade ?? "", item.condition].joined(separator: "|")
            if let existing = merged[key] {
                existing.quantity += item.quantity
                added += item.quantity
                continue
            }
            let h = Holding(cardID: c.card.id, game: c.card.game, name: c.card.name, setName: c.card.setName, number: c.card.number,
                            imageURL: ImageURL.original(c.card.image), variant: item.variant, grader: item.grader, grade: item.grade,
                            condition: item.condition, quantity: item.quantity, unitValue: item.unitValue)
            h.rawPrice = (c.variants.first { $0.variant == item.variant } ?? c.variants.first)?.price ?? c.card.price
            h.priceBasis = item.grader == nil ? "raw" : nil
            context.insert(h)
            merged[key] = h
            added += item.quantity
        }
        try? context.save()
        Portfolio.snapshot(context: context)
        CollectionSync.shared.syncSoon(context)
        let done = Set(list.map(\.id))
        withAnimation(.snappy) { items.removeAll { done.contains($0.id) } }
        // Straight away, so a crash now can't bring back cards that were just added.
        saveTray()
        return added
    }
}
