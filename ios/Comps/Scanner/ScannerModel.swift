import SwiftUI
import SwiftData
import AudioToolbox

/// One scanned card waiting in the tray.
@Observable
final class ScanItem: Identifiable {
    enum Status { case matching, matched, review, failed }

    let id = UUID()
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

    @ObservationIgnored var lines: [OCRLine] = []
    @ObservationIgnored var scan: CGImage?
    @ObservationIgnored var attempts = 0
    @ObservationIgnored var memoryKey: String?
    @ObservationIgnored var retakeToken: UUID?

    init(photo: UIImage, condition: String) {
        self.photo = photo
        self.condition = condition
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
    var lockedSet: SetOption?
    private(set) var layout: BinderLayout = BinderLayout(rawValue: UserDefaults.standard.string(forKey: "scan.binderLayout") ?? "") ?? .nine

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
    }

    func setMode(_ m: Mode) {
        let wasBinder = mode == .binder
        mode = m
        engine.continuous = m == .continuous
        engine.binder = m == .binder
        engine.reset()
        quad = nil
        pageQuads = []
        if (m == .binder) != wasBinder { camera.setPageMode(m == .binder) }
        if m == .continuous, singleResult == nil { setPaused(false) }
        if m == .binder { setPaused(false) }
        phase = .searching
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
        guard await CameraController.requestAccess() else { phase = .denied; return }
        light.prepare()
        notify.prepare()
        camera.start()
        Task { await Catalog.shared.ensureLoaded() }
        phase = .searching
    }

    func stop() {
        setTorch(false)
        camera.stop()
    }

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
                // Second look: pool both reads and decide again.
                if let item = items.first(where: { $0.id == id }) ?? (pendingSingle?.id == id ? pendingSingle : nil) {
                    item.lines += card.lines
                    Task { await resolve(item) }
                }
                return
            }
            flash += 1
            if sound { AudioServicesPlaySystemSound(1104) }
            let item = ScanItem(photo: card.image, condition: defaultCondition)
            item.lines = card.lines
            item.scan = card.cgImage
            lastCaptured = item.id
            if mode == .continuous {
                withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) { items.insert(item, at: 0) }
            } else {
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
        if haptics { item.status == .failed ? notify.notificationOccurred(.warning) : notify.notificationOccurred(.success) }
        if mode == .single, pendingSingle === item {
            pendingSingle = nil
            singleResult = item
        }
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
            let cells: [BinderCell] = await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    continuation.resume(returning: BinderReader.read(photo, layout: layout, guide: guide))
                }
            }
            let condition = defaultCondition
            var pockets: [BinderPage.Pocket] = []
            for cell in cells where !cell.isEmpty {
                guard let image = cell.image else { continue }
                let item = ScanItem(photo: UIImage(cgImage: image), condition: condition)
                item.lines = cell.lines
                item.scan = image
                item.pocket = layout.rows > 1 ? "Row \(cell.row + 1) · \(cell.column + 1)" : "\(cell.column + 1)"
                pockets.append(BinderPage.Pocket(quad: cell.quad, item: item))
            }
            withAnimation(.snappy) {
                page.pockets = pockets
                items.insert(contentsOf: pockets.map(\.item), at: 0)
            }
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

    // MARK: Tray

    func remove(_ item: ScanItem) {
        withAnimation(.snappy) { items.removeAll { $0.id == item.id } }
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
        for item in list {
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
        withAnimation(.snappy) { items.removeAll { item in list.contains { $0.id == item.id } } }
        return added
    }
}
